import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { formatConclusion } from '../src/ui/markdown.js';
import { paint } from '../src/ui/theme.js';

it('标题、列表、行内代码和粗体正确排版，代码块内保留标记', () => {
  const source = '\n## 结论\n\n  - **成功**：`a.ts`\n* 二\n1. 三\n\n\n\n```ts\n  **字面**\n```\n\n';
  const plain = '结论\n\n  - 成功：a.ts\n* 二\n1. 三\n\n    **字面**';
  expect(formatConclusion(source, false)).toBe(plain);
  const colored = formatConclusion(source, true);
  for (const [tone, value] of [['title', '结论'], ['title', '成功'], ['role', 'a.ts'], ['dim', '    **字面**']] as const)
    expect(colored).toContain(paint(tone, value, true));
  expect(stripVTControlCharacters(colored)).toBe(plain);
  expect(formatConclusion(paint('fail', '输入带颜色', true), false)).toBe('输入带颜色');
});
