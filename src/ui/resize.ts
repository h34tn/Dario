export interface ResizeHandlers {
  /** 一轮大小变化开始（第一次 resize 事件），同步调用。 */
  onStart: () => void;
  /** 大小稳定下来（最后一次 resize 事件之后 delayMs 毫秒）。 */
  onSettle: () => void;
}

/** 监听终端大小变化，把一连串 resize 事件归并成“开始”和“稳定”两个时刻。返回取消监听的函数。 */
export function watchResize(
  stream: Pick<NodeJS.WriteStream, 'prependListener' | 'removeListener'> & { _refreshSize?: () => void },
  handlers: ResizeHandlers,
  delayMs = 300,
  pollMs = 100,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  function resize() {
    const first = timer === undefined;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      handlers.onSettle();
    }, delayMs);
    timer.unref();
    if (first) handlers.onStart();
  }
  stream.prependListener('resize', resize);
  let poll: NodeJS.Timeout | undefined;
  if (pollMs > 0 && stream._refreshSize) {
    poll = setInterval(() => {
      try { stream._refreshSize?.(); } catch { clearInterval(poll); }
    }, pollMs);
    poll.unref();
  }
  return () => {
    clearInterval(poll);
    stream.removeListener('resize', resize);
    clearTimeout(timer);
  };
}
