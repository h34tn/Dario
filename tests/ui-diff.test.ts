import { expect, it } from 'vitest';
import { colorizeDiff, readDiff } from '../src/ui/diff.js';
import { paint } from '../src/ui/theme.js';

it('区分文件头、块头、增删行和上下文，并保留末尾换行', () => {
  const lines = ['diff --git a/x b/x', 'index 123', '--- a/x', '+++ b/x', '@@ 段', '-旧', '+新', ' 内容'];
  const diff = lines.join('\n') + '\n';
  const tones = ['dim', 'dim', 'dim', 'dim', 'role', 'fail', 'done'] as const;
  expect(colorizeDiff(diff, true, 8)).toEqual({ text: lines.map((s, i) => tones[i] ? paint(tones[i], s, true) : s).join('\n') + '\n', truncated: 0 });
  expect(colorizeDiff(diff, false, 20)).toEqual({ text: diff, truncated: 0 });
  expect(colorizeDiff(diff, false, 3)).toEqual({ text: lines.slice(0, 3).join('\n'), truncated: 5 });
});

it('文件列表为空时即使目录不存在也直接返回', async () => {
  expect(await readDiff('不存在的目录', [])).toEqual({ stat: '', diff: '', untracked: [] });
});
