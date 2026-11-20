import { styleText } from 'node:util';

export interface Symbols {
  done: string;
  fail: string;
  warn: string;
  frames: string[];
  ellipsis: string;
  wide: boolean;
}

export function pickSymbols(env: NodeJS.ProcessEnv, system: { platform: string; locale: string } = {
  platform: process.platform, locale: Intl.DateTimeFormat().resolvedOptions().locale,
}): Symbols {
  // 空字符串等同于没有设置。
  const wide = system.platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM
    && /^(zh|ja|ko)/i.test(system.locale);
  return env.WT_SESSION
    ? { done: '✓', fail: '✗', warn: '!', frames: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'], ellipsis: '…', wide }
    : { done: '+', fail: 'x', warn: '!', frames: ['-', '\\', '|', '/'], ellipsis: '...', wide };
}

export type Tone = 'done' | 'fail' | 'warn' | 'role' | 'agent' | 'dim' | 'title';
const styles = { done: 'green', fail: 'red', warn: 'yellow', role: 'cyan', agent: 'magenta', dim: 'dim', title: 'bold' } as const;

export function toneColor(tone: Tone, enabled: boolean): { color?: string; bold?: boolean; dimColor?: boolean } {
  if (!enabled) return {};
  if (tone === 'dim') return { dimColor: true };
  if (tone === 'title') return { bold: true };
  return { color: styles[tone] };
}

export function paint(tone: Tone, text: string, enabled: boolean): string {
  return enabled ? styleText(styles[tone], text, { validateStream: false }) : text;
}
