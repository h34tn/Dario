import { Box, render, Static, Text, useInput, usePaste } from 'ink';
import { useRef, useState } from 'react';
import { EMPTY_EDITOR } from './editor.js';
import { TextInput } from './TextInput.js';
import { GlyphContext, useScreen } from './screen.js';
import { clip, graphemes } from './text.js';
import { pickSymbols, toneColor, type Symbols } from './theme.js';

const intro = 'Dario 输入检查：在下面输入几行文字（包括中文、粘贴多行），每提交一行会显示程序实际收到的内容。\n输入 /exit 或按两次 Ctrl+C 退出。\n';

function receipt(text: string, count: number): string {
  const lines = text.split('\n');
  const size = lines.reduce((total, line) => total + graphemes(line).length, 0);
  const prefix = `第 ${count} 次  收到 `;
  if (lines.length > 1) {
    return `${prefix}${lines.length} 行（共 ${size} 个字）\n         第一行 ${JSON.stringify(lines[0])}`;
  }
  const points = Array.from(text);
  const hex = points.slice(0, 40).map(point => point.codePointAt(0)!.toString(16).toUpperCase());
  return `${prefix}${size} 个字  ${JSON.stringify(text)}\n         码点 ${hex.join(' ')}${points.length > 40 ? ' …' : ''}`;
}

interface InputTestProps {
  color: boolean;
  onExit: () => void;
  symbols?: Symbols;
}

export function InputTestScreen({ symbols, ...props }: InputTestProps) {
  const screen = <InputTestBody {...props} />;
  return symbols ? <GlyphContext.Provider value={symbols}>{screen}</GlyphContext.Provider> : screen;
}

function InputTestBody({ color, onExit }: InputTestProps) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const [items, setItems] = useState([intro]);
  const [warning, setWarning] = useState(false);
  const armed = useRef(false);
  function confirmExit(value: boolean) {
    armed.current = value;
    setWarning(value);
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (armed.current) onExit();
      else confirmExit(true);
    } else confirmExit(false);
  });
  usePaste(() => confirmExit(false));
  function submit(text: string) {
    if (text.trim() === '/exit') onExit();
    else setItems(previous => [...previous, receipt(text, previous.length)]);
  }
  return <Box flexDirection="column">
    <Static items={items}>{(item, index) => <Text key={index}>{item}</Text>}</Static>
    <TextInput state={editor} onChange={setEditor} onSubmit={submit} row={0} color={color} />
    <Text {...toneColor('dim', color)}>{clip('  上下键翻历史 · Ctrl+U 清空 · Ctrl+A / Ctrl+E 行首行尾', limit, wide, ellipsis)}</Text>
    {warning && <Text {...toneColor('warn', color)}>{clip('再按一次 Ctrl+C 退出', limit, wide, ellipsis)}</Text>}
  </Box>;
}

export async function runInputTest(opts: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  const { stdin, stdout, env } = opts;
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write('输入检查需要在终端里直接运行，不能通过管道。\n');
    return 2;
  }
  const app = render(<InputTestScreen symbols={pickSymbols(env)} color={!env.NO_COLOR} onExit={() => app.unmount()} />,
    { stdin, stdout, exitOnCtrlC: false });
  await app.waitUntilExit();
  return 0;
}
