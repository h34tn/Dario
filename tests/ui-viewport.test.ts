import { expect, it } from 'vitest';
import { afterChange, FOLLOW, maxOffset, scrollBy, scrollToTop, sliceView } from '../src/ui/viewport.js';

const lines = [...'甲乙丙丁戊己'];

it('内容不足一屏时显示全部，滚动仍然贴底', () => {
  expect(maxOffset(6, 8)).toBe(0);
  expect(scrollBy(FOLLOW, 10, 6, 8)).toEqual(FOLLOW);
  expect(sliceView(lines, 8, { offset: 9 })).toEqual({ visible: lines, above: 0, below: 0 });
});

it('贴底、上下滚动和跳到顶部都能得到对应行', () => {
  expect(sliceView(lines, 3, FOLLOW)).toEqual({ visible: [...'丁戊己'], above: 3, below: 0 });
  const up = scrollBy(FOLLOW, 2, 6, 3);
  expect(sliceView(lines, 3, up)).toEqual({ visible: [...'乙丙丁'], above: 1, below: 2 });
  expect(scrollBy(up, -1, 6, 3)).toEqual({ offset: 1 });
  expect(scrollBy(up, -99, 6, 3)).toEqual(FOLLOW);
  expect(scrollBy(up, 99, 6, 3)).toEqual(scrollToTop(6, 3));
  expect(sliceView(lines, 3, scrollToTop(6, 3)).visible).toEqual([...'甲乙丙']);
});

it('增加行时跟随底部或留在原文，改变高度后位置仍合法', () => {
  const longer = [...lines, '庚', '辛'];
  expect(afterChange(FOLLOW, 2, 8, 3)).toEqual(FOLLOW);
  const up = { offset: 2 };
  const next = afterChange(up, 2, 8, 3);
  expect(sliceView(longer, 3, next).visible).toEqual(sliceView(lines, 3, up).visible);
  expect(afterChange(next, 0, 8, 7)).toEqual({ offset: 1 });
  expect(afterChange(next, 0, 8, 2)).toEqual(next);
});

it('越界时仍能按可见行、上方、下方分清全部内容', () => {
  for (const content of [[], lines]) {
    for (const height of [-2, 0, 1, 3, 10]) {
      for (const offset of [-8, 0, 1, 99]) {
        const { visible, above, below } = sliceView(content, height, { offset });
        expect(visible.length).toBeLessThanOrEqual(Math.max(0, height));
        expect(Math.min(above, below)).toBeGreaterThanOrEqual(0);
        expect(above + visible.length + below).toBe(content.length);
        expect(visible).toEqual(content.slice(above, content.length - below));
      }
    }
  }
  expect(scrollToTop(0, -1)).toEqual(FOLLOW);
  expect(afterChange({ offset: 50 }, 3, 0, 0)).toEqual(FOLLOW);
});
