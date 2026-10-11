# Property Pruner

Remove YAML frontmatter properties with missing values or YAML nulls in Obsidian.
Pruning runs only when you invoke it.

## Use

- Right-click a Markdown file in the file explorer and choose **Remove blank properties**.
- Run **Property Pruner: Remove blank properties from active file** from the command palette. You can assign a hotkey in Obsidian’s Hotkeys settings.
- Right-click a folder and choose **Remove blank properties in folder** to process its Markdown files and all subfolders. Attachments are ignored.

A confirmation dialog shows the number of properties and files before either action.
The plugin settings contain two independent switches, both enabled by default:
**Confirm before pruning files** and **Confirm before pruning folders**.

All actions work with notes open in Reading view. The plugin updates their files
through Obsidian's vault API without switching them to editing mode.

## What is removed

```yaml
missing:
nullValue: null
tilde: ~
```

YAML `Null` and `NULL` are also nulls. Empty strings (`""`), whitespace strings,
quoted `"null"`, empty lists (`[]`), empty maps (`{}`), `0`, and `false` remain.
Only top-level properties are removed; nested properties are preserved.

The plugin deletes source ranges, retaining the remaining YAML’s formatting,
standalone comments, property order, line endings, and the note body. Both
frontmatter delimiters remain even when all properties are removed.

Malformed or duplicate-key YAML, anchors/aliases, flow-style root mappings,
and unsupported keys are skipped and reported in the completion notice.
Before applying changes, the plugin rechecks the latest text and removes only
properties included in the preview that still have missing or null values.
New properties and newly filled values are preserved. Open editing views are saved
first to retain unsaved text. All notes use atomic `Vault.process` updates so the
Properties widget cannot reject a frontmatter editor transaction. Completion counts
are checked against the saved files. Folder operations are sequential; a failure
in one file does not prevent processing the other files.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm run check
npm run dev
```

The production build creates `main.js`. Install `main.js` and `manifest.json`
in your vault’s `.obsidian/plugins/property-pruner/` directory, then enable
**Property Pruner** under Community plugins.

The repository helper supports explicit vault installation:

```sh
python3 scripts/install_vault.py --vault /absolute/path/to/vault --dry-run
python3 scripts/install_vault.py --vault /absolute/path/to/vault
```

It backs up existing runtime assets, preserves `data.json`, and verifies hashes.
It does not launch Obsidian or activate the plugin.

The plugin makes no network requests, requires no account, and collects no telemetry.
