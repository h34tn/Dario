import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { editYamlFile } from './yaml-edit.js';
import { z } from 'zod';
import type { Access } from '../plugin.js';
import { defaultDispatchRules, DEFAULT_DISPATCH_RULES, DEFAULT_PROJECT_YAML, DEFAULT_ROLES_YAML } from './defaults.js';
import { ConfigError, normPath, readText } from './util.js';

// ---------- 类型 ----------

export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export interface RoleDef {
  models?: Record<string, ModelSettings>;
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
  leadImplements: boolean;
  reviewRole: string;
  writeRoots: string[];
  maxReworkRounds: number;
  /** 改动不超过这么多行时跳过自动追加的审查；0 表示始终审查。 */
  reviewSkipMaxLines: number;
  /** 交接时附上的代码片段和审查用的 diff，各自最多这么多字符；0 表示不附。 */
  handoffMaxChars: number;
  defaultTimeoutMinutes: number;
  maxPlanSteps: number;
  preamble: string;
  /** 开工前与远端同步的方式。 */
  syncBeforeTask: SyncMode;
  /** 干活监控的规则，见 watch.ts。 */
  supervise: SuperviseSettings;
}

/**
 * 监控规则触发后的处理：off 不检查，notify 只提示，stop 中断这一步，
 * ask_lead 交给主控判断继续、纠偏还是中止（只有部分规则可用）。
 */
export type WatchAction = 'off' | 'notify' | 'stop' | 'ask_lead';

export interface SuperviseSettings {
  /** 没动静：超过 minutes 分钟没有任何输出；最后一行是开始执行命令时用 commandMinutes。 */
  idle: { minutes: number; commandMinutes: number; action: WatchAction };
  /** 改动落在 write_roots 之外。write_roots 为空时不检查。 */
  outOfRoots: { action: WatchAction };
  /** 执行的命令命中清单。清单为空时不检查。 */
  forbiddenCommands: { patterns: string[]; action: Exclude<WatchAction, 'ask_lead'> };
  /** 改动落在计划这一步的 files 之外。计划的范围是估计，只提示，不中断。 */
  offPlan: { action: 'off' | 'notify' };
  /** 原地打转：同一条命令、同一个文件反复出现，或连续多次请求没有新的改动，期间没有改动。 */
  loop: { action: WatchAction; repeatCommand: number; repeatRead: number; requestsWithoutEdit: number };
  /** 用量超过本项目同类步骤历史中位数的 factor 倍。样本少于 minSamples 时不检查。 */
  usage: { action: WatchAction; factor: number; minSamples: number };
  /** ask_lead 时每一步最多纠偏几次，再要纠偏就中止。 */
  maxInterventions: number;
  /** 主控判断一次的时限（分钟）。 */
  consultTimeoutMinutes: number;
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
  effort?: string;
  roles?: Record<string, ModelSettings>;
  allowedTools?: { readOnly?: string[]; write?: string[] };
  envPass?: string[];
  timeoutMinutes?: number;
  enabled?: boolean;
  free?: boolean;
  /** 这一家可写方式的权限，不写则用本机的总设置。 */
  permissions?: WritePermissions;
  /** 判断"没动静"时阈值乘以这个数。 */
  idleFactor?: number;
  /** 压缩界限（token）。插件支持、且总开关打开时才传给工具。 */
  compactLimit?: number;
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
  /** 是否把各家的压缩界限传给工具。关闭时各家按工具自己的默认值压缩。运行中可由 /compact 改写。 */
  useCompactLimit: boolean;
  envPass: string[];
  channels: { feishu?: FeishuChannelConfig };
  access: Record<string, AccessEntry>;
}

// ---------- 结构校验 ----------

export interface ModelUpdate {
  model?: string;
  effort?: string | null;
}

export const modelSettingsSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/, '型号格式不正确').optional(),
  effort: z.string().regex(/^[a-z]{2,16}$/, '强度须为 2 至 16 个小写字母').optional(),
}).strict();

/** 一次写完本次设置，缺省字段沿用原值。 */
export function writeModelSettings(file: string, keys: string[], settings?: ModelUpdate): void {
  const changes = settings
    ? Object.entries(settings).filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ keys: [...keys, key], value }))
    : [{ keys, value: null }];
  editYamlFile(file, changes, keys[0] === 'agents');
}

