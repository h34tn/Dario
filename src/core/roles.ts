import path from 'node:path';
import { editYamlFile } from './yaml-edit.js';
import { modelSettingsSchema, writeModelSettings, type ModelSettings, type ModelUpdate, type ProjectConfig, type RoleDef, type UserConfig } from './config.js';
import { findModel, type AgentCatalog, type AgentPort, type ModelList } from './ports.js';
import type { StateStore } from './state.js';
import type { Attempt } from './types.js';
import { ConfigError, normPath } from './util.js';

export type CandidateState = 'ok' | 'unknown' | 'disabled' | 'not_installed' | 'unavailable';

export type ModelTarget = 'local' | 'project' | 'default';
type ModelSource = ModelTarget | 'tool';

export interface EffectiveModel extends ModelSettings {
  modelSource: ModelSource;
  effortSource: ModelSource;
}

export interface CandidateView extends EffectiveModel {
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
    private readonly user: UserConfig,
  ) {}

  get fallback(): 'auto' | 'manual' | 'ask' {
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

  get leadRole(): string {
    return this.project.settings.leadRole;
  }

  label(id: string, context?: 'plan'): string {
    const role = this.project.roles.roles[id];
    const label = role?.alias[0] ? `${role.alias[0]}（${id}）` : id;
    return context === 'plan' && id === this.leadRole ? `${label}自己做` : label;
  }

  private sequence(role: RoleDef): { list: string[]; override?: string } {
    const override = this.state.getOverrides(this.project.root)[role.id];
    const list = [...new Set([...(override ? [override] : []), ...role.candidates])];
    return { list, override };
  }

  modelFor(roleId: string, agentId: string): EffectiveModel {
    const port = this.catalog.get(agentId);
    const layers: [ModelTarget, ModelSettings | undefined][] = [
      ['local', port?.roles?.[roleId]],
      ['project', this.get(roleId).models?.[agentId]],
      ['default', port],
    ];
    const result: EffectiveModel = { modelSource: 'tool', effortSource: 'tool' };
    for (const [source, settings] of layers) {
      if (!result.model && settings?.model) {
        result.model = settings.model;
        result.modelSource = source;
      }
      if (!result.effort && port?.efforts?.length && settings?.effort) {
        result.effort = settings.effort;
        result.effortSource = source;
      }
    }
    return result;
  }

  efforts(agentId: string): string[] {
    return this.catalog.get(agentId)?.efforts ?? [];
  }

  modelLabel = (agent: string, model: string): string => this.state.modelLabel(agent, model);

  async listModels(agentId: string) {
    const port = this.catalog.get(agentId);
    if (!port) throw new ConfigError(`本机没有配置这个 AI：${agentId}`);
    const list = await port.listModels();
    if (!list.error) this.state.saveModels(agentId, list.models);
    return list;
  }

  private async inspect(agent: string): Promise<Pick<CandidateView, 'agent' | 'state' | 'note'>> {
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
  ): Promise<{ usable: string[]; skipped: Attempt[]; sequence: string[]; marked: string[] }> {
    const role = this.get(roleId);
    const { list } = this.sequence(role);
    const usable: string[] = [];
    const skipped: Attempt[] = [];
    // 被跳过的候选里，因为"暂时不可用"（限额、登录失效、过载等）而跳过的那些；没配置、已停用、没安装的不算
    const marked: string[] = [];
    for (const agent of list) {
      const view = await this.inspect(agent);
      if (view.state === 'ok') usable.push(agent);
      else {
        skipped.push({ agent, outcome: 'skipped', reason: view.note });
        if (view.state === 'unavailable') marked.push(agent);
      }
    }
    if (opts.prefer && usable.includes(opts.prefer)) {
      usable.splice(usable.indexOf(opts.prefer), 1);
      usable.unshift(opts.prefer);
    }
    if (opts.avoid && usable.length > 1 && usable.includes(opts.avoid)) {
      usable.splice(usable.indexOf(opts.avoid), 1);
      usable.push(opts.avoid);
    }
    return { usable, skipped, sequence: list, marked };
  }

  async view(): Promise<RoleView[]> {
    const views: RoleView[] = [];
    for (const role of Object.values(this.project.roles.roles)) {
      const { list, override } = this.sequence(role);
      const candidates: CandidateView[] = [];
      for (const agent of list) candidates.push({ ...await this.inspect(agent), ...this.modelFor(role.id, agent) });
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
    const file = this.projectFile();
    const current = this.get(roleId).candidates;
    const next = [agent, ...current.filter((c) => c !== agent)];
    editYamlFile(file, [{ keys: ['roles', roleId, 'candidates'], value: next }]);
    this.project.roles.roles[roleId]!.candidates = next;
    return file;
  }

  private projectFile(): string {
    const file = this.project.rolesFile;
    if (!file || !this.project.hasProjectDir || path.resolve(file) !== path.join(this.project.root, '.dario', 'roles.yaml') ||
        !normPath(file).startsWith(`${normPath(this.project.root)}/`)) {
      throw new ConfigError('当前项目没有自己的角色表，无法写回。先在项目里运行 `dario init`。');
    }
    return file;
  }

  async saveModel(roleId: string, agent: string, update: ModelUpdate | undefined, target: ModelTarget): Promise<{ file: string; notice: string }> {
    const role = this.get(roleId);
    const port = this.catalog.get(agent)!;
    const project = target === 'project';
    const file = project ? this.projectFile() : path.join(this.user.home, 'agents.yaml');
    const keys = project ? ['roles', roleId, 'models', agent] : ['agents', agent];
    if (target === 'local') keys.push('roles', roleId);
    let notice = '';
    const clearEffort = update?.effort === null && target === 'local';
    let settings: ModelSettings | undefined;
    if (update) {
      const targetModel = update.model ?? (target === 'local' ? port.roles?.[roleId]?.model : undefined)
        ?? (target !== 'default' ? role.models?.[agent]?.model : undefined) ?? port.model;
      const list = await this.listModels(agent);
      const choices = effortChoices(port, list, targetModel);
      const parsed = modelSettingsSchema.safeParse(clearEffort ? { ...update, effort: undefined } : update);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(i => `${[...keys, ...i.path].join('.')}：${i.message}`);
        if (parsed.error.issues.some(i => i.path[0] === 'effort')) {
          errors.push(`可选档位：${choices.join('、') || '无'}`);
        }
        throw new ConfigError(`${file}：${errors.join('；')}`);
      }
      // 显式传入 undefined 与未提供该字段的含义相同。
      settings = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
      if (!settings.model && !settings.effort && !clearEffort) throw new ConfigError('请给出型号或强度。');
      const { model } = settings;
      if (model && list.error) throw new ConfigError(`没能取到型号清单：${list.error}。无法核对型号。`);
      if (list.error) notice = '没能取到型号清单，已按工具档位校验强度。';
      if (model && !findModel(list.models, model)) {
        const names = list.models.slice(0, 10).map(m => `${m.label || m.id}（${m.id}）`).join('、') || '无';
        const total = list.models.length > 10 ? `（共 ${list.models.length} 个）` : '';
        throw new ConfigError(`${agent} 返回的型号清单里没有 ${model}。可选型号：${names}${total}`);
      }
      if (settings.effort && !choices.includes(settings.effort)) {
        throw new ConfigError(effortProblem(roleId, agent, settings.effort, choices));
      }
    }
    writeModelSettings(file, keys, clearEffort ? { ...settings, effort: null } : settings);
    if (project) {
      const entries = role.models ??= {};
      entries[agent] = { ...entries[agent], ...settings };
    } else {
      const entries = this.user.agents;
      if (!Object.hasOwn(entries, agent)) entries[agent] = {};
      const entry = entries[agent]!;
      if (target === 'default') Object.assign(entry, settings);
      else if (settings) {
        const roles = entry.roles ??= {};
        roles[roleId] = { ...roles[roleId], ...settings };
        if (clearEffort) delete roles[roleId]!.effort;
      } else if (entry.roles) {
        delete entry.roles[roleId];
        if (!Object.keys(entry.roles).length) delete entry.roles;
      }
    }
    return { file, notice };
  }

  async modelProblems(): Promise<string[]> {
    const problems = new Set<string>();
    for (const port of this.catalog.list()) {
      const entries: { role: string; settings: ModelSettings; model?: string }[] = [
        { role: '默认', settings: port },
      ];
      for (const [role, settings] of Object.entries(port.roles ?? {})) {
        entries.push({ role, settings, model: this.project.roles.roles[role]?.models?.[port.id]?.model ?? port.model });
      }
      for (const role of Object.values(this.project.roles.roles)) {
        const settings = role.models?.[port.id];
        if (settings) entries.push({ role: role.id, settings, model: port.model });
        if (settings || port.roles?.[role.id]) {
          const { model, effort } = this.modelFor(role.id, port.id);
          entries.push({ role: role.id, settings: { effort }, model });
        }
      }
      if (!entries.some(({ settings }) => settings.model || settings.effort)) continue;
      const list = await this.listModels(port.id);
      for (const { role, settings, model } of entries) {
        if (!list.error && settings.model && !findModel(list.models, settings.model)) {
          problems.add(`角色 ${role}：${missingModel(port.id, settings.model)}`);
        }
        const choices = effortChoices(port, list, settings.model ?? model);
        if (settings.effort && !choices.includes(settings.effort)) {
          problems.add(effortProblem(role, port.id, settings.effort, choices));
        }
      }
    }
    return [...problems];
  }
}

function effortChoices(port: AgentPort, list: ModelList, model?: string): string[] {
  if (!port.efforts?.length) return [];
  if (list.error) return port.efforts;
  return findModel(list.models, model)?.efforts ?? port.efforts;
}

function missingModel(agent: string, model: string): string {
  return `注意：${agent} 返回的型号清单里没有 ${model}。`;
}

function effortProblem(role: string, agent: string, effort: string, choices: string[]): string {
  return `角色 ${role} 的 AI ${agent} 不支持强度 ${effort}，可选档位：${choices.join('、') || '无'}`;
}
