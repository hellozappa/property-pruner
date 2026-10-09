#!/usr/bin/env python3
"""Install verified runtime assets; preserve settings and back up replacements."""
import argparse
from datetime import datetime
import hashlib
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--vault', required=True, type=Path)
parser.add_argument('--dry-run', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
vault = args.vault.resolve()
if not (vault / '.obsidian').is_dir():
    raise SystemExit('Target must be an existing Obsidian vault with .obsidian.')
assets = ['main.js', 'manifest.json']
for name in assets:
    if not (root / name).is_file() or (root / name).stat().st_size == 0:
        raise SystemExit(f'Missing build asset: {name}')
target = vault / '.obsidian/plugins/property-pruner'
print(f'Install {assets} to {target}; preserve data.json.')
if args.dry_run:
    raise SystemExit(0)
existing = [name for name in assets if (target / name).exists()]
if existing:
    backup = root / 'work/install-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True, exist_ok=False)
    for name in existing:
        shutil.copy2(target / name, backup / name)
    print(f'Backed up existing assets to {backup}')
target.mkdir(parents=True, exist_ok=True)
for name in assets:
    shutil.copy2(root / name, target / name)
    source_hash = hashlib.sha256((root / name).read_bytes()).hexdigest()
    installed_hash = hashlib.sha256((target / name).read_bytes()).hexdigest()
    if source_hash != installed_hash:
        raise SystemExit(f'Hash mismatch: {name}')
    print(f'{name}: {installed_hash}')
