import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Access } from '../plugin.js';
import { DEFAULT_DISPATCH_RULES, DEFAULT_PROJECT_YAML, DEFAULT_ROLES_YAML } from './defaults.js';
import { ConfigError, normPath, readText } from './util.js';

// ---------- 类型 ----------

export interface RoleDef {
  id: string;
  alias: string[];
  description?: string;
  candidates: string[];
  access: Access;
  mustDifferFrom?: string;
  timeoutMinutes?: number;
}

export interface RolesConfig {
  roles: Record<string, RoleDef>;
  fallback: 'auto' | 'manual' | 'ask';
}

export interface ProjectSettings {
  leadRole: string;
  reviewRole: string;
  writeRoots: string[];
  maxReworkRounds: number;
  defaultTimeoutMinutes: number;
  maxPlanSteps: number;
  preamble: string;
  /** 开工前与远端同步的方式。 */
  syncBeforeTask: SyncMode;
}

export interface ProjectConfig {
  /** 项目根目录。没有 .dario/ 时就是当前目录。 */
  root: string;
  /** 项目是否带有自己的 .dario/ 配置。 */
  hasProjectDir: boolean;
  roles: RolesConfig;
  settings: ProjectSettings;
  dispatchRules: string;
  /** 角色表实际来自哪个文件；内置默认值时为 undefined。 */
  rolesFile?: string;
}

export interface AgentInstanceConfig {
  plugin?: string;
  command?: string;
  model?: string;
  allowedTools?: { readOnly?: string[]; write?: string[] };
  envPass?: string[];
  timeoutMinutes?: number;
  enabled?: boolean;
  /** 这一家可写方式的权限，不写则用本机的总设置。 */
  permissions?: WritePermissions;
  options?: Record<string, unknown>;
}

/** 可写角色的权限：full 全部放行，不逐项审批；listed 只放行清单里的工具。 */
export type WritePermissions = 'full' | 'listed';

/** 开工前与远端同步的方式，见 workspace.ts。 */
export type SyncMode = 'off' | 'pull' | 'pull-autostash';

export interface FeishuChannelConfig {
  enabled: boolean;
  appIdEnv: string;
  appSecretEnv: string;
  project: string;
  baseBranch?: string;
  forbiddenPaths: string[];
  conversations: string[];
  rateLimitPerMinute: number;
  maxQueue: number;
  autoApprove: boolean;
  replyMaxChars: number;
}

export interface AccessEntry {
  members: string[];
  admins: string[];
}

export interface UserConfig {
  home: string;
  plugins: string[];
  agents: Record<string, AgentInstanceConfig>;
  cooldownMinutes: number;
  startupTimeoutSeconds: number;
  /** 可写角色的权限，对各家生效；某一家可以在自己的条目里另设。 */
  permissions: WritePermissions;
  envPass: string[];
  channels: { feishu?: FeishuChannelConfig };
  access: Record<string, AccessEntry>;
}

// ---------- 结构校验 ----------

const roleSchema = z
  .object({
    alias: z.array(z.string().min(1)).default([]),
    description: z.string().optional(),
    candidates: z.array(z.string().min(1)).min(1),
    access: z.enum(['read-only', 'write']),
    must_differ_from: z.string().optional(),
    timeout_minutes: z.number().positive().optional(),
  })
  .strict();

const rolesFileSchema = z
  .object({
    roles: z.record(roleSchema),
    fallback: z.enum(['auto', 'manual', 'ask']).default('auto'),
  })
  .strict();

const projectFileSchema = z
  .object({
    lead_role: z.string().default('lead'),
    review_role: z.string().default('reviewer'),
    write_roots: z.array(z.string()).default([]),
    max_rework_rounds: z.number().int().min(0).default(2),
    default_timeout_minutes: z.number().positive().default(30),
    max_plan_steps: z.number().int().positive().default(8),
    preamble: z.string().default(''),
    sync_before_task: z.enum(['off', 'pull', 'pull-autostash']).default('off'),
  })
  .strict();

