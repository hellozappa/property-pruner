import {
  App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting,
  TAbstractFile, TFile, TFolder,
} from 'obsidian';
import { frontmatterKeys, pruneFrontmatter, PruneResult } from './prune';

interface PrunerSettings { confirmFiles: boolean; confirmFolders: boolean }
export const DEFAULT_SETTINGS: PrunerSettings = { confirmFiles: true, confirmFolders: true };
interface PlannedFile { file: TFile; original: string; result: PruneResult }
interface Preview { files: PlannedFile[]; scanned: number; skipped: number }

export function markdownFiles(target: TAbstractFile): TFile[] {
  if (target instanceof TFile) return target.extension.toLowerCase() === 'md' ? [target] : [];
  if (!(target instanceof TFolder)) return [];
  return target.children.flatMap(child => markdownFiles(child));
}

export default class PropertyPruner extends Plugin {
  settings: PrunerSettings = { ...DEFAULT_SETTINGS };
  private busy = false;
  private disposed = false;

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.settings = {
      confirmFiles: typeof saved?.confirmFiles === 'boolean' ? saved.confirmFiles : true,
      confirmFolders: typeof saved?.confirmFolders === 'boolean' ? saved.confirmFolders : true,
    };
    this.addSettingTab(new PrunerSettingTab(this.app, this));
    this.addCommand({
      id: 'prune-active-file', name: 'Remove blank properties from active file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== 'md') return false;
        if (!checking) void this.run(file);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, target) => {
      if (!(target instanceof TFolder) && !(target instanceof TFile && target.extension.toLowerCase() === 'md')) return;
      menu.addItem(item => item.setTitle(target instanceof TFolder
        ? 'Remove blank properties in folder' : 'Remove blank properties')
        .setIcon('eraser').onClick(() => { void this.run(target); }));
    }));
  }

  onunload(): void { this.disposed = true; }

  private sourceView(file: TFile): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file && leaf.view.getMode() === 'source') return leaf.view;
    }
    return undefined;
  }

  private async preview(target: TAbstractFile): Promise<Preview> {
    const candidates = markdownFiles(target);
    const preview: Preview = { files: [], scanned: candidates.length, skipped: 0 };
    for (const file of candidates) {
      if (this.disposed) break;
      try {
        const original = this.sourceView(file)?.editor.getValue() ?? await this.app.vault.read(file);
        const result = pruneFrontmatter(original);
        if (result.skipped) preview.skipped++;
        if (result.removed.length) preview.files.push({ file, original, result });
      } catch { preview.skipped++; }
    }
    return preview;
  }

  private confirm(target: TAbstractFile, preview: Preview): Promise<boolean> {
    return new Promise(resolve => new ConfirmPruneModal(this.app, target, preview, resolve).open());
  }

  async run(target: TAbstractFile): Promise<void> {
    if (this.busy || this.disposed) { new Notice('Property Pruner is already running or unloading.'); return; }
    this.busy = true;
    try {
      const preview = await this.preview(target);
      if (this.disposed) return;
      const needsConfirmation = target instanceof TFolder ? this.settings.confirmFolders : this.settings.confirmFiles;
      if (needsConfirmation && !await this.confirm(target, preview)) return;
      if (this.disposed) return;
      let changed = 0, removed = 0, skipped = preview.skipped;
      for (const planned of preview.files) {
        if (this.disposed) break;
        try {
          if (this.app.vault.getAbstractFileByPath(planned.file.path) !== planned.file) { skipped++; continue; }
          // Recheck only the properties included in the approved preview. A save,
          // metadata update, or sort must not prevent pruning unrelated nulls.
          const approved = new Set(planned.result.removed);
          const recheck = (current: string): PruneResult => current === planned.original
            ? planned.result : pruneFrontmatter(current, approved);
          let result: PruneResult | undefined;
          const view = this.sourceView(planned.file);
          // Properties widgets may reject CodeMirror edits inside frontmatter.
          // Flush unsaved text first, then use the same atomic file API in all modes.
          if (view) await view.save();
          await this.app.vault.process(planned.file, current => {
            result = recheck(current);
            return result.content;
          });
          if (result?.skipped) { skipped++; continue; }
          if (!result?.removed.length) continue;
          const remaining = frontmatterKeys(await this.app.vault.read(planned.file));
          if (!remaining) { skipped++; continue; }
          const verified = result.removed.filter(key => !remaining.has(key));
          if (verified.length !== result.removed.length) skipped++;
          if (!verified.length) continue;
          changed++;
          removed += verified.length;
        } catch { skipped++; }
      }
      new Notice(`Property Pruner: removed ${removed} ${removed === 1 ? 'property' : 'properties'} from ${changed} ${changed === 1 ? 'file' : 'files'}.${skipped ? ` Could not fully process ${skipped} ${skipped === 1 ? 'file' : 'files'} (unsupported YAML, unavailable files, read/write errors, or unverified removals).` : ''}`, 8000);
    } catch (error) {
      console.error('Property Pruner failed', error);
      new Notice('Property Pruner could not complete. See the developer console for details.');
    } finally { this.busy = false; }
  }
}

class ConfirmPruneModal extends Modal {
  private answered = false;
  constructor(app: App, private target: TAbstractFile, private preview: Preview, private resolve: (confirmed: boolean) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Remove blank properties?');
    const count = this.preview.files.reduce((sum, file) => sum + file.result.removed.length, 0);
    this.contentEl.createEl('p', { text: this.target instanceof TFolder
      ? `Scan all ${this.preview.scanned} Markdown files in “${this.target.path || '/'}”${this.target.children.some(child => child instanceof TFolder) ? ' and its subfolders' : ''}. Remove ${count} properties from ${this.preview.files.length} files?`
      : `Remove ${count} ${count === 1 ? 'property' : 'properties'} from “${this.target.path}”?` });
    if (this.preview.skipped) this.contentEl.createEl('p', { text: `${this.preview.skipped} files could not be safely processed and will be skipped.` });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Remove properties').setWarning().onClick(() => {
        this.answered = true;
        this.resolve(true);
        this.close();
      }));
  }
  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) { this.answered = true; this.resolve(false); }
  }
}

class PrunerSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PropertyPruner) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('p', { text: 'Remove only missing values and YAML nulls. Pruning runs when you invoke an action or command.' });
    new Setting(this.containerEl).setName('Confirm before pruning files')
      .setDesc('Show a confirmation dialog for a single file, including the active-file command.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.confirmFiles).onChange(async value => {
        this.plugin.settings.confirmFiles = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl).setName('Confirm before pruning folders')
      .setDesc('Show a confirmation dialog before recursively pruning a folder and its subfolders.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.confirmFolders).onChange(async value => {
        this.plugin.settings.confirmFolders = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}
