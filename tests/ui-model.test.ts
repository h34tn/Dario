import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { createApp } from '../src/compose.js';
import { Sandbox } from './helpers.js';
import { expect, it, vi } from 'vitest';
import { Session } from '../src/ui/session.js';
import type { Engine } from '../src/core/engine.js';
import { plan, question, setup } from './ui-session-helper.js';

it('上下选角色和型号，切换型号后回落到默认强度，返回时重新查清单', async () => {
  const { session, snap, engine, log } = await setup(undefined, undefined, [{ id: 'codex', model: '常规', effort: 'high' }]);
  engine.roles.listModels.mockClear();
  session.submit('/model');
  await vi.waitFor(() => expect(snap().picker?.step).toBe('roles'));
  expect(engine.roles.listModels.mock.calls.flat().sort()).toEqual(['claude', 'codex']);
  engine.roles.listModels.mockClear();
  const key = session.modelKey.bind(session);
  await key('down');
  await key('enter');
  expect(snap().picker).toMatchObject({ step: 'models', roleIndex: 1, modelIndex: 0, effort: 'high' });
  await key('left');
  expect(snap().picker).toMatchObject({ effort: 'low' });
  await key('down');
  expect(snap().picker).toMatchObject({ modelIndex: 1, effort: undefined });
  await key('back');
  expect(snap().picker?.step).toBe('roles');
  await key('enter');
  expect(engine.roles.listModels).toHaveBeenCalledTimes(2);
  await key('down');
  engine.setModel.mockRejectedValueOnce(new Error('型号已下架'));
  await key('enter');
  expect(engine.setModel).toHaveBeenLastCalledWith('coder', { model: '轻量', effort: null }, 'local');
  expect(snap().picker).toMatchObject({ step: 'models', message: '型号已下架' });
  await key('up');
  await key('right');
  await key('enter');
  expect(engine.setModel).toHaveBeenLastCalledWith('coder', { model: '常规', effort: 'low' }, 'local');
  expect(snap().picker).toBeUndefined();
  expect(log()).toContain('已保存型号');
});

it('清单失败只调当前强度，清单外的当前型号置顶，直接进入后返回即关闭', async () => {
  const { engine, session, snap } = await setup(undefined, undefined, [{ id: 'codex', model: '旧型号' }]);
  engine.roles.listModels.mockResolvedValueOnce({ models: [{ id: '静态' }], error: '超时' });
  session.submit('/model 实现');
  await vi.waitFor(() => expect(snap().picker).toMatchObject({ list: { models: [{ id: '旧型号' }], error: '超时' } }));
  await session.modelKey('down');
  await session.modelKey('right');
  await session.modelKey('enter');
  expect(engine.setModel).toHaveBeenCalledWith('coder', { effort: 'low' }, 'local');
  session.submit('/model coder');
  await vi.waitFor(() => expect(snap().picker).toMatchObject({ outside: '旧型号', modelIndex: 0 }));
  await session.modelKey('back');
  expect(snap().picker).toBeUndefined();
});

it('当前实际型号匹配别名行，同名行保存各自标识，默认强度显式清除', async () => {
  const { session, engine, snap } = await setup(undefined, undefined, [{ id: 'codex', model: 'full', effort: 'low' }]);
  engine.roles.listModels.mockResolvedValue({ models: [
    { id: 'other', label: '同名' }, { id: 'alias', label: '同名', resolved: 'full' },
  ] });
  session.submit('/model 实现');
  await vi.waitFor(() => expect(snap().picker).toMatchObject({ modelIndex: 1, outside: undefined }));
  await session.modelKey('left');
  await session.modelKey('enter');
  expect(engine.setModel).toHaveBeenCalledWith('coder', { model: 'alias', effort: null }, 'local');
});

