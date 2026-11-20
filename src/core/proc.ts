import { spawnSync } from 'node:child_process';

/** 终止一个进程及其全部子进程。进程已不存在时静默返回。 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    // 子进程以独立进程组启动，负号表示整组
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
}
