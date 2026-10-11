import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = buildSync({ entryPoints: ['src/main.ts'], bundle: true, platform: 'browser', format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
class TFile { extension: string; constructor(public path: string) { this.extension = path.split('.').pop()!; } }
class TFolder { constructor(public path: string, public children: (TFile | TFolder)[]) {} }
class MarkdownView {
  file: TFile;
  editor: any;
  constructor(file: TFile, editor: any, private mode: 'source' | 'preview' = 'source') { this.file = file; this.editor = editor; }
  getMode() { return this.mode; }
  async save(): Promise<void> { throw new Error('A source view needs an explicit save mock'); }
}
const notices: string[] = [];
const modals: any[] = [];
class Modal {
  titleEl = { setText() {} };
  contentEl = { createEl() {}, empty() {} };
  constructor(public app: any) {}
  open() { modals.push(this); (this as any).onOpen(); }
  close() { (this as any).onClose(); }
}
class Setting {
  constructor(..._args: any[]) {}
  addButton(fn: any) { const button: any = { setButtonText: () => button, setWarning: () => button, onClick: () => button }; fn(button); return this; }
}
class Plugin {
  commands: any[] = [];
  events: any[] = [];
  async loadData() { return {}; }
  addCommand(command: any) { this.commands.push(command); }
  addSettingTab() {}
  registerEvent(event: any) { this.events.push(event); }
}
const module = { exports: {} as any };
runInNewContext(bundle, { module, exports: module.exports, console, require: (name: string) => {
  assert.equal(name, 'obsidian');
  return { Plugin, TFile, TFolder, MarkdownView, Modal, Setting, PluginSettingTab: class {}, Notice: class { constructor(text: string) { notices.push(text); } } };
} });
const PropertyPruner = module.exports.default;

function setup(files: TFile[], text = '---\nremove:\nkeep: value\n---\nBody\n') {
  const contents = new Map(files.map(file => [file.path, text]));
  const writes: string[] = [];
  const plugin = new PropertyPruner();
  plugin.app = {
    vault: {
      read: async (file: TFile) => contents.get(file.path),
      process: async (file: TFile, fn: any) => { const original = contents.get(file.path); const value = fn(original); if (value !== original) writes.push(file.path); contents.set(file.path, value); },
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
    },
    workspace: { getActiveFile: () => files[0], getLeavesOfType: () => [], on: (...args: any[]) => args },
  };
  return { plugin, contents, writes };
}

test('file and recursive folder selection excludes attachments and sibling folders', () => {
  const selected = new TFile('chosen/a.md'), nested = new TFile('chosen/nested/b.md');
  const target = new TFolder('chosen', [selected, new TFile('chosen/image.png'), new TFolder('chosen/nested', [nested])]);
  assert.deepEqual(Array.from(module.exports.markdownFiles(target)), [selected, nested]);
});

test('default confirmations cancel without writing when the modal is dismissed', async () => {
  const file = new TFile('a.md');
  const { plugin, writes } = setup([file]);
  const running = plugin.run(file);
  await new Promise(resolve => setImmediate(resolve));
  const modal = modals.pop();
  assert.ok(modal);
  modal.close();
  await running;
  assert.equal(writes.length, 0);
});

test('file and folder settings independently control confirmation', async () => {
  const file = new TFile('chosen/a.md');
  const { plugin, writes } = setup([file]);
  plugin.settings.confirmFiles = false;
  plugin.settings.confirmFolders = true;
  let confirmations = 0;
  plugin.confirm = async (_target: any, preview: any) => {
    confirmations++;
    assert.equal(preview.files.length, 1);
    return false;
  };
  await plugin.run(new TFolder('chosen', [file]));
  assert.equal(confirmations, 1);
  assert.equal(writes.length, 0);
  await plugin.run(file);
  assert.deepEqual(writes, ['chosen/a.md']);
  assert.equal(confirmations, 1);
});

test('recursive run prunes selected descendants only', async () => {
  const a = new TFile('chosen/a.md'), b = new TFile('chosen/nested/b.md'), outside = new TFile('other/c.md');
  const { plugin, contents, writes } = setup([a, b, outside]);
  plugin.settings.confirmFolders = false;
  await plugin.run(new TFolder('chosen', [a, new TFolder('chosen/nested', [b])]));
  assert.deepEqual(writes, [a.path, b.path]);
  assert.ok(contents.get(outside.path)?.includes('remove:'));
});

test('preserves a property filled while confirmation is open', async () => {
  const file = new TFile('a.md');
  const { plugin, contents, writes } = setup([file]);
  plugin.confirm = async () => { contents.set(file.path, '---\nremove: now filled\n---\nNew body'); return true; };
  await plugin.run(file);
  assert.equal(writes.length, 0);
  assert.ok(contents.get(file.path)?.includes('now filled'));
});

test('folder run rechecks reordered metadata and preserves new properties and body edits', async () => {
  const a = new TFile('chosen/a.md'), b = new TFile('chosen/b.md');
  const { plugin, contents, writes } = setup([a, b]);
  plugin.confirm = async () => {
    contents.set(a.path, '---\nkeep: value\nid: generated\nremove:\nnewBlank:\n---\nEdited body\n');
    return true;
  };
  await plugin.run(new TFolder('chosen', [a, b]));
  assert.deepEqual(writes, [a.path, b.path]);
  assert.equal(contents.get(a.path), '---\nkeep: value\nid: generated\nnewBlank:\n---\nEdited body\n');
});

test('folder run rechecks the latest open editor buffer after confirmation', async () => {
  const a = new TFile('chosen/a.md'), b = new TFile('chosen/b.md');
  const { plugin, contents, writes } = setup([a, b]);
  let buffer = '---\nremove:\nkeep: value\n---\nBody\n';
  let editorWrites = 0;
  const editor = { getValue: () => buffer, offsetToPos: (offset: number) => offset, replaceRange: (text: string, from: number, to: number) => {
    editorWrites++;
    buffer = buffer.slice(0, from) + text + buffer.slice(to);
  } };
  const view = new MarkdownView(a, editor);
  view.save = async () => { contents.set(a.path, buffer); };
  plugin.app.workspace.getLeavesOfType = () => [{ view }];
  plugin.confirm = async () => {
    buffer = '---\nkeep: value\nremove:\nnewBlank:\n---\nEdited unsaved body\n';
    return true;
  };
  await plugin.run(new TFolder('chosen', [a, b]));
  assert.equal(editorWrites, 0);
  assert.equal(contents.get(a.path), '---\nkeep: value\nnewBlank:\n---\nEdited unsaved body\n');
  assert.deepEqual(writes, [a.path, b.path]);
});

test('skips malformed YAML introduced after confirmation without overwriting it', async () => {
  const file = new TFile('a.md');
  const { plugin, contents, writes } = setup([file]);
  plugin.confirm = async () => { contents.set(file.path, '---\nremove:\nbroken: [\n---\nNew body'); return true; };
  await plugin.run(file);
  assert.equal(writes.length, 0);
  assert.ok(contents.get(file.path)?.includes('broken: ['));
});

test('saves the current editor buffer before pruning and preserves unsaved body text', async () => {
  const file = new TFile('a.md');
  const { plugin, contents, writes } = setup([file]);
  let buffer = '---\nremove:\nkeep: unsaved\n---\nUnsaved body\n';
  let editorWrites = 0;
  const editor = { getValue: () => buffer, offsetToPos: (offset: number) => offset, replaceRange: (text: string, from: number, to: number) => {
    editorWrites++;
    buffer = buffer.slice(0, from) + text + buffer.slice(to);
  } };
  const view = new MarkdownView(file, editor);
  let saves = 0;
  view.save = async () => { saves++; contents.set(file.path, buffer); };
  plugin.app.workspace.getLeavesOfType = () => [{ view }];
  plugin.settings.confirmFiles = false;
  await plugin.run(file);
  assert.equal(contents.get(file.path), '---\nkeep: unsaved\n---\nUnsaved body\n');
  assert.equal(saves, 1);
  assert.equal(editorWrites, 0);
  assert.deepEqual(writes, [file.path]);
});

test('blocked editor transactions cannot prevent folder pruning or produce false success counts', async () => {
  const source = '---\nkeep: value\n' + Array.from({ length: 15 }, (_, i) => `blank${i}:\n`).join('') + '---\nBody\n';
  const files = ['Test 1', 'Test 2', 'Test 3'].map(name => new TFile(`chosen/${name}.md`));
  const { plugin, contents, writes } = setup(files, source);
  const views = files.map((file, i) => {
    const editor = { getValue: () => source, offsetToPos: (offset: number) => offset, replaceRange() { /* actual Properties-widget transaction filter rejects this edit */ } };
    const view = new MarkdownView(file, editor, i === 2 ? 'preview' : 'source');
    view.save = async () => { contents.set(file.path, source); };
    return view;
  });
  plugin.app.workspace.getLeavesOfType = () => views.map(view => ({ view }));
  plugin.settings.confirmFolders = false;
  await plugin.run(new TFolder('chosen', files));
  assert.deepEqual(writes, files.map(file => file.path));
  for (const file of files) assert.equal(contents.get(file.path), '---\nkeep: value\n---\nBody\n');
  assert.equal(notices[notices.length - 1], 'Property Pruner: removed 45 properties from 3 files.');
});

test('a rejected or overwritten file write is not counted as a successful removal', async () => {
  const file = new TFile('a.md');
  const { plugin, contents } = setup([file]);
  plugin.app.vault.process = async (_file: TFile, transform: any) => { transform(contents.get(file.path)); };
  plugin.settings.confirmFiles = false;
  await plugin.run(file);
  assert.ok(notices[notices.length - 1].startsWith('Property Pruner: removed 0 properties from 0 files.'));
  assert.ok(notices[notices.length - 1].includes('unverified removals'));
  assert.ok(contents.get(file.path)?.includes('remove:'));
});

test('read-back counts only the removed keys and tolerates other metadata changes', async () => {
  const file = new TFile('a.md');
  const { plugin, contents } = setup([file], '---\na:\nb:\nkeep: value\n---\nBody\n');
  plugin.app.vault.process = async (_file: TFile, transform: any) => {
    const next = transform(contents.get(file.path));
    contents.set(file.path, next.replace('keep: value', 'keep: value\na:\nid: generated'));
  };
  plugin.settings.confirmFiles = false;
  await plugin.run(file);
  assert.ok(notices[notices.length - 1].startsWith('Property Pruner: removed 1 property from 1 file.'));
  assert.ok(contents.get(file.path)?.includes('id: generated'));
});

test('active-file command supports Reading view and prunes without accessing its editor', async () => {
  const file = new TFile('a.md');
  const { plugin, contents, writes } = setup([file]);
  const editor = { getValue() { throw new Error('Reading-view editor must not be read'); }, replaceRange() { throw new Error('Reading-view editor must not be edited'); } };
  const view = new MarkdownView(file, editor, 'preview');
  plugin.app.workspace.getLeavesOfType = () => [{ view }];
  await plugin.onload();
  assert.equal(plugin.commands[0].checkCallback(true), true);
  plugin.settings.confirmFiles = false;
  await plugin.run(file);
  assert.deepEqual(writes, [file.path]);
  assert.equal(contents.get(file.path), '---\nkeep: value\n---\nBody\n');
  assert.equal(view.getMode(), 'preview');
});

test('folder action prunes every Reading-view note and preserves changes since preview', async () => {
  const files = ['Test 1', 'Test 2', 'Test 3'].map(name => new TFile(`chosen/${name}.md`));
  const { plugin, contents, writes } = setup(files);
  const editor = { getValue() { throw new Error('Reading-view editor must not be read'); }, replaceRange() { throw new Error('Reading-view editor must not be edited'); } };
  const views = files.map(file => new MarkdownView(file, editor, 'preview'));
  plugin.app.workspace.getLeavesOfType = () => views.map(view => ({ view }));
  plugin.confirm = async () => {
    contents.set(files[0].path, '---\nkeep: value\nremove:\nid: generated\n---\nUpdated body\n');
    return true;
  };
  await plugin.run(new TFolder('chosen', files));
  assert.deepEqual(writes, files.map(file => file.path));
  assert.equal(contents.get(files[0].path), '---\nkeep: value\nid: generated\n---\nUpdated body\n');
  assert.ok(views.every(view => view.getMode() === 'preview'));
});

test('registers active-file command and file/folder context menu action', async () => {
  const file = new TFile('a.md');
  const { plugin } = setup([file]);
  await plugin.onload();
  assert.equal(plugin.commands[0].id, 'prune-active-file');
  assert.equal(plugin.commands[0].checkCallback(true), true);
  const event = plugin.events[0];
  assert.equal(event[0], 'file-menu');
  const titles: string[] = [];
  const menu = { addItem(fn: any) { const item: any = { setTitle: (title: string) => { titles.push(title); return item; }, setIcon: () => item, onClick: () => item }; fn(item); } };
  event[1](menu, file);
  event[1](menu, new TFolder('chosen', []));
  event[1](menu, new TFile('image.png'));
  assert.deepEqual(titles, ['Remove blank properties', 'Remove blank properties in folder']);
});