it('从选择界面保存默认强度，配置仅留别名，状态栏和回复显示继承的强度', async () => {
  const disabled = { enabled: false, command: 'dario-test-missing' };
  const sb = new Sandbox({ resumable: true,
    roles: 'roles: { coder: { candidates: [a2], access: write, models: { a2: { effort: low } } } }',
    agentsExtra: { agents: { a2: { roles: { coder: { model: 'full', effort: 'high' } } },
      claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled } },
  });
  try {
    sb.writeResumablePlugin('a2', 'models');
    sb.setScenario({ models: [{ text: JSON.stringify([{ id: 'alias', label: '显示名', resolved: 'full' }]) }] });
    const { engine } = await createApp({ cwd: sb.project, env: sb.env() });
    const session = new Session({ engine, color: false });
    try {
      await session.start();
      const snap = session.getSnapshot;
      await vi.waitFor(() => expect(snap().status.roles[0]?.model).toBe('显示名[high]'));
      session.submit('/model coder');
      await vi.waitFor(() => expect(snap().picker).toMatchObject({ loading: false, effort: 'high', outside: undefined }));
      await session.modelKey('right');
      expect(snap().picker).toMatchObject({ effort: undefined });
      await session.modelKey('enter');
      expect(snap().picker).toBeUndefined();
      expect(snap().history.at(-1)).toMatchObject({ text: expect.stringContaining('改为 显示名[low]') });
      expect(snap().status.roles[0]?.model).toBe('显示名[low]');
      const config = parse(fs.readFileSync(path.join(sb.home, 'agents.yaml'), 'utf8'));
      expect(config.agents.a2.roles.coder).toEqual({ model: 'alias' });
    } finally { session.dispose(); }
  } finally { sb.cleanup(); }
});

it('启动先显示标识，各家并发只查一次，成功后独立刷新，失败保持首屏内容', async () => {
  const { engine, session: previous } = await setup(undefined, undefined, [
    { id: 'codex', model: 'base', effort: 'high' }, { id: 'claude', model: 'opus' },
  ]);
  previous.dispose();
  let finish!: () => void;
  let fail!: () => void;
  let label = 'base';
  const roles = { ...engine.roles, modelLabel: (_agent: string, model: string) => model === 'base' ? label : model,
    listModels: vi.fn((agent: string) => new Promise((resolve, reject) => {
      if (agent === 'codex') finish = () => { label = '显示名'; resolve({ models: [{ id: 'base', label }] }); };
      else fail = () => reject(new Error('查询失败'));
    })) };
  const session = new Session({ engine: { ...engine, roles } as unknown as Engine, color: false });
  await session.start();
  const status = () => session.getSnapshot().status.roles.map(r => r.model);
  expect(status()).toContain('base[high]');
  expect(roles.listModels.mock.calls.flat().sort()).toEqual(['claude', 'codex']);
  finish();
  await vi.waitFor(() => expect(status()).toContain('显示名[high]'));
  const history = session.getSnapshot().history;
  fail();
  await Promise.resolve();
  expect(status()).toContain('opus');
  expect(session.getSnapshot().history).toEqual(history);
  session.submit('/roles');
  await vi.waitFor(() => expect(session.getSnapshot().history.at(-1)).toMatchObject({ text: expect.stringContaining('显示名[high]') }));
  session.dispose();
});

it('没有担当者的角色仍可见，确认后提示原因并保留角色选择', async () => {
  const { session, engine, snap } = await setup(undefined, [{ id: 'lead', label: '主控', access: 'read-only', state: 'unavailable' }]);
  engine.roles.listModels.mockClear();
  session.submit('/model');
  await vi.waitFor(() => expect(snap().picker?.step).toBe('roles'));
  await session.modelKey('enter');
  expect(snap().picker).toMatchObject({ step: 'roles', message: expect.stringContaining('没有可用') });
  expect(engine.roles.listModels).not.toHaveBeenCalled();
  await session.modelKey('back');
  expect(snap().picker).toBeUndefined();
});

it.each(['计划', '换人'])('型号清单查询期间让位给%s询问，迟到的回复不会重开选择', async kind => {
  const { session, engine, snap } = await setup();
  let finish!: () => void;
  engine.roles.listModels.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ models: [] }); }));
  session.submit('/model 主控');
  await vi.waitFor(() => expect(snap().picker).toMatchObject({ loading: true }));
  engine.advance.mockImplementationOnce(async (job, opts) => {
    if (kind === '计划') await opts.confirm!({ ...job, plan });
    else await opts.confirmFallback!(question);
    return job;
  });
  session.submit('任务');
  finish();
  await Promise.resolve();
  expect(snap().picker).toBeUndefined();
  expect(snap().plan ?? snap().ask).toBeDefined();
  session.interrupt();
  await session.whenIdle();
});
