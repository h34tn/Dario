import fs from 'node:fs';
import { parseDocument } from 'yaml';
import type { ProjectConfig, RoleDef } from './config.js';
import type { AgentCatalog } from './ports.js';
import type { StateStore } from './state.js';
import type { Attempt } from './types.js';
import { ConfigError, normPath, writeFileAtomic } from './util.js';

export type CandidateState = 'ok' | 'unknown' | 'disabled' | 'not_installed' | 'unavailable';

export interface CandidateView {
  agent: string;
  state: CandidateState;
  note?: string;
}

export interface RoleView {
  id: string;
  alias: string[];
  description?: string;
  access: RoleDef['access'];
  /** 此刻实际担当该角色的 AI；全部不可用时为空。 */
  holder?: string;
  /** 用 `dario role` 临时指定的 AI。 */
  override?: string;
  candidates: CandidateView[];
  mustDifferFrom?: string;
}

/** 角色表：解析角色名、确定担当者与换人顺序。 */
export class RoleBook {
  constructor(
    private readonly project: ProjectConfig,
    private readonly catalog: AgentCatalog,
    private readonly state: StateStore,
  ) {}

  get fallback(): 'auto' | 'manual' {
    return this.project.roles.fallback;
  }

  ids(): string[] {
    return Object.keys(this.project.roles.roles);
  }

  /** 按角色 id 或别名查找，不区分大小写。 */
  resolve(name: string): string | undefined {
    const key = name.trim().toLowerCase();
    for (const role of Object.values(this.project.roles.roles)) {
      if (role.id.toLowerCase() === key || role.alias.some((a) => a.toLowerCase() === key)) return role.id;
    }
    return undefined;
  }

  get(id: string): RoleDef {
    const role = this.project.roles.roles[id];
    if (!role) throw new ConfigError(`没有这个角色：${id}。可用角色：${this.ids().join('、')}`);
    return role;
  }

  has(id: string): boolean {
    return id in this.project.roles.roles;
  }

  label(id: string): string {
    const role = this.project.roles.roles[id];
    return role?.alias[0] ? `${role.alias[0]}（${id}）` : id;
  }

  private sequence(role: RoleDef): { list: string[]; override?: string } {
    const override = this.state.getOverrides(this.project.root)[role.id];
    const list = [...new Set([...(override ? [override] : []), ...role.candidates])];
    return { list, override };
  }

  private async inspect(agent: string): Promise<CandidateView> {
    const port = this.catalog.get(agent);
    if (!port) return { agent, state: 'unknown', note: '本机没有配置这个 AI' };
    if (!port.enabled) return { agent, state: 'disabled', note: '已在本机配置里停用' };
    const detect = await port.detect();
    if (!detect.installed) return { agent, state: 'not_installed', note: '未安装或找不到命令' };
    const mark = this.state.getHealthMark(agent);
    if (mark) return { agent, state: 'unavailable', note: `暂时不可用：${mark.reason}` };
    return { agent, state: 'ok', note: detect.version };
  }

  /**
   * 某个角色此刻的尝试顺序。
   * prefer：优先使用的 AI（返工时沿用原执行者）；avoid：尽量避开的 AI（must_differ_from）。
   */
  async order(
    roleId: string,
    opts: { prefer?: string; avoid?: string } = {},
  ): Promise<{ usable: string[]; skipped: Attempt[]; sequence: string[] }> {
    const role = this.get(roleId);
    const { list } = this.sequence(role);
    const usable: string[] = [];
    const skipped: Attempt[] = [];
    for (const agent of list) {
      const view = await this.inspect(agent);
      if (view.state === 'ok') usable.push(agent);
      else skipped.push({ agent, outcome: 'skipped', reason: view.note });
    }
    if (opts.prefer && usable.includes(opts.prefer)) {
      usable.splice(usable.indexOf(opts.prefer), 1);
      usable.unshift(opts.prefer);
    }
    if (opts.avoid && usable.length > 1 && usable.includes(opts.avoid)) {
      usable.splice(usable.indexOf(opts.avoid), 1);
      usable.push(opts.avoid);
    }
    return { usable, skipped, sequence: list };
  }

  async view(): Promise<RoleView[]> {
    const views: RoleView[] = [];
    for (const role of Object.values(this.project.roles.roles)) {
      const { list, override } = this.sequence(role);
      const candidates: CandidateView[] = [];
      for (const agent of list) candidates.push(await this.inspect(agent));
      views.push({
        id: role.id,
        alias: role.alias,
        description: role.description,
        access: role.access,
        holder: candidates.find((c) => c.state === 'ok')?.agent,
        override,
        candidates,
        mustDifferFrom: role.mustDifferFrom,
      });
    }
    return views;
  }

  /** 临时指定担当者：只记在本机，不改项目文件。 */
  setOverride(roleId: string, agent: string): void {
    this.get(roleId);
    if (!this.catalog.get(agent)) {
      throw new ConfigError(`本机没有配置这个 AI：${agent}。可用的 AI：${this.catalog.list().map((a) => a.id).join('、')}`);
    }
    this.state.setOverride(this.project.root, roleId, agent);
  }

  clearOverride(roleId: string): void {
    this.get(roleId);
    this.state.setOverride(this.project.root, roleId, undefined);
  }

  /** 把某个 AI 写回项目角色表的候选首位，保留文件里的注释。 */
  saveAsDefault(roleId: string, agent: string): string {
    this.get(roleId);
    const file = this.project.rolesFile;
    if (!file || !this.project.hasProjectDir || !normPath(file).startsWith(`${normPath(this.project.root)}/`)) {
      throw new ConfigError('当前项目没有自己的角色表，无法写回。先在项目里运行 `dario init`。');
    }
    const doc = parseDocument(fs.readFileSync(file, 'utf8'));
    const current = this.get(roleId).candidates;
    const next = [agent, ...current.filter((c) => c !== agent)];
    doc.setIn(['roles', roleId, 'candidates'], doc.createNode(next, { flow: true }));
    writeFileAtomic(file, doc.toString());
    this.project.roles.roles[roleId]!.candidates = next;
    return file;
  }
}
