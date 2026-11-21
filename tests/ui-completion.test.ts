import { expect, it } from 'vitest';
import { suggest } from '../src/ui/completion.js';
import { editorSetValue, EMPTY_EDITOR } from '../src/ui/editor.js';

const ctx = { roles: [{ id: 'coder', alias: ['实现'] }], agents: ['claude', 'codex', 'other'] };
const values = (line: string) => suggest(line, ctx).map(s => s.value);

it('按顺序列出全部指令并按是否带参数补空格', () => {
  expect(values('/')).toEqual(['/to ', '/roles', '/role ', '/model ', '/agents', '/health ',
    '/status ', '/approve ', '/cancel ', '/diff', '/continue ', '/new', '/plain', '/help', '/exit']);
  expect(values('/r')).toEqual(['/roles', '/role ']);
  expect(values('/role\ncoder')).toEqual([]);
  expect(values('任务')).toEqual([]);
});

it('角色别名优先，名字和提示互为别名，任务正文不补全', () => {
  expect(suggest('/to ', ctx)).toEqual([{ label: '实现', hint: 'coder', value: '/to 实现 ' },
    { label: 'coder', hint: '实现', value: '/to coder ' }]);
  expect(values('/model 实')).toEqual(['/model 实现 ']);
  expect(values('/to 实')).toEqual(['/to 实现 ']);
  expect(values('/role CO')).toEqual(['/role coder ']);
  expect(values('/to 实现 ')).toEqual([]);
});

it('担当者与健康检查按前缀过滤，最后一个参数不加空格', () => {
  expect(values('/role coder ')).toEqual(['/role coder claude', '/role coder codex', '/role coder other', '/role coder reset']);
  expect(suggest('/role 实现 re', ctx)[0]?.hint).toBe('恢复为角色表里的顺序');
  expect(values('/health c')).toEqual(['/health claude', '/health codex']);
  expect(values('/status ')).toEqual([]);
});

it('补全后光标按字素落在末尾，退出历史浏览并保留粘贴块', () => {
  const state = { ...EMPTY_EDITOR, history: ['旧任务'], historyIndex: 0, draft: '草稿', pasted: '甲\n乙' };
  expect(editorSetValue(state, '实现👍🏽')).toEqual({ ...state, value: '实现👍🏽', cursor: 3, historyIndex: undefined, draft: undefined });
});