const agentSchema = z
  .object({
    plugin: z.string().optional(),
    command: z.string().optional(),
    model: z.string().optional(),
    allowed_tools: z
      .object({ read_only: z.array(z.string()).optional(), write: z.array(z.string()).optional() })
      .strict()
      .optional(),
    env_pass: z.array(z.string()).optional(),
    timeout_minutes: z.number().positive().optional(),
    enabled: z.boolean().optional(),
    permissions: z.enum(['full', 'listed']).optional(),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

const agentsFileSchema = z
  .object({
    plugins: z.array(z.string()).nullish(),
    agents: z.record(agentSchema).nullish(),
    cooldown_minutes: z.number().positive().default(10),
    startup_timeout_seconds: z.number().positive().default(120),
    permissions: z.enum(['full', 'listed']).default('full'),
    env_pass: z.array(z.string()).nullish(),
  })
  .strict();

const feishuSchema = z
  .object({
    enabled: z.boolean().default(false),
    app_id_env: z.string().default('DARIO_FEISHU_APP_ID'),
    app_secret_env: z.string().default('DARIO_FEISHU_APP_SECRET'),
    project: z.string().default(''),
    base_branch: z.string().default(''),
    forbidden_paths: z.array(z.string()).default([]),
    conversations: z.array(z.string()).default([]),
    rate_limit_per_minute: z.number().int().positive().default(5),
    max_queue: z.number().int().positive().default(10),
    auto_approve: z.boolean().default(false),
    reply_max_chars: z.number().int().positive().default(6000),
  })
  .strict();

const channelsFileSchema = z.object({ feishu: feishuSchema.optional() }).strict();

const accessFileSchema = z.record(
  z
    .object({
      members: z.array(z.string()).nullish(),
      admins: z.array(z.string()).nullish(),
    })
    .strict(),
);

/** 出现在项目级配置里即说明有人想定义命令的键名。 */
const COMMAND_KEYS = new Set(['command', 'args', 'plugin', 'plugins', 'env', 'env_pass', 'allowed_tools', 'agents', 'options']);

function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, file: string, projectLevel: boolean): T {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const lines: string[] = [];
  let definesCommand = false;
  for (const issue of result.error.issues) {
    const where = issue.path.join('.') || '（顶层）';
    if (issue.code === 'unrecognized_keys') {
      if (issue.keys.some((k) => COMMAND_KEYS.has(k))) definesCommand = true;
      lines.push(`${where}: 不认识的键 ${issue.keys.join('、')}`);
    } else {
      lines.push(`${where}: ${issue.message}`);
    }
  }
  const head =
    projectLevel && definesCommand
      ? `项目级配置不能定义或修改 AI 的命令与参数，这些只能写在本机的 ~/.dario/agents.yaml 里。\n${file}`
      : `配置文件有误：${file}`;
  throw new ConfigError(`${head}\n  ${lines.join('\n  ')}`);
}

function loadYaml(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return parseYaml(text);
  } catch (e) {
    throw new ConfigError(`配置文件不是合法的 YAML：${file}\n  ${(e as Error).message}`);
  }
}

// ---------- 路径 ----------

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DARIO_HOME && env.DARIO_HOME.trim() ? env.DARIO_HOME : path.join(os.homedir(), '.dario'));
}

