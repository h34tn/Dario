import { vi } from 'vitest';
import type { Engine } from '../src/core/engine.js';
import type { Job, ProgressEvent } from '../src/core/types.js';
import { Session, type SessionOptions } from '../src/ui/session.js';

export const step = { index: 1, kind: 'step', role: 'coder', roleLabel: '实现（coder）', agent: 'codex' } as const;
export const plan = { summary: '', steps: [{ role: 'coder', task: '改文件', writes: true }] };
/** 主控的首选 claude 额度用尽，备选是 codex。 */
export const question = { jobId: 'J0001', role: 'lead', roleLabel: '主控（lead）', from: [{ agent: 'claude', model: 'claude-x', reason: '额度用尽' }], to: { agent: 'codex', model: 'gpt-x' } };

/** 角色表的一行；holder 为空表示没有可用候选，state 是首选候选的状态。 */
export interface RoleRow { id: string; label: string; holder?: string; access: 'write' | 'read-only'; state: 'ok' | 'unavailable' }

export const DEFAULT_ROWS: RoleRow[] = [
  ['lead', '主控', 'claude'], ['coder', '实现', 'codex'], ['tester', '测试', 'codex'],
  ['review', '审查', 'claude'], ['helper', '杂活', 'claude'],
].map(([id, label, holder]) => ({ id: id!, label: label!, holder, access: id === 'coder' || id === 'tester' ? 'write' : 'read-only',
  state: id === 'coder' ? 'unavailable' : 'ok' }));

export async function setup(options?: Partial<SessionOptions>, rows: RoleRow[] = DEFAULT_ROWS,
  agents: Array<{ id: string; model?: string }> = [{ id: 'codex' }]) {
  const views = rows.map(({ id, label, holder, access, state }) => ({ id, alias: [label], holder, access,
    candidates: [{ agent: holder ?? 'a9', state }] }));
  const listeners = new Set<(e: ProgressEvent) => void>();
  let count = 0;
  const job = { id: 'J0001', task: '任务', status: 'done', steps: [], changedFiles: [], warnings: [],
    result: { conclusion: '**成功**', changedFiles: ['a.ts'], warnings: ['留意'], branch: '分支' } } as unknown as Job;
  const engine = {
    project: { root: '/项目/rise', settings: { leadRole: 'lead', reviewRole: 'review' } },
    roles: { label: (id: string) => views.find(v => v.id === id)?.alias[0] ?? id, fallback: 'auto' },
    rolesView: vi.fn(async () => views),
    agentsView: vi.fn(async () => agents.map(a => ({ ...a, installed: true, enabled: true, version: '版本' }))),
    onProgress(fn: (event: ProgressEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    create: vi.fn<Engine['create']>(req => ({ ...job, ...req, id: 'J' + String(++count).padStart(4, '0') })),
    advance: vi.fn<Engine['advance']>(async j => j), approve: vi.fn<Engine['approve']>(async id => ({ ...job, id })),
    cancel: vi.fn(() => job), jobs: vi.fn(() => [job]), job: vi.fn(() => job),
    resetRole: vi.fn(() => '已恢复'), setRole: vi.fn(() => '已指定'), health: vi.fn(async () => [{ agent: 'codex', ok: true, detail: '正常' }]),
  };
  const session = new Session({ engine: engine as unknown as Engine, color: false, senderId: '测试', ...options });
  await session.start();
  const snap = session.getSnapshot;
  const log = () => snap().history.map(h => 'text' in h ? h.text : h.step.role).join('\n');
  const emit = (event: ProgressEvent) => listeners.forEach(fn => fn(event));
  function hold() {
    let finish!: () => void;
    engine.advance.mockImplementationOnce(j => new Promise(resolve => { finish = () => resolve(j); }));
    return () => finish();
  }
  return { session, engine, emit, hold, job, snap, log };
}
