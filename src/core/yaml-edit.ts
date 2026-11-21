import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq, parseDocument, stringify, type ParsedNode, type YAMLMap } from 'yaml';
import { displayWidth } from './display-width.js';
import { ConfigError, withLock, writeFileAtomic } from './util.js';

interface Change { keys: string[]; value: string | string[] | null | undefined }

function render(value: unknown, flow = false): string {
  return stringify(value, { collectionStyle: flow ? 'flow' : 'block', lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

function scalarText(value: string, style?: string): string {
  const defaultStringType = style === 'QUOTE_SINGLE' || style === 'QUOTE_DOUBLE' ? style : 'PLAIN';
  return stringify([value], { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0,
    defaultStringType }).trimEnd().slice(1, -1);
}

/** 只复制目标路径；即使原文件有 YAML 别名，其他路径的预期值也保持原样。 */
function updatedData(data: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  const copy = { ...data as Record<string, unknown> };
  if (!rest.length && value === undefined) delete copy[key];
  else return { ...copy, [key]: updatedData(copy[key], rest, value) };
  return copy;
}

function edit(source: string, { keys, value }: Change, file: string): string {
  const doc = parseDocument(source, { keepSourceTokens: true });
  const fail = () => new ConfigError(`无法安全地局部修改配置：${file}（${keys.join('.')}）`);
  if (doc.errors.length) throw new ConfigError(`配置文件有误：${file}\n${doc.errors[0]!.message}`);
  const original = doc.getIn(keys);
  if (value === undefined || (value === null ? !doc.hasIn(keys) : isDeepStrictEqual(original, value))) return source;

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = (pos: number) => source.lastIndexOf('\n', pos - 1) + 1;
  const indent = (pos: number) => ' '.repeat(pos - lineStart(pos));
  const splice = (from: number, to: number, text: string) => source.slice(0, from) + text + source.slice(to);
  // 块集合的 range 可能包含尾部注释，沿最后一项找到真正的内容行。
  function endOfValue(node: ParsedNode): number {
    if (isMap(node) && !node.flow) {
      const last = node.items.at(-1)!;
      return endOfValue(last.value ?? last.key);
    }
    if (isSeq(node) && !node.flow) return endOfValue(node.items.at(-1)!);
    return node.range[1];
  }
  function afterLine(pos: number): number {
    if (pos && source[pos - 1] === '\n') return pos;
    const next = source.indexOf('\n', pos);
    return next < 0 ? source.length : next + 1;
  }
  function appendLines(pos: number, lines: string) {
    const at = afterLine(pos);
    const terminated = at > 0 && source[at - 1] === '\n';
    return splice(at, at, (at && !terminated ? eol : '') + lines + (terminated ? eol : ''));
  }

  let node = doc.contents;
  let depth = 0;
  const parents = [];
  while (isMap(node) && depth < keys.length) {
    const index = node.items.findIndex(p => isScalar(p.key) && p.key.value === keys[depth]);
    if (index < 0) break;
    const pair = node.items[index]!;
    parents.push({ map: node, index, key: pair.key });
    node = pair.value;
    depth++;
  }

  // 显式空值有 null、Null、~ 等写法。扩展时把原词留在同一行的注释中，撤销可恢复原拼写。
  const nullComment = ' # 原空值：';
  function savedNull(map: YAMLMap.Parsed): boolean {
    if (!map.flow || !source.startsWith(nullComment, map.range[1])) return false;
    return /^(?:null|Null|NULL|~)(?=[ \t\r\n#]|$)/.test(source.slice(map.range[1] + nullComment.length));
  }

  let expectedKeys = keys;
  let expectedValue: Change['value'] = value;
  let result: string;
  if (value === null) {
    if (depth !== keys.length) throw fail();
    // 在原有空流式映射里添加首项时带上尾逗号，撤销时保留原来的括号。
    const hasTrailingComma = (map: YAMLMap.Parsed) => {
      const last = map.items.at(-1)!;
      return map.flow && source[endOfValue(last.value ?? last.key)] === ',';
    };
    while (depth > 1) {
      const parent = parents[depth - 1]!.map;
      if (parent.items.length !== 1 || hasTrailingComma(parent) || savedNull(parent)) break;
      const owner = parents[depth - 2]!;
      if (parent.flow && lineStart(parent.range[0]) > owner.key.range[0]) break;
      depth--;
    }
    const { map, index, key } = parents[depth - 1]!;
    const last = map.items[index]!.value ?? key;
    const owner = parents[depth - 2];
    const clearValue = map.flow && map.items.length === 1 && !hasTrailingComma(map) && owner && lineStart(map.range[0]) > owner.key.range[0];
    const restoreNull = map.items.length === 1 && savedNull(map);
    if (restoreNull) {
      result = splice(map.range[0], map.range[1] + nullComment.length, '');
    } else if (clearValue) {
      const start = lineStart(map.range[0]);
      const end = afterLine(map.range[1]);
      result = splice(end === source.length && !source.endsWith('\n') ? start - eol.length : start, end, '');
    } else if (map.flow) {
      const previous = map.items[index - 1]?.value;
      const next = map.items[index + 1];
      const start = previous ? previous.range[1] : key.range[0];
      const end = !previous && next ? next.key.range[0]
        : last.range[1] + (map.items.length === 1 && hasTrailingComma(map) ? 1 : 0);
      if (/[#\n]/.test(source.slice(start, key.range[0]) + source.slice(last.range[1], end))) throw fail();
      result = splice(start, end, '');
    } else {
      let start = lineStart(key.range[0]);
      const end = afterLine(endOfValue(last));
      const comments = source.slice(start, end).split(/(?<=\n)/).filter(line => /^(?:\s*$|[ \t]*#)/.test(line)).join('');
      if (end === source.length && !source.endsWith('\n') && start > 0) start -= eol.length;
      result = splice(start, end, comments);
    }
    expectedKeys = keys.slice(0, restoreNull || clearValue ? depth - 1 : depth);
    expectedValue = restoreNull || clearValue ? null : undefined;
  } else if (depth === keys.length && node) {
    if (isSeq(node) && Array.isArray(value)) {
      // 调整候选顺序时逐项替换，保留列表的括号、换行与行内注释。
      if (!node.items.length || !value.length) throw fail();
      const extra = value.slice(node.items.length);
      const end = endOfValue(node.items.at(-1)!);
      result = source;
      if (value.length < node.items.length) {
        const kept = endOfValue(node.items[value.length - 1]!);
        const from = node.flow ? kept : afterLine(kept);
        const to = node.flow ? end : afterLine(end);
        if (source.slice(from, to).includes('#')) throw fail();
        result = splice(from, to, '');
      } else if (extra.length) {
        result = node.flow ? splice(end, end, ', ' + extra.map(v => scalarText(v)).join(', '))
          : appendLines(end, extra.map(v => indent(node!.range[0]) + '- ' + render(v)).join(eol));
      }
      for (let i = Math.min(node.items.length, value.length) - 1; i >= 0; i--) {
        const item = node.items[i];
        if (!isScalar(item)) throw fail();
        if (item.value !== value[i]) result = result.slice(0, item.range[0]) + scalarText(value[i]!, item.type) + result.slice(item.range[1]);
      }
    } else {
      if (!isScalar(node) || typeof value !== 'string') throw fail();
      const [start, end] = node.range;
      const replacement = scalarText(value, node.type);
      if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') throw fail();
      const gap = /^ {2,}(?=#)/.exec(source.slice(end))?.[0] ?? '';
      const padding = gap && ' '.repeat(Math.max(1, gap.length + displayWidth(source.slice(start, end)) - displayWidth(replacement)));
      result = splice(start, end + gap.length, replacement + padding);
    }
  } else {
    let branch: unknown = value;
    for (const k of keys.slice(depth).reverse()) branch = { [k]: branch };
    if (isMap(node) && node.flow) {
      const last = node.items.at(-1);
      const at = last ? endOfValue(last.value ?? last.key) : node.range[0] + 1;
      result = splice(at, at, (last ? ', ' : '') + render(branch, true).slice(1, -1) + (last ? '' : ','));
    } else {
      let at: number;
      let padding: string;
      if (isMap(node)) {
        at = endOfValue(node);
        padding = indent(node.items[0]!.key.range[0]);
      } else {
        if (node && !(isScalar(node) && node.value === null)) throw fail();
        const parent = parents.at(-1);
        at = parent ? parent.key.range[1] : source.length;
        padding = parent ? indent(parent.key.range[0]) + '  ' : '';
      }
      if (isScalar(node) && node.range[1] > node.range[0]) {
        result = splice(node.range[0], node.range[0], render(branch, true) + nullComment);
      } else {
        const lines = render(branch, !!parents.length && isScalar(node)).split('\n').map(line => padding + line).join(eol);
        result = appendLines(at, lines);
      }
    }
  }
  const checked = parseDocument(result);
  // 删除最后一项后，空文件在配置加载时与空映射等价。
  const expected = updatedData(doc.toJS(), expectedKeys, expectedValue);
  if (checked.errors.length || !isDeepStrictEqual(checked.toJS() ?? {}, expected ?? {})) throw fail();
  return result;
}

/** 在同一把锁里读取、局部编辑和校验所有字段，最后一次性写回。 */
export function editYamlFile(file: string, changes: Change[], allowCreate = false): void {
  withLock(file + '.lock', () => {
    const source = allowCreate && !fs.existsSync(file) ? '' : fs.readFileSync(file, 'utf8');
    const result = changes.reduce((text, change) => edit(text, change, file), source);
    if (result !== source) writeFileAtomic(file, result);
  });
}
