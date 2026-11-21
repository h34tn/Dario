import stringWidth from 'string-width';

/** 终端显示宽度，wide 为真时宽度不定的字符按两格算。 */
export function displayWidth(text: string, wide = false): number {
  return stringWidth(text, { ambiguousIsNarrow: !wide });
}
