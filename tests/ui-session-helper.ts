import { vi } from 'vitest';
import type { Engine } from '../src/core/engine.js';
import type { Job, ProgressEvent } from '../src/core/types.js';
import { Session, type SessionOptions } from '../src/ui/session.js';

export const step = { index: 1, kind: 'step', role: 'coder', roleLabel: '实现（coder）', agent: 'codex' } as const;
export const plan = { summary: '', steps: [{ role: 'coder', task: '改文件', writes: true }] };

export async function setup(options?: Partial<SessionOptions>) {
  const views = [
    ['review', '审查', 'claude'], ['coder', '实现', 'codex'], ['lead', '主控', 'claude'],
  ].map(([id, label, holder]) => ({ id, alias: [label], holder, access: id === 'coder' ? 'write' : 'read-only',
    candidates: [{ agent: holder, state: id === 'coder' ? 'unavailable' : 'ok' }] }));
  const listeners = new Set<(e: ProgressEvent) => void>();
  let count = 0;
  const job = { id: 'J0001', task: '任务', status: 'done', steps: [], changedFiles: [], warnings: [],
    result: { conclusion: '**成功**', changedFiles: ['a.ts'], warnings: ['留意'], branch: '分支' } } as unknown as Job;
  const engine = {
    project: { root: '/项目/rise', settings: { leadRole: 'lead', reviewRole: 'review' } },
    roles: { label: (id: string) => views.find(v => v.id === id)?.alias[0] ?? id, fallback: 'auto' },
    rolesView: vi.fn(async () => views),
    agentsView: vi.fn(async () => [{ id: 'codex', installed: true, enabled: true, version: '版本' }]),
    onProgress(fn: (event: ProgressEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    create: vi.fn<Engine['create']>(req => ({ ...job, ...req, id: 'J' + String(++count).padStart(4, '0') })),
    advance: vi.fn<Engine['advance']>(async j => j), approve: vi.fn(async (id: string) => ({ ...job, id })),
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