const roleSchema = z
  .object({
    models: z.record(modelSettingsSchema).optional(),
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

const watchAction = z.enum(['off', 'notify', 'stop']);
const leadAction = z.enum(['off', 'notify', 'stop', 'ask_lead']);

const superviseSchema = z
  .object({
    idle: z
      .object({
        minutes: z.number().positive().default(10),
        command_minutes: z.number().positive().default(30),
        action: leadAction.default('notify'),
      })
      .strict()
      .default({}),
    out_of_roots: z.object({ action: leadAction.default('notify') }).strict().default({}),
    forbidden_commands: z
      .object({
        patterns: z.array(z.string().trim().min(1)).default([]),
        action: watchAction.default('notify'),
      })
      .strict()
      .default({}),
    off_plan: z.object({ action: z.enum(['off', 'notify']).default('notify') }).strict().default({}),
    loop: z
      .object({
        action: leadAction.default('off'),
        repeat_command: z.number().int().min(2).default(3),
        repeat_read: z.number().int().min(2).default(5),
        requests_without_edit: z.number().int().positive().default(20),
      })
      .strict()
      .default({}),
    usage: z
      .object({
        action: leadAction.default('off'),
        factor: z.number().gt(1).default(3),
        min_samples: z.number().int().positive().default(5),
      })
      .strict()
      .default({}),
    max_interventions: z.number().int().min(0).default(2),
    consult_timeout_minutes: z.number().positive().default(3),
  })
  .strict();

const projectFileSchema = z
  .object({
    lead_role: z.string().default('lead'),
    lead_implements: z.boolean().default(true),
    review_role: z.string().default('reviewer'),
    write_roots: z.array(z.string()).default([]),
    max_rework_rounds: z.number().int().min(0).default(2),
    review_skip_max_lines: z.number().int().min(0).default(0),
    handoff_max_chars: z.number().int().min(0).default(20000),
    default_timeout_minutes: z.number().positive().default(30),
    max_plan_steps: z.number().int().positive().default(8),
    preamble: z.string().default(''),
    sync_before_task: z.enum(['off', 'pull', 'pull-autostash']).default('off'),
    supervise: superviseSchema.default({}),
  })
  .strict();

const agentSchema = z
  .object({
    plugin: z.string().optional(),
    command: z.string().optional(),
    ...modelSettingsSchema.shape,
    roles: z.record(modelSettingsSchema).optional(),
    allowed_tools: z
      .object({ read_only: z.array(z.string()).optional(), write: z.array(z.string()).optional() })
      .strict()
      .optional(),
    env_pass: z.array(z.string()).optional(),
    timeout_minutes: z.number().positive().optional(),
    enabled: z.boolean().optional(),
    free: z.boolean().optional(),
    permissions: z.enum(['full', 'listed']).optional(),
    idle_factor: z.number().positive().optional(),
    compact_limit: z.number().int().positive().optional(),
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
    use_compact_limit: z.boolean().default(true),
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
      models: r.models,
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
    leadImplements: p.lead_implements,
    reviewRole: p.review_role,
    writeRoots: p.write_roots,
    maxReworkRounds: p.max_rework_rounds,
    reviewSkipMaxLines: p.review_skip_max_lines,
    handoffMaxChars: p.handoff_max_chars,
    defaultTimeoutMinutes: p.default_timeout_minutes,
    maxPlanSteps: p.max_plan_steps,
    preamble: p.preamble,
    syncBeforeTask: p.sync_before_task,
    supervise: {
      idle: { minutes: p.supervise.idle.minutes, commandMinutes: p.supervise.idle.command_minutes, action: p.supervise.idle.action },
      outOfRoots: { action: p.supervise.out_of_roots.action },
      forbiddenCommands: { patterns: p.supervise.forbidden_commands.patterns, action: p.supervise.forbidden_commands.action },
      offPlan: { action: p.supervise.off_plan.action },
      loop: {
        action: p.supervise.loop.action,
        repeatCommand: p.supervise.loop.repeat_command,
        repeatRead: p.supervise.loop.repeat_read,
        requestsWithoutEdit: p.supervise.loop.requests_without_edit,
      },
      usage: { action: p.supervise.usage.action, factor: p.supervise.usage.factor, minSamples: p.supervise.usage.min_samples },
      maxInterventions: p.supervise.max_interventions,
      consultTimeoutMinutes: p.supervise.consult_timeout_minutes,
    },
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
  const customRules = rulesSrc && readText(rulesSrc.file);
  const dispatchRules = customRules === undefined || customRules.replace(/\r\n/g, '\n').trim() === DEFAULT_DISPATCH_RULES.trim()
    ? defaultDispatchRules(settings.leadImplements)
    : customRules;

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
      effort: c.effort,
      roles: c.roles,
      allowedTools: c.allowed_tools ? { readOnly: c.allowed_tools.read_only, write: c.allowed_tools.write } : undefined,
      envPass: c.env_pass,
      timeoutMinutes: c.timeout_minutes,
      enabled: c.enabled,
      free: c.free,
      permissions: c.permissions,
      idleFactor: c.idle_factor,
      compactLimit: c.compact_limit,
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
    useCompactLimit: a.use_compact_limit,
    envPass: a.env_pass ?? [],
    channels: { feishu },
    access,
  };
}
