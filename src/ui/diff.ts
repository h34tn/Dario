import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paint, type Tone } from './theme.js';

const exec = promisify(execFile);

function lineTone(line: string): Tone | undefined {
  if (/^(diff --git|index |\+\+\+|---)/.test(line)) return 'dim';
  if (line.startsWith('+')) return 'done';
  if (line.startsWith('-')) return 'fail';
  if (line.startsWith('@@')) return 'role';
}

export function colorizeDiff(diff: string, color: boolean, maxLines: number): { text: string; truncated: number } {
  const lines = diff.split('\n');
  if (!lines.at(-1)) lines.pop();
  const shown = lines.slice(0, Math.max(0, maxLines)).map(line => {
    const tone = lineTone(line);
    return tone ? paint(tone, line, color) : line;
  });
  const truncated = lines.length - shown.length;
  const newline = !truncated && diff.endsWith('\n') ? '\n' : '';
  return { text: shown.join('\n') + newline, truncated };
}

export async function readDiff(cwd: string, files: string[]): Promise<{ stat: string; diff: string; untracked: string[]; error?: string }> {
  const empty = { stat: '', diff: '', untracked: [] };
  if (!files.length) return empty;
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.quotepath=false', ...args, '--', ...files],
    { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } })).stdout;
  try {
    const [stat, diff, names] = await Promise.all([git('diff', '--stat'), git('diff'), git('ls-files', '-z', '--others', '--exclude-standard')]);
    return { stat, diff, untracked: names.split('\0').filter(Boolean) };
  } catch (error) {
    const cause = error as Error & { stderr?: string };
    return { ...empty, error: (cause.stderr?.trim() || cause.message).split(/\r?\n/)[0] };
  }
}
