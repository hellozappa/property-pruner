import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';

export interface PruneResult {
  content: string;
  removed: string[];
  yamlStart: number;
  yamlEnd: number;
  replacement: string;
  skipped?: string;
}

/** Delete source ranges rather than serializing the remaining frontmatter. */
export function pruneFrontmatter(content: string): PruneResult {
  const unchanged = (skipped?: string): PruneResult => ({
    content, removed: [], yamlStart: 0, yamlEnd: 0, replacement: '', skipped,
  });
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (!opening) return unchanged();
  const rest = content.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) return unchanged('Frontmatter has no closing delimiter.');
  const yamlStart = opening[0].length;
  const yamlEnd = yamlStart + closing.index;
  const source = content.slice(yamlStart, yamlEnd);
  const doc = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) return unchanged('Invalid or unsupported YAML.');
  if (doc.contents === null) return unchanged();
  if (!isMap(doc.contents)) return unchanged('Frontmatter must be a property mapping.');
  if (doc.contents.flow) return unchanged('Flow-style frontmatter mappings are not supported.');

  // Removing an anchor can invalidate a value elsewhere in the same document.
  let references = false;
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && node.anchor)) references = true;
  });
  if (references) return unchanged('YAML anchors and aliases are left unchanged.');

  const ranges: { start: number; end: number; name: string }[] = [];
  const lineEnd = (offset: number): number => {
    const newline = source.indexOf('\n', offset);
    return newline < 0 ? source.length : newline + 1;
  };
  for (const [index, pair] of doc.contents.items.entries()) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.key.range) {
      return unchanged('Frontmatter contains a non-string or unsupported property key.');
    }
    if (!(pair.value === null || (isScalar(pair.value) && pair.value.value === null))) continue;
    const start = source.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
    if (!/^[ \t]*$/.test(source.slice(start, pair.key.range[0]))) {
      return unchanged('Explicit YAML keys are left unchanged.');
    }
    const end = lineEnd(Math.max(pair.key.range[1], pair.value?.range?.[1] ?? pair.key.range[1]));
    const nextKey = doc.contents.items[index + 1]?.key;
    if (isNode(nextKey) && nextKey.range && end > nextKey.range[0]) {
      return unchanged('Property source ranges overlap.');
    }
    ranges.push({ start, end, name: pair.key.value });
  }
  if (!ranges.length) return unchanged();
  let replacement = source;
  for (const range of [...ranges].reverse()) {
    replacement = replacement.slice(0, range.start) + replacement.slice(range.end);
  }
  const verified = parseDocument(replacement);
  if (verified.errors.length || verified.warnings.length) return unchanged('Pruned YAML failed validation.');
  return {
    content: content.slice(0, yamlStart) + replacement + content.slice(yamlEnd),
    removed: ranges.map(range => range.name), yamlStart, yamlEnd, replacement,
  };
}
