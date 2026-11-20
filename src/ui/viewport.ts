export interface ViewState { offset: number }
export const FOLLOW: ViewState = Object.freeze({ offset: 0 });

function count(value: number): number {
  return Math.max(0, Math.trunc(value) || 0);
}

export function maxOffset(total: number, height: number): number {
  return count(count(total) - count(height));
}

function clamp(offset: number, total: number, height: number): number {
  return Math.min(count(offset), maxOffset(total, height));
}

export function scrollBy(state: ViewState, delta: number, total: number, height: number): ViewState {
  const offset = clamp(state.offset, total, height);
  return { offset: clamp(offset + (Math.trunc(delta) || 0), total, height) };
}

export function scrollToTop(total: number, height: number): ViewState {
  return { offset: maxOffset(total, height) };
}

export function afterChange(state: ViewState, added: number, total: number, height: number): ViewState {
  return count(state.offset) ? { offset: clamp(state.offset + added, total, height) } : FOLLOW;
}

export function sliceView(lines: string[], height: number, state: ViewState): { visible: string[]; above: number; below: number } {
  const below = clamp(state.offset, lines.length, height);
  const end = lines.length - below;
  const above = Math.max(0, end - count(height));
  return { visible: lines.slice(above, end), above, below };
}