/** 从 cwd 向上找带 .dario/ 的目录；用户级目录本身不算项目配置。 */
export function findProjectRoot(cwd: string, home: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, '.dario');
    if (normPath(candidate) !== normPath(home)) {
      try {
        if (fs.statSync(candidate).isDirectory()) return dir;
      } catch {
        // 不存在，继续向上
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------- 项目级 ----------

/** 这些文件只允许出现在用户级目录。 */
const USER_ONLY_ENTRIES = ['agents.yaml', 'agents.yml', 'channels.yaml', 'channels.yml', 'access.yaml', 'access.yml', 'plugins'];

export function parseRoles(data: unknown, file: string, projectLevel: boolean): RolesConfig {
  const parsed = validate(rolesFileSchema, data, file, projectLevel);
  const roles: Record<string, RoleDef> = {};
  for (const [id, r] of Object.entries(parsed.roles)) {
    roles[id] = {
      id,
      alias: r.alias,
      description: r.description,
      candidates: r.candidates,
      access: r.access,
      mustDifferFrom: r.must_differ_from,
      timeoutMinutes: r.timeout_minutes,
    };
  }
  if (Object.keys(roles).length === 0) throw new ConfigError(`角色表里没有任何角色：${file}`);
  const seen = new Map<string, string>();
  for (const role of Object.values(roles)) {
    for (const name of [role.id, ...role.alias]) {
      const key = name.toLowerCase();
      const other = seen.get(key);
      if (other && other !== role.id) throw new ConfigError(`角色名或别名重复："${name}" 同时属于 ${other} 和 ${role.id}（${file}）`);
      seen.set(key, role.id);
    }
    if (role.mustDifferFrom && !roles[role.mustDifferFrom]) {
      throw new ConfigError(`角色 ${role.id} 的 must_differ_from 指向不存在的角色 ${role.mustDifferFrom}（${file}）`);
    }
  }
  return { roles, fallback: parsed.fallback };
}

function parseSettings(data: unknown, file: string, projectLevel: boolean): ProjectSettings {
  const p = validate(projectFileSchema, data, file, projectLevel);
  return {
    leadRole: p.lead_role,
    reviewRole: p.review_role,
    writeRoots: p.write_roots,
    maxReworkRounds: p.max_rework_rounds,
    defaultTimeoutMinutes: p.default_timeout_minutes,
    maxPlanSteps: p.max_plan_steps,
    preamble: p.preamble,
    syncBeforeTask: p.sync_before_task,
  };
}

export function loadProjectConfig(cwd: string, home: string, explicitRoot?: string): ProjectConfig {
  const found = explicitRoot ? path.resolve(explicitRoot) : findProjectRoot(cwd, home);
  const root = found ?? path.resolve(cwd);
  const projectDir = path.join(root, '.dario');
  const hasProjectDir = fs.existsSync(projectDir) && normPath(projectDir) !== normPath(home);

  if (hasProjectDir) {
    const offending = USER_ONLY_ENTRIES.filter((name) => fs.existsSync(path.join(projectDir, name)));
    if (offending.length > 0) {
      throw new ConfigError(
        `项目级配置不能定义 AI 的命令、插件、渠道或名单，这些只能放在本机的 ~/.dario/ 里。\n` +
          `请从 ${projectDir} 移除：${offending.join('、')}`,
      );
    }
  }

  const pick = (name: string): { file: string; projectLevel: boolean } | undefined => {
    if (hasProjectDir) {
      const p = path.join(projectDir, name);
      if (fs.existsSync(p)) return { file: p, projectLevel: true };
    }
    const u = path.join(home, name);
    if (fs.existsSync(u)) return { file: u, projectLevel: false };
    return undefined;
  };

  const rolesSrc = pick('roles.yaml');
  const roles = rolesSrc
    ? parseRoles(loadYaml(rolesSrc.file), rolesSrc.file, rolesSrc.projectLevel)
    : parseRoles(parseYaml(DEFAULT_ROLES_YAML), '（内置默认角色表）', false);

  const settingsSrc = pick('project.yaml');
  const settings = settingsSrc
    ? parseSettings(loadYaml(settingsSrc.file), settingsSrc.file, settingsSrc.projectLevel)
    : parseSettings(parseYaml(DEFAULT_PROJECT_YAML), '（内置默认项目设置）', false);

  const rulesSrc = pick('dispatch-rules.md');
  const dispatchRules = (rulesSrc ? readText(rulesSrc.file) : undefined) ?? DEFAULT_DISPATCH_RULES;

  return { root, hasProjectDir, roles, settings, dispatchRules, rolesFile: rolesSrc?.file };
}

// ---------- 用户级 ----------

export function loadUserConfig(home: string): UserConfig {
  const agentsFile = path.join(home, 'agents.yaml');
  const a = validate(agentsFileSchema, loadYaml(agentsFile), agentsFile, false);
  const agents: Record<string, AgentInstanceConfig> = {};
  for (const [id, c] of Object.entries(a.agents ?? {})) {
    agents[id] = {
      plugin: c.plugin,
      command: c.command,
      model: c.model,
      allowedTools: c.allowed_tools ? { readOnly: c.allowed_tools.read_only, write: c.allowed_tools.write } : undefined,
      envPass: c.env_pass,
      timeoutMinutes: c.timeout_minutes,
      enabled: c.enabled,
      permissions: c.permissions,
      options: c.options,
    };
  }

  const channelsFile = path.join(home, 'channels.yaml');
  const c = validate(channelsFileSchema, loadYaml(channelsFile), channelsFile, false);
  const feishu: FeishuChannelConfig | undefined = c.feishu
    ? {
        enabled: c.feishu.enabled,
        appIdEnv: c.feishu.app_id_env,
        appSecretEnv: c.feishu.app_secret_env,
        project: c.feishu.project,
        baseBranch: c.feishu.base_branch || undefined,
        forbiddenPaths: c.feishu.forbidden_paths,
        conversations: c.feishu.conversations,
        rateLimitPerMinute: c.feishu.rate_limit_per_minute,
        maxQueue: c.feishu.max_queue,
        autoApprove: c.feishu.auto_approve,
        replyMaxChars: c.feishu.reply_max_chars,
      }
    : undefined;

  const accessFile = path.join(home, 'access.yaml');
  const acc = validate(accessFileSchema, loadYaml(accessFile), accessFile, false);
  const access: Record<string, AccessEntry> = {};
  for (const [channel, entry] of Object.entries(acc)) {
    access[channel] = { members: entry.members ?? [], admins: entry.admins ?? [] };
  }

  return {
    home,
    plugins: a.plugins ?? [],
    agents,
    cooldownMinutes: a.cooldown_minutes,
    startupTimeoutSeconds: a.startup_timeout_seconds,
    permissions: a.permissions,
    envPass: a.env_pass ?? [],
    channels: { feishu },
    access,
  };
}
