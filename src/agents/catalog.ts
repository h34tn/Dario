import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentInstanceConfig, UserConfig } from '../core/config.js';
import type { AgentCatalog, AgentPort } from '../core/ports.js';
import { ConfigError } from '../core/util.js';
import { PLUGIN_API_VERSION, type AgentPlugin } from '../plugin.js';
import { BUILTIN_AGENTS, BUILTIN_PLUGINS } from './builtin.js';
import { AgentHandle } from './handle.js';
import { pluginFromManifest } from './manifest.js';

function assertPlugin(value: unknown, source: string): AgentPlugin {
  const p = value as Partial<AgentPlugin> | undefined;
  const problems: string[] = [];
  if (!p || typeof p !== 'object') throw new ConfigError(`插件没有导出插件对象：${source}`);
  if (p.apiVersion !== PLUGIN_API_VERSION) problems.push(`apiVersion 应为 ${PLUGIN_API_VERSION}，实际是 ${String(p.apiVersion)}`);
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) problems.push('id 只能用小写字母、数字、连字符');
  if (typeof p.defaultCommand !== 'string' || !p.defaultCommand) problems.push('缺少 defaultCommand');
  if (typeof p.build !== 'function') problems.push('缺少 build 函数');
  if (typeof p.parse !== 'function') problems.push('缺少 parse 函数');
  if (typeof p.streams !== 'boolean') problems.push('缺少 streams（true 或 false）');
  if (problems.length) throw new ConfigError(`插件不符合接口：${source}\n  ${problems.join('\n  ')}`);
  return { ...(p as AgentPlugin), displayName: p.displayName ?? p.id! };
}

/** 加载一个外部插件：YAML 清单、JS 模块，或已安装的包名。 */
async function loadPlugin(entry: string, home: string): Promise<AgentPlugin> {
  const looksLikePath = entry.startsWith('.') || path.isAbsolute(entry) || /\.(ya?ml|m?js|cjs)$/i.test(entry);
  if (looksLikePath) {
    const file = path.resolve(home, entry);
    if (!fs.existsSync(file)) throw new ConfigError(`找不到插件文件：${file}（在 agents.yaml 的 plugins 里声明）`);
    if (/\.ya?ml$/i.test(file)) return pluginFromManifest(fs.readFileSync(file, 'utf8'), file);
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; plugin?: unknown };
    return assertPlugin(mod.default ?? mod.plugin, file);
  }
  let resolved: string;
  try {
    resolved = createRequire(path.join(home, 'package.json')).resolve(entry);
  } catch {
    throw new ConfigError(`找不到插件包：${entry}。请先在 ${home} 里安装它（npm install ${entry}）。`);
  }
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown; plugin?: unknown };
  return assertPlugin(mod.default ?? mod.plugin, entry);
}

export interface CatalogResult {
  catalog: AgentCatalog;
  plugins: AgentPlugin[];
}

/**
 * 组装这台机器上的 AI 目录：内置插件 + 用户在 agents.yaml 里声明的插件，
 * 再按 agents.yaml 的设置生成各个 AI。插件只从用户级配置加载。
 */
export async function buildCatalog(user: UserConfig, env: NodeJS.ProcessEnv = process.env): Promise<CatalogResult> {
  const plugins = new Map<string, AgentPlugin>(BUILTIN_PLUGINS.map((p) => [p.id, p]));
  const external: string[] = [];
  for (const entry of user.plugins) {
    const plugin = await loadPlugin(entry, user.home);
    if (plugins.has(plugin.id)) throw new ConfigError(`插件标识重复：${plugin.id}（来自 ${entry}）。内置插件的标识不能被覆盖。`);
    plugins.set(plugin.id, plugin);
    external.push(plugin.id);
  }

  const instances = new Map<string, AgentInstanceConfig>();
  for (const [id, base] of Object.entries(BUILTIN_AGENTS)) instances.set(id, { ...base });
  // 每个外部插件默认生成一个同名的 AI
  for (const id of external) instances.set(id, { plugin: id });
  for (const [id, cfg] of Object.entries(user.agents)) {
    const base = instances.get(id) ?? {};
    const merged: AgentInstanceConfig = { ...base };
    for (const [k, v] of Object.entries(cfg)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
    instances.set(id, merged);
  }

  const settings = { startupTimeoutSeconds: user.startupTimeoutSeconds, envPass: user.envPass, env };
  const handles = new Map<string, AgentPort>();
  for (const [id, cfg] of instances) {
    const pluginId = cfg.plugin ?? id;
    const plugin = plugins.get(pluginId);
    if (!plugin) {
      throw new ConfigError(`agents.yaml 里的 ${id} 使用了不存在的插件 ${pluginId}。可用插件：${[...plugins.keys()].join('、')}`);
    }
    handles.set(id, new AgentHandle(id, plugin, cfg, settings));
  }

  return {
    catalog: {
      get: (id) => handles.get(id),
      list: () => [...handles.values()],
    },
    plugins: [...plugins.values()],
  };
}
