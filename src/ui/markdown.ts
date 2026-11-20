import { stripVTControlCharacters } from 'node:util';
import { paint } from './theme.js';

/** 逐行排版结论，代码块保留原本的缩进和标记。 */
export function formatConclusion(text: string, color: boolean): string {
  const lines: string[] = [];
  let code = false;
  let blanks: string[] = [];
  for (const line of stripVTControlCharacters(text).replaceAll('\x1b', '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      code = !code;
      continue;
    }
    if (!line.trim()) {
      blanks.push(code ? paint('dim', '  ' + line, color) : line);
      continue;
    }
    if (lines.length) lines.push(...(blanks.length >= 3 ? [''] : blanks));
    blanks = [];
    if (code) lines.push(paint('dim', '  ' + line, color));
    else {
      const heading = /^#+\s*/.exec(line);
      const content = line.slice(heading?.[0].length ?? 0);
      const formatted = content.replace(/\*\*(.+?)\*\*|`([^`]+)`/g, (_, bold: string | undefined, inline: string) =>
        bold === undefined ? paint('role', inline, color) : paint('title', bold, color && !heading));
      lines.push(heading ? paint('title', formatted, color) : formatted);
    }
  }
  return lines.join('\n');
}
