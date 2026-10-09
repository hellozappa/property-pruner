import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { pruneFrontmatter } from '../src/prune';

const note = (yaml: string) => `---\n${yaml}---\n\nBody with --- and [[links]].\n`;

test('removes missing values and YAML null spellings only', () => {
  const result = pruneFrontmatter(note('missing:\nnullValue: null\ntilde: ~\nupper: NULL\ntitle: Keep me\n'));
  assert.deepEqual(result.removed, ['missing', 'nullValue', 'tilde', 'upper']);
  assert.equal(result.content, note('title: Keep me\n'));
});

test('preserves strings, empty collections, zero, false, dates and nested nulls verbatim', () => {
  const source = note('empty: ""\nspaces: "  "\nquoted: "null"\nlist: []\nmap: {}\nzero: 0\nflag: false\ndate: 2026-10-08\nnested:\n  child: null\nlistWithNull: [null]\nblock: |\n  \nremove:\n');
  assert.equal(pruneFrontmatter(source).content, source.replace('remove:\n', ''));
});

test('preserves unrelated comments, spacing, quoting, order and body bytes', () => {
  const source = note('# Header\nremove: # attached\n\n# Keep comment\nkeep:   "[[Note]]" # comment\n');
  assert.equal(pruneFrontmatter(source).content, source.replace('remove: # attached\n', ''));
});

test('handles CRLF and BOM without normalizing either', () => {
  const source = '\uFEFF' + note('remove:\nkeep: value\n').split('\n').join('\r\n');
  assert.equal(pruneFrontmatter(source).content, source.replace('remove:\r\n', ''));
});

test('keeps both delimiters when the last property is removed', () => {
  assert.equal(pruneFrontmatter(note('remove:\n')).content, note(''));
});

test('leaves notes without frontmatter and body YAML unchanged', () => {
  for (const source of ['Body\n---\nremove:\n---\n', '', '\n---\nremove:\n---\n']) {
    assert.equal(pruneFrontmatter(source).content, source);
  }
});

test('leaves malformed, duplicate-key and unterminated YAML unchanged', () => {
  for (const source of [note('remove:\nbroken: [\n'), note('same:\nsame: value\n'), '---\nremove:\n']) {
    const result = pruneFrontmatter(source);
    assert.equal(result.content, source);
    assert.ok(result.skipped);
  }
});

test('leaves aliases, anchors, flow roots and unsupported keys unchanged', () => {
  for (const yaml of ['remove: &blank null\nkeep: *blank\n', 'remove:\nkeep: &a hello\n', '{remove: null, keep: hello}\n', '1: null\n', '? explicit\n: null\n', '- null\n']) {
    const result = pruneFrontmatter(note(yaml));
    assert.ok(result.skipped, yaml);
    assert.equal(result.content, note(yaml));
  }
});

test('handles quoted keys and nulls on the following line', () => {
  const source = note('"key: with colon": null\nmultiline:\n  null\nkeep: fine\n');
  assert.equal(pruneFrontmatter(source).content, note('keep: fine\n'));
});

test('retains valid Unicode keys and is idempotent', () => {
  const result = pruneFrontmatter(note('🦉:\nkeep: café\n'));
  assert.deepEqual(result.removed, ['🦉']);
  assert.equal(pruneFrontmatter(result.content).content, result.content);
  assert.equal(parseDocument(result.replacement).errors.length, 0);
});

test('supports closing delimiter at EOF and trailing whitespace', () => {
  assert.equal(pruneFrontmatter('--- \nremove:\n---').content, '--- \n---');
});
