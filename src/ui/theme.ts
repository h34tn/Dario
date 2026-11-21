import { styleText } from 'node:util';

export interface Symbols {
  done: string;
  fail: string;
  warn: string;
  frames: string[];
  ellipsis: string;
  rule: string;
  down: string;
  up: string;
  wide: boolean;
}

export function pickSymbols(env: NodeJS.ProcessEnv, system: { platform: string; locale: string } = {
  platform: process.platform, locale: Intl.DateTimeFormat().resolvedOptions().locale,
}): Symbols {
  // 空字符串等同于没有设置。
  const wide = system.platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM
    && /^(zh|ja|ko)/i.test(system.locale);
  return env.WT_SESSION
    ? { done: '✓', fail: '✗', warn: '!', frames: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'], ellipsis: '…', rule: '─', down: '↓', up: '↑', wide }
    : { done: '+', fail: 'x', warn: '!', frames: ['-', '\\', '|', '/'], ellipsis: '...', rule: '-', down: 'v', up: '^', wide };
}

export type Tone = 'done' | 'fail' | 'warn' | 'role' | 'agent' | 'dim' | 'title';
const styles = { done: 'green', fail: 'red', warn: 'yellow', role: 'cyan', agent: 'magenta', dim: 'dim', title: 'bold' } as const;

export function toneColor(tone: Tone, enabled: boolean): { color?: string; bold?: boolean; dimColor?: boolean } {
  if (!enabled) return {};
  if (tone === 'dim') return { dimColor: true };
  if (tone === 'title') return { bold: true };
  return { color: styles[tone] };
}

/**
 * 输入回显的底色与字色：深灰底、亮字，用 256 色里固定的两个颜色。
 * 基础 16 色里的"亮黑"在不少主题下太浅，和默认字色贴得太近；固定字色则保证浅色主题下也看得清。
 */
export const INPUT_BAND = { open: '\x1b[48;5;237m', text: '\x1b[38;5;255m', close: '\x1b[0m' } as const;

export function paint(tone: Tone, text: string, enabled: boolean): string {
  return enabled ? styleText(styles[tone], text, { validateStream: false }) : text;
}
