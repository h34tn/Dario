import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../core/util.js';
import { looksUnavailable, PLUGIN_API_VERSION, type AgentPlugin, type InvokeRequest } from '../plugin.js';

/**
 * 声明式插件：用一份 YAML 清单接入一个 AI 命令行工具，不需要写代码。
 *
 *   id: dsh
 *   display_name: DeepSeek Harness
 *   command: dsh
 *   args:
 *     read_only: [--profile, headless]
 *     write: [--profile, headless]
 *   model_args: [--model, "{model}"]   # 只在配置了模型时追加
 *   prompt: stdin                      # stdin（默认）或 arg（作为最后一个参数）
 *   output: stdout                     # stdout（默认）或 file（工具把答复写到 {result_file}）
 *   streams: false
 *
 * 参数里可用的占位符：{cwd}、{model}、{result_file}。
 */
const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, '只能用小写字母、数字、连字符'),
    display_name: z.string().optional(),
    command: z.string().min(1),
    version_args: z.array(z.string()).optional(),
    args: z.object({ read_only: z.array(z.string()), write: z.array(z.string()) }).strict(),
    model_args: z.array(z.string()).default([]),
    prompt: z.enum(['stdin', 'arg']).default('stdin'),
    output: z.enum(['stdout', 'file']).default('stdout'),
    streams: z.boolean().default(false),
    env_pass: z.array(z.string()).default([]),
    unavailable_patterns: z.array(z.string()).default([]),
  })
  .strict();

export function pluginFromManifest(text: string, file: string): AgentPlugin {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`插件清单不是合法的 YAML：${file}\n  ${(e as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '（顶层）'}: ${i.message}`).join('\n  ');
    throw new ConfigError(`插件清单有误：${file}\n  ${detail}`);
  }
  const m = parsed.data;
  let patterns: RegExp[];
  try {
    patterns = m.unavailable_patterns.map((p) => new RegExp(p, 'i'));
  } catch (e) {
    throw new ConfigError(`插件清单里的 unavailable_patterns 不是合法的正则：${file}\n  ${(e as Error).message}`);
  }

  const fill = (arg: string, req: InvokeRequest): string =>
    arg.replaceAll('{cwd}', req.cwd).replaceAll('{model}', req.model ?? '').replaceAll('{result_file}', req.resultFile);

  return {
    apiVersion: PLUGIN_API_VERSION,
    id: m.id,
    displayName: m.display_name ?? m.id,
    defaultCommand: m.command,
    versionArgs: m.version_args,
    streams: m.streams,
    envPass: m.env_pass,
    build(req) {
      const base = req.access === 'write' ? m.args.write : m.args.read_only;
      const args = [...base, ...(req.model ? m.model_args : [])].map((a) => fill(a, req));
      const extra = req.options.extra_args;
      if (Array.isArray(extra)) args.push(...extra.map(String));
      if (m.prompt === 'arg') return { args: [...args, req.prompt] };
      return { args, stdin: req.prompt };
    },
    parse(raw) {
      const text = m.output === 'file' ? (raw.resultFileText ?? '') : raw.stdout;
      return { text: text.trim() };
    },
    classify(raw, output) {
      if (raw.spawnError || raw.timedOut || raw.startupTimedOut) return undefined;
      if (raw.exitCode === 0 && output.text) return undefined;
      const hay = `${raw.stderr.slice(-4000)}\n${output.text.slice(-4000)}\n${raw.stdout.slice(-4000)}`;
      const hit = patterns.find((p) => p.test(hay));
      if (hit) return { outcome: 'unavailable', reason: `输出匹配了清单里的不可用特征：${hit.source}` };
      return looksUnavailable(hay) ? undefined : { outcome: 'task_failed', reason: `退出码 ${raw.exitCode ?? '无'}` };
    },
  };
}
