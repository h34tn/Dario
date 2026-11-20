import { useStdout } from 'ink';
import { createContext, useContext } from 'react';

export interface ScreenInfo {
  columns: number;
  rows: number;
  wide: boolean;
  ellipsis: string;
}

export const GlyphContext = createContext({ wide: false, ellipsis: '…' });

/** 读取当前输出流的行列数以及终端的字符宽度约定。 */
export function useScreen(): ScreenInfo {
  const { stdout } = useStdout();
  const { wide, ellipsis } = useContext(GlyphContext);
  const columns = 'columns' in stdout && typeof stdout.columns === 'number' ? stdout.columns : 80;
  const rows = 'rows' in stdout && typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24;
  return { columns, rows, wide, ellipsis };
}
