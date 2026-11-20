/** 组装：把配置、AI 目录、渠道接到核心上。核心之外唯一知道具体实现的地方。 */
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalog } from './agents/catalog.js';
import { createSdkTransport, FeishuChannel, type FeishuTransport } from './channels/feishu.js';
import { loadProjectConfig, loadUserConfig, resolveHome, type ProjectConfig, type UserConfig } from './core/config.js';
import { Engine } from './core/engine.js';
import { ChannelRouter } from './core/router.js';
import { StateStore } from './core/state.js';
import type { Strategy } from './core/types.js';
import { ConfigError, isPidAlive, readJson, writeJsonAtomic } from './core/util.js';
import type { IsolatedOptions } from './core/workspace.js';
import type { AgentPlugin } from './plugin.js';

export interface AppOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 明确指定项目根目录；不填则从 cwd 向上查找。 */
  projectRoot?: string;
  strategy?: Strategy;
  isolated?: IsolatedOptions;
}

export interface App {
  home: string;
  user: UserConfig;
  project: ProjectConfig;
  state: StateStore;
  engine: Engine;
  plugins: AgentPlugin[];
}

export async function createApp(opts: AppOptions): Promise<App> {
  const home = resolveHome(opts.env);
  const user = loadUserConfig(home);
  const project = loadProjectConfig(opts.cwd, home, opts.projectRoot);
  const { catalog, plugins } = await buildCatalog(user, opts.env);
  const state = new StateStore(home);
  const engine = new Engine({ user, project, catalog, state, strategy: opts.strategy ?? 'in-place', isolated: opts.isolated });
  return { home, user, project, state, engine, plugins };
}

export interface ServeHandle {
  router: ChannelRouter;
  app: App;
  stop(): Promise<void>;
}

export interface ServeOptions {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** 测试时注入，代替真实的飞书连接。 */
  transport?: FeishuTransport;
}

/** 常驻运行：启动配置里启用的渠道。目前只有飞书。 */
export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const home = resolveHome(opts.env);
  const user = loadUserConfig(home);
  const feishu = user.channels.feishu;
  if (!feishu?.enabled) {
    throw new ConfigError(`没有启用任何渠道。请在 ${path.join(home, 'channels.yaml')} 里把 feishu.enabled 设为 true。`);
  }
  const appId = opts.env[feishu.appIdEnv];
  const appSecret = opts.env[feishu.appSecretEnv];
  if (!opts.transport && (!appId || !appSecret)) {
    throw new ConfigError(`没有找到飞书应用凭据。请设置环境变量 ${feishu.appIdEnv} 和 ${feishu.appSecretEnv}。`);
  }
  if (!feishu.project) throw new ConfigError('channels.yaml 的 feishu.project 没有填写：远程渠道必须指定隔离执行用的独立克隆。');
  const root = path.resolve(feishu.project);
  if (!fs.existsSync(root)) throw new ConfigError(`隔离克隆不存在：${root}`);
  const access = user.access.feishu;
  if (!access || access.members.length + access.admins.length === 0) {
    throw new ConfigError(`飞书渠道的名单是空的。请在 ${path.join(home, 'access.yaml')} 里填写成员或管理员。`);
  }

  const app = await createApp({
    cwd: root,
    env: opts.env,
    projectRoot: root,
    strategy: 'isolated',
    isolated: { baseBranch: feishu.baseBranch, forbiddenPaths: feishu.forbiddenPaths },
  });
  await app.engine.assertWorkspaceUsable();

  // 飞书长连接是"多个客户端随机收一条"，同一台机器上只能跑一个实例
  const lockFile = path.join(app.state.dir, 'serve.lock.json');
  const holder = readJson<{ pid?: number }>(lockFile, {}).pid;
  if (holder && holder !== process.pid && isPidAlive(holder)) {
    throw new ConfigError(`已经有一个 dario serve 在运行（进程 ${holder}）。同一时间只能运行一个。`);
  }
  writeJsonAtomic(lockFile, { pid: process.pid });

  const transport = opts.transport ?? createSdkTransport(appId!, appSecret!, opts.log);
  const router = new ChannelRouter(app.engine, new FeishuChannel(transport), access, {
    conversations: feishu.conversations,
    rateLimitPerMinute: feishu.rateLimitPerMinute,
    maxQueue: feishu.maxQueue,
    autoApprove: feishu.autoApprove,
    replyMaxChars: feishu.replyMaxChars,
    secrets: [appSecret ?? ''].filter(Boolean),
  });
  await router.start();
  app.state.audit('serve_start', { channel: 'feishu', project: root });
  opts.log(`飞书渠道已启动。隔离克隆：${root}`);

  return {
    router,
    app,
    async stop() {
      await router.stop();
      try {
        if (readJson<{ pid?: number }>(lockFile, {}).pid === process.pid) fs.unlinkSync(lockFile);
      } catch {
        // 忽略
      }
      app.state.audit('serve_stop', {});
    },
  };
}
