/**
 * 计划里每一步预计改动的范围（PlanStep.files）：路径规范化与匹配。
 *
 * 条目相对项目根目录。不含通配符的条目可以是文件，也可以是目录（目录下的文件都算）；
 * 含通配符时 `*` 匹配不含 / 的任意字符，`**` 匹配任意层目录，`?` 匹配一个不是 / 的字符。
 * Windows 上不区分大小写。
 */

import type { Plan } from './types.js';

/** 整理成相对、正斜杠、无首尾多余字符的写法。 */
export function normalizeScopePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);

export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**/" 可以是零层目录；单独的 "**" 匹配任意内容
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** 文件是否落在范围内。范围为空数组时什么都不算在内；调用方用 undefined 表示"不检查"。 */
export function inScope(file: string, patterns: string[]): boolean {
  const f = fold(normalizeScopePath(file));
  return patterns.some((raw) => {
    const p = fold(normalizeScopePath(raw));
    if (!p) return false;
    if (/[*?]/.test(p)) return globToRegExp(p).test(f);
    return f === p || f.startsWith(`${p}/`);
  });
}

/** 返工时的范围：计划里所有改文件步骤的范围之并。有一步没写范围就无法判断，返回 undefined。 */
export function reworkScope(plan: Plan | undefined): string[] | undefined {
  const writing = plan?.steps.filter((s) => s.writes) ?? [];
  if (writing.length === 0 || writing.some((s) => !s.files?.length)) return undefined;
  return [...new Set(writing.flatMap((s) => s.files!))];
}
