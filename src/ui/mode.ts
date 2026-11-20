export type OutputMode = 'plain' | 'live';

export interface ModeInput {
  plainFlag: boolean;
  format: 'text' | 'json';
  stderrIsTTY: boolean;
  columns?: number;
  env: NodeJS.ProcessEnv;
  hasStreams: boolean;
}

export function pickOutputMode(input: ModeInput): OutputMode {
  if (input.plainFlag || input.env.DARIO_PLAIN === '1' || input.format === 'json' ||
      !input.stderrIsTTY || !input.hasStreams || (input.columns !== undefined && input.columns < 40)) return 'plain';
  return 'live';
}

export function colorEnabled(input: { stderrIsTTY: boolean; env: NodeJS.ProcessEnv }): boolean {
  return input.stderrIsTTY && !input.env.NO_COLOR;
}
