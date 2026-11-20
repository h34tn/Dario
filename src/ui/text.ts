import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 按用户看到的一个字切分，保留表情和组合字符。 */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment);
}

/** 终端显示宽度，wide 为真时宽度不定的字符按两格算。 */
export function displayWidth(text: string, wide = false): number {
  return stringWidth(text, { ambiguousIsNarrow: !wide });
}

function fittingPrefix(text: string, max: number, wide: boolean): string {
  let result = '';
  for (const { segment } of segmenter.segment(text)) {
    max -= displayWidth(segment, wide);
    if (max < 0) break;
    result += segment;
  }
  return result;
}

/** 按字素截断，末尾的省略号也计入格数。 */
export function clip(text: string, max: number, wide: boolean, ellipsis: string): string {
  if (max <= 0) return '';
  if (displayWidth(text, wide) <= max) return text;
  const remaining = max - displayWidth(ellipsis, wide);
  if (remaining < 0) return fittingPrefix(ellipsis, max, wide);
  return fittingPrefix(text, remaining, wide) + ellipsis;
}

/** 按字素硬折行，保留原有的换行与空行。 */
export function wrapText(text: string, max: number, wide: boolean): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let line = '';
    let width = 0;
    for (const { segment } of segmenter.segment(paragraph)) {
      const size = displayWidth(segment, wide);
      if (width + size > max && line) {
        lines.push(line);
        line = '';
        width = 0;
      }
      if (size > max) {
        if (max > 0) lines.push('?');
        continue;
      }
      width += size;
      line += segment;
    }
    if (line || !paragraph || max <= 0) lines.push(line);
  }
  return lines;
}
