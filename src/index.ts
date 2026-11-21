/** 作为库使用时的入口：核心接口与组装函数。 */
export { createApp, serve, type App, type AppOptions, type ServeHandle, type ServeOptions } from './compose.js';
export { Engine, type AgentView, type EngineDeps, type HealthResult, type SubmitRequest } from './core/engine.js';
export { ChannelRouter, type RouterOptions } from './core/router.js';
export { parseCommand, type Command } from './core/commands.js';
export { loadProjectConfig, loadUserConfig, resolveHome } from './core/config.js';
export type { CandidateView, EffectiveModel, ModelTarget, RoleView } from './core/roles.js';
export type { ModelSettings, ProjectConfig, RoleDef, RolesConfig, UserConfig } from './core/config.js';
export type { AgentCatalog, AgentPort, ChannelPort, InboundMessage } from './core/ports.js';
export { formatJob, formatRoles, jobToJson, redact, type JobJson } from './core/report.js';
export { exitCodeForJob } from './core/types.js';
export type { Job, JobResult, JobStatus, Plan, PlanStep, ProgressEvent, StepRecord, Strategy } from './core/types.js';
export { ConfigError, DarioError } from './core/util.js';
export * from './plugin.js';
