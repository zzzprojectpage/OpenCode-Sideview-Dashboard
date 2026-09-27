"""Assemble the uploadable project folder on the Desktop.

Copies only the files that belong in the public repo, renames the screenshots, and then
audits the result for machine-specific paths, identifiers, and build artifacts.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = Path.home() / 'Desktop/opencode-telemetry-sidebar'

FILES = [
    'README.md', 'LICENSE', '.gitignore', 'Instructions.docx', 'AI Assitance.md',
    'Install-Sidebar.cmd', 'Rollback-Sidebar.cmd', 'Verify-Compatibility.cmd',
    'patch_desktop.py', 'discovery.py', 'build_instructions.py', 'build_release.py',
    'index.ts', 'package.json',
    'src/sidebar.mjs', 'src/metrics.mjs', 'src/attribution.mjs', 'src/quota.mjs',
    'tests/attribution.test.mjs', 'tests/cost.test.mjs', 'tests/metrics.test.mjs',
    'tests/plugin.test.mjs', 'tests/quota.test.mjs', 'tests/sidebar.test.mjs',
    'tests/test_discovery.py', 'tests/test_patch.py', 'tests/test_patch_install.py',
    'tests/test_patch_e2e.py', 'tests/test_state.py', 'tests/ui_harness.html', 'tests/verify_ui.py',
]

SCREENSHOTS = {
    'image1.png': '01-context-cost-speed-cache.png',
    'image2.png': '02-go-caps-per-model.png',
    'image3.png': '03-openai-monthly-and-models.png',
}

# Anything matching these means something private or machine-specific slipped in.
FORBIDDEN = [
    (re.compile(r'no pc', re.I), 'this machine\'s user name'),
    (re.compile(r'Default Project'), 'this machine\'s project path'),
    (re.compile(r'72b472059b8b04b6', re.I), 'this machine\'s backup id'),
    (re.compile(r'\bses_[A-Za-z0-9]{6,}'), 'a session id'),
    (re.compile(r'\bwrk_[A-Za-z0-9]{6,}'), 'a workspace id'),
    (re.compile(r'sk-[A-Za-z0-9]{8,}'), 'something shaped like an API key'),
    (re.compile(r'(?i)(api[_-]?key|secret|password)\s*[:=]\s*["\'][^"\']{8,}'), 'a hardcoded secret'),
]

TEXT_SUFFIXES = {'.md', '.py', '.mjs', '.js', '.ts', '.json', '.jsonc', '.cmd', '.html', '.yml', '.txt'}

# Never touched by the packager, whatever they contain. build/ and backups/ hold the install's
# staged archive, its record, and the pristine backup of the user's app; deleting them would
# strand a patched install. Everything here is also listed in .gitignore.
PROTECTED = {'build', 'backups', '__pycache__', '.git', 'node_modules'}


def build():
    """Write the release in place so re-running works even while the folder is open."""
    TARGET.mkdir(parents=True, exist_ok=True)

    expected = set(FILES) | {f'docs/screenshots/{name}' for name in SCREENSHOTS.values()}
    locked = []
    missing = []
    for name in FILES:
        source = ROOT / name
        if not source.is_file():
            missing.append(name)
            continue
        destination = TARGET / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(source, destination)
        except PermissionError:
            locked.append(name)
    if missing:
        raise SystemExit(f'missing source files: {missing}')

    media = ROOT / 'build/docx-media'
    destination_dir = TARGET / 'docs/screenshots'
    destination_dir.mkdir(parents=True, exist_ok=True)
    for source_name, public_name in SCREENSHOTS.items():
        source = media / source_name
        if not source.is_file():
            raise SystemExit(f'missing screenshot {source}')
        try:
            shutil.copy2(source, destination_dir / public_name)
        except PermissionError:
            locked.append(f'docs/screenshots/{public_name}')

    # Remove files we no longer ship, but never touch a protected folder: build/ and backups/
    # are install state, not release content. Protected folders are also named in .gitignore,
    # so they are excluded from an upload without being deleted.
    for path in sorted(TARGET.rglob('*'), reverse=True):
        if path.is_dir():
            continue
        relative = path.relative_to(TARGET)
        if relative.parts[0] in PROTECTED:
            continue
        if relative.as_posix() in expected:
            continue
        try:
            path.unlink()
        except PermissionError:
            locked.append(relative.as_posix())

    if locked:
        print('Note: could not update these files because they are open elsewhere:')
        for name in locked:
            print(f'  {name}')
        print('Close the folder window or the file preview, then run this again.')
    return audit()


# Exact strings that can never be a real leak, allowed in any file.
# ses_abc123 is the synthetic fixture for the bind test; no real id looks like that.
ALLOW_ANY = {
    'ses_abc123',
}

# (file, matched text) pairs that are this audit's own pattern definitions.
# Scoped per file so the same text anywhere else still fails the audit.
ALLOWLIST = {
    ('build_release.py', 'no pc'),  # this audit's own pattern for the builder's user name
    ('build_release.py', 'Default Project'),  # this audit's own pattern for the project path
    ('build_release.py', '72b472059b8b04b6'),  # this audit's own pattern for the backup id
}


def audit():
    problems = []
    for path in sorted(TARGET.rglob('*')):
        if path.is_dir():
            continue
        relative = path.relative_to(TARGET).as_posix()
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        for pattern, label in FORBIDDEN:
            for match in pattern.finditer(text):
                if match.group(0) in ALLOW_ANY or (relative, match.group(0)) in ALLOWLIST:
                    continue
                line = text[:match.start()].count('\n') + 1
                problems.append(f'{relative}:{line} contains {label}: {match.group(0)[:40]!r}')
    return problems


if __name__ == '__main__':
    issues = build()
    files = [p for p in TARGET.rglob('*')
             if p.is_file() and p.relative_to(TARGET).parts[0] not in PROTECTED]
    total = sum(p.stat().st_size for p in files)
    print(f'shareable: {len(files)} files, {total / 1024:.0f} KiB in {TARGET}')
    protected = [p.name for p in TARGET.iterdir() if p.name in PROTECTED]
    if protected:
        print(f'left in place (gitignored install state): {", ".join(sorted(protected))}')
    if issues:
        print('\nAUDIT FAILED:')
        for issue in issues:
            print('  ' + issue)
        sys.exit(1)
    print('audit clean: no machine-specific paths, identifiers or secrets in text files')
