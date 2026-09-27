"""Reversible ASAR patch that adds a session-telemetry sidebar to the OpenCode desktop app.

Nothing is pinned to one OpenCode release: the renderer bundle and the client factory are
discovered by shape, so a new patch release usually keeps working. Stage is read-only
against the installation; install backs up the original first.
"""
import sys

# Leave no __pycache__ behind in the folder the user shares.
sys.dont_write_bytecode = True

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess

# Loaded from this file's own directory so the script works when run directly, imported by
# a test, or invoked from any working directory.
ROOT = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('telemetry_discovery', ROOT / 'discovery.py')
discovery = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(discovery)

DEFAULT_APP = Path.home() / 'AppData/Local/Programs/@opencode-aidesktop/resources/app.asar'
# Version this project was last verified against. Other 2.x builds are attempted and
# reported as untested, because discovery validates the real structure instead.
TESTED_VERSION = '2.0.18'
# Where the renderer modules are bundled inside the archive.
RENDERER_PREFIX = 'out/renderer/assets/telemetry/'
IMPORT_LINE = 'import {attachClient as %s} from "./telemetry/sidebar.mjs";\n' % discovery.WRAPPER


class StateConflict(ValueError):
    """Per-user state already exists where a migration wanted to write."""


def state_root():
    """Per-user location for the staged archive and the pristine backup.

    Deliberately outside the project folder: a downloaded folder is both the repo and the
    install source, and leaving ~236 MB of archives in it bloats an upload and invites a
    cleanup that strands a patched install. Override with OPENCODE_TELEMETRY_STATE.
    """
    override = os.environ.get('OPENCODE_TELEMETRY_STATE')
    if override:
        return Path(override).expanduser()
    local = os.environ.get('LOCALAPPDATA')
    base = Path(local) if local else Path.home() / '.local/share'
    return base / 'opencode-telemetry-sidebar'


def state_dirs(build=None, backups=None):
    root = state_root()
    return (Path(build) if build else root / 'build',
            Path(backups) if backups else root / 'backups')


def legacy_dirs():
    """Pre-1.1 layout, which kept state inside the project folder."""
    return ROOT / 'build', ROOT / 'backups'


def resolve_dirs(build=None, backups=None):
    """Explicit paths win, then the per-user state dir, then a legacy in-folder install."""
    if build is not None or backups is not None:
        return state_dirs(build, backups)
    build, backups = state_dirs()
    legacy_build, legacy_backups = legacy_dirs()
    if not (build / 'installed.json').is_file() and (legacy_build / 'installed.json').is_file():
        return legacy_build, legacy_backups
    return build, backups


def migrate_state(build=None, backups=None):
    """Move a legacy in-folder install out to the per-user state directory.

    Returns True when it moved anything. Refuses, leaving both copies in place, if the state
    directory already holds an install; a migration must never overwrite live state.
    """
    if build is not None or backups is not None:
        return False
    target_build, target_backups = state_dirs()
    legacy_build, legacy_backups = legacy_dirs()
    if not (legacy_build / 'installed.json').is_file():
        return False
    if (target_build / 'installed.json').is_file():
        return False
    if target_build.exists() or target_backups.exists():
        raise StateConflict(
            f'{state_root()} already contains files but no install record. '
            'Move it aside, then run this again. Nothing was changed.')

    target_build.parent.mkdir(parents=True, exist_ok=True)
    moved_backup = None
    if legacy_backups.exists():
        shutil.move(str(legacy_backups), str(target_backups))
        moved_backup = target_backups
    if legacy_build.exists():
        shutil.move(str(legacy_build), str(target_build))

    record_file = target_build / 'installed.json'
    record = json.loads(record_file.read_text())
    old_backup = Path(record.get('backup', ''))
    if moved_backup is not None and old_backup.name:
        # The backup lives at <backups>/<original-hash>/app.asar; keep the hash folder name.
        record['backup'] = str(moved_backup / old_backup.parent.name / old_backup.name)
    record_file.write_text(json.dumps(record, indent=2))
    print(f'Moved install state out of the project folder to {state_root()}')
    return True

def digest(data):
    return hashlib.sha256(data).hexdigest()

class Asar:
    def __init__(self, path):
        self.path = Path(path)
        with self.path.open('rb') as f:
            first, header_size, payload_size, text_size = struct.unpack('<4I', f.read(16))
            if first != 4 or text_size > 16000000 or header_size != payload_size + 4:
                raise ValueError('Invalid ASAR header')
            self.header = json.loads(f.read(text_size))
            self.start = 8 + header_size

    def entries(self):
        if hasattr(self, '_entries'):
            return self._entries
        def walk(node, base=''):
            for name, entry in node.get('files', {}).items():
                key = f'{base}/{name}' if base else name
                if 'files' in entry:
                    yield from walk(entry, key)
                else:
                    yield key, entry
        self._entries = dict(walk(self.header))
        return self._entries

    def read(self, key):
        entry = self.entries()[key]
        if entry.get('unpacked') or 'link' in entry:
            raise ValueError('Cannot read unpacked file or link')
        with self.path.open('rb') as f:
            f.seek(self.start + int(entry['offset']))
            data = f.read(entry['size'])
            if len(data) != entry['size']:
                raise ValueError('Truncated ASAR')
            return data

    def rewrite(self, output, changes):
        header = copy.deepcopy(self.header)
        for key in changes:
            node = header
            bits = key.split('/')
            for part in bits[:-1]:
                node = node.setdefault('files', {}).setdefault(part, {'files': {}})
            node.setdefault('files', {}).setdefault(bits[-1], {})
        old = self.entries()
        bodies = []
        offset = 0
        def walk(node, base=''):
            nonlocal offset
            for name, entry in node.get('files', {}).items():
                key = f'{base}/{name}' if base else name
                if 'files' in entry:
                    walk(entry, key)
                elif not entry.get('unpacked') and 'link' not in entry:
                    data = changes[key] if key in changes else self.read(key)
                    entry['offset'] = str(offset)
                    entry['size'] = len(data)
                    if key in changes:
                        size = entry.get('integrity', {}).get('blockSize', 4194304)
                        entry['integrity'] = {'algorithm':'SHA256','hash':digest(data),'blockSize':size,
                                              'blocks':[digest(data[i:i+size]) for i in range(0,len(data),size)]}
                    bodies.append(data)
                    offset += len(data)
        walk(header)
        text = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
        payload = struct.pack('<I', len(text)) + text
        payload += b'\x00' * (-len(payload) % 4)
        header_pickle = struct.pack('<I', len(payload)) + payload
        with Path(output).open('wb') as f:
            f.write(struct.pack('<II', 4, len(header_pickle)))
            f.write(header_pickle)
            for body in bodies:
                f.write(body)

def verify(app=DEFAULT_APP):
    """Report whether this installation can be patched, without changing anything."""
    app = Path(app)
    if not app.is_file():
        raise ValueError(f'No OpenCode desktop archive found at {app}')
    archive = Asar(app)
    package = json.loads(archive.read('package.json'))
    version = str(package.get('version', ''))
    print(f'Archive:  {app}')
    print(f'Product:  {package.get("name")} {version}')
    if package.get('name') != '@opencode/desktop':
        raise ValueError('This is not an OpenCode desktop archive.')
    bundle = discovery.find_main_bundle(archive)
    factory = bundle.factory
    if factory is None:
        print('Status:   already patched by this project')
        print('          Run Install-Sidebar.cmd to upgrade, or Rollback-Sidebar.cmd to remove it.')
        return {'version': version, 'bundle': bundle.key, 'patched': True}
    print(f'Bundle:   {bundle.key}')
    print(f'Factory:  function {factory.name}({factory.parameter}) returning {factory.inner}(...)')
    patched = discovery.patch_client_factory(bundle.text)
    print(f'Patched:  wrapper inserts cleanly, {len(patched.text) - len(bundle.text)} bytes added')
    print(f'Tested:   {TESTED_VERSION} (this build is {version})')
    print('Compatible. Run Install-Sidebar.cmd to apply.')
    return {'version': version, 'bundle': bundle.key, 'factory': factory.name, 'patched': False}

def stage(app=DEFAULT_APP, output=None, source=None, build=None):
    source = Path(source) if source else ROOT
    build = resolve_dirs(build, None)[0]
    app = Path(app)
    # When the installed app already carries a build we patched, rebuild from the recorded
    # pristine copy. That keeps staging correct and turns updates into a plain re-install.
    record_file = build/'installed.json'
    try:
        recorded = json.loads(record_file.read_text())
    except (OSError, ValueError):
        recorded = None
    if recorded and digest(app.read_bytes()) == recorded.get('patched'):
        pristine = Path(recorded['backup'])
        if pristine.is_file() and digest(pristine.read_bytes()) == recorded.get('original'):
            app = pristine
            print('Installed app is already patched; staging from the pristine backup.')
        else:
            raise ValueError('Installed app is patched and the pristine backup is unusable; roll back first')
    original = Asar(app)
    package = json.loads(original.read('package.json'))
    if package.get('name') != '@opencode/desktop':
        raise ValueError(f"Not an OpenCode desktop archive (package name {package.get('name')!r}).")
    version = str(package.get('version', ''))
    if not version.startswith('2.'):
        raise ValueError(f'OpenCode desktop 2.x is required; this archive is {version}.')
    bundle = discovery.find_main_bundle(original)
    if bundle.factory is None:
        raise ValueError('This archive is already patched. Roll back first, or re-run Install to upgrade.')
    if version != TESTED_VERSION:
        print(f'Note: OpenCode {version} is untested here (verified against {TESTED_VERSION}); '
              f'the client factory was found, so the patch is expected to work.')
    main = IMPORT_LINE + discovery.patch_client_factory(bundle.text).text
    changes = {bundle.key: main.encode()}
    for name in RENDERER_FILES:
        changes[f'{RENDERER_PREFIX}{name}'] = (source/'src'/name).read_bytes()
    output = Path(output or ROOT/'build/app.asar')
    output.parent.mkdir(parents=True,exist_ok=True)
    original.rewrite(output,changes)
    patched = Asar(output)
    # Verify every original packed file, not just the sidebar. Preserve unpacked metadata.
    for key, entry in original.entries().items():
        new_entry = patched.entries()[key]
        if entry.get('unpacked') or 'link' in entry:
            if entry != new_entry:
                raise ValueError(f'Unpacked metadata changed: {key}')
        elif patched.read(key) != changes.get(key,original.read(key)):
            raise ValueError(f'Verification failed: {key}')
    manifest = {'version':package['version'],'original':digest(Path(app).read_bytes()),
                'patched':digest(output.read_bytes()),'files':list(changes)}
    output.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2))
    print(f'Staged and verified {len(original.entries())} existing entries; {len(changes)} patch files')
    return manifest

def require_closed():
    result = subprocess.run(['tasklist','/FI','IMAGENAME eq OpenCode.exe','/FO','CSV','/NH'],capture_output=True,text=True,check=True)
    if 'opencode.exe' in result.stdout.lower():
        raise RuntimeError('Close all OpenCode desktop windows first. No files changed.')

class PluginConflict(ValueError):
    """The plugin directory holds files we did not write; refuse to clobber it."""


PLUGIN_FILES = ['index.ts', 'package.json', 'src/quota.mjs']
# Renderer-side modules bundled into the archive; the tests build their fake source from this list.
RENDERER_FILES = ['sidebar.mjs', 'metrics.mjs', 'attribution.mjs']


def _matches_source(source, plugin, name):
    target = plugin / name
    return target.is_file() and digest(target.read_bytes()) == digest((source / name).read_bytes())


def _fully_installed(source, plugin):
    return plugin.is_dir() and all(_matches_source(source, plugin, name) for name in PLUGIN_FILES)


def _stash(directory, into):
    """Move a leftover directory aside under a name that is always free."""
    into.mkdir(parents=True, exist_ok=True)
    destination = into / directory.name
    index = 2
    while destination.exists():
        destination = into / f'{directory.name}-{index}'
        index += 1
    shutil.move(str(directory), str(destination))
    return destination


def install_plugin(source=ROOT, plugin=None, cleanup_into=None, fail_after_files=None):
    """Install the server plugin files. Never deletes anything; only fills gaps or moves aside.

    Returns {'status': 'installed' | 'already-installed'}. Raises PluginConflict when the
    directory holds files we did not write, so a user's own plugin is never overwritten.
    On a partial failure the incomplete directory is moved aside so a retry starts clean.
    """
    source = Path(source)
    plugin = Path(plugin) if plugin else Path.home() / '.config/opencode/plugins/local-telemetry'
    cleanup_into = Path(cleanup_into) if cleanup_into else plugin.parent / 'plugin-install-failed'
    try:
        if plugin.exists():
            present = [name for name in PLUGIN_FILES if (plugin / name).exists()]
            mismatched = [name for name in present if not _matches_source(source, plugin, name)]
            if mismatched:
                raise PluginConflict(
                    'Telemetry plugin directory has files we did not write: ' + ', '.join(mismatched)
                    + f'. Move {plugin} aside, then run this again. No files were changed.')
            if len(present) == len(PLUGIN_FILES):
                return {'status': 'already-installed', 'plugin': str(plugin)}
        for written, name in enumerate(PLUGIN_FILES, start=1):
            target = plugin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
            if fail_after_files is not None and written >= fail_after_files:
                raise RuntimeError(f'simulated failure after writing {written} file(s)')
        return {'status': 'installed', 'plugin': str(plugin)}
    except PluginConflict:
        raise
    except Exception:
        # Best-effort tidy-up. A cleanup problem must never hide the real failure.
        try:
            if plugin.exists() and not _fully_installed(source, plugin):
                _stash(plugin, cleanup_into)
        except Exception as cleanup_error:
            print(f'Note: could not move {plugin} aside: {cleanup_error}')
        raise

def install(app=DEFAULT_APP, staged=None, build=None, backups=None, plugin=None,
            source=None, check_closed=True, restage=True):
    if check_closed:
        require_closed()
    app = Path(app)
    source = Path(source) if source else ROOT
    if build is None and backups is None:
        # Relocate a pre-1.1 in-folder install so archives stop piling up in the source folder.
        migrate_state()
    build, backups = resolve_dirs(build, backups)
    staged = Path(staged) if staged else build/'app.asar'
    plugin = Path(plugin) if plugin else Path.home()/'.config/opencode/plugins/local-telemetry'

    # Always stage from the pristine archive before installing. That makes a fresh download
    # (which has no build/ folder) work on the first run, and makes re-running Install pick
    # up a changed source revision instead of reporting "already installed".
    if restage:
        try:
            stage(app=app, output=staged, source=source, build=build)
        except discovery.UnsupportedBuild as error:
            raise ValueError(
                f'{error}\nNothing was changed. Run Verify-Compatibility.cmd and report its output.') from None
        except ValueError as error:
            if 'already patched' in str(error):
                raise ValueError(
                    'The installed app is already patched and the pristine backup is missing, '
                    'so there is nothing to stage against. Restore the original first with '
                    'Rollback-Sidebar.cmd, or replace app.asar from backups/. No files were changed.'
                ) from None
            raise

    if not staged.with_suffix('.manifest.json').is_file():
        raise ValueError(
            f'Nothing is staged at {staged} and staging did not produce it. '
            'Run Verify-Compatibility.cmd and report its output. No files were changed.')
    manifest = json.loads(staged.with_suffix('.manifest.json').read_text())
    if digest(staged.read_bytes()) != manifest['patched']:
        raise ValueError('Staged archive changed. Restage before installing.')
    backup = backups/manifest['original']
    backup.mkdir(parents=True,exist_ok=True)
    saved = backup/'app.asar'
    app_digest = digest(app.read_bytes())
    backup_is_original = saved.is_file() and digest(saved.read_bytes()) == manifest['original']
    if app_digest == manifest['patched'] and backup_is_original:
        result = install_plugin(source=source, plugin=plugin, cleanup_into=backup/'plugin-install-failed')
        print(f"Already installed ({result['status']}). Nothing to change.")
        return {'status': 'already-installed'}
    # An app carrying a build we installed earlier may be upgraded in place, because the
    # pristine original is still on disk. Anything else is refused.
    record_file = build/'installed.json'
    recorded = None
    if record_file.is_file():
        try:
            recorded = json.loads(record_file.read_text())
        except (OSError, ValueError):
            recorded = None
    upgrading = bool(recorded) and app_digest == recorded.get('patched') and backup_is_original
    if app_digest != manifest['original'] and not (upgrading or app_digest == manifest['patched']):
        raise ValueError('Installed app changed since staging. Restage before installing.')
    if not saved.exists():
        shutil.copy2(app,saved)
    if digest(saved.read_bytes()) != manifest['original']:
        raise ValueError('Backup verification failed')
    result = install_plugin(source=source, plugin=plugin, cleanup_into=backup/'plugin-install-failed')
    temp = app.with_suffix('.telemetry-staged')
    shutil.copy2(staged,temp)
    os.replace(temp,app)
    (build/'installed.json').write_text(json.dumps({**manifest,'app':str(app),'backup':str(saved),'plugin':str(plugin)},indent=2))
    print(f"Installed ({result['status']}{' as an upgrade' if upgrading else ''}). Original archive is backed up; launch OpenCode normally.")
    return {'status': 'installed'}

def rollback(app=None, plugin=None, build=None, backups=None, source=None, staged=None,
             record_file=None, check_closed=True):
    if check_closed:
        require_closed()
    if record_file is None and build is None:
        migrate_state()
    build = resolve_dirs(build, backups)[0]
    record = json.loads(Path(record_file or build/'installed.json').read_text())
    app = Path(app) if app else Path(record['app'])
    plugin = Path(plugin) if plugin else Path(record['plugin'])
    backup = Path(record['backup'])
    if digest(app.read_bytes()) != record['patched'] or digest(backup.read_bytes()) != record['original']:
        raise ValueError('Archive changed since installation; refusing to overwrite')
    temp=app.with_suffix('.telemetry-restore')
    shutil.copy2(backup,temp)
    os.replace(temp,app)
    if plugin.exists():
        _stash(plugin, backup.parent/'disabled-plugin')
    print('Original desktop restored; telemetry plugin moved into backup, not deleted.')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['verify','stage','install','rollback','migrate'])
    args=parser.parse_args()
    {'verify':verify,'stage':stage,'install':install,'rollback':rollback,
     'migrate':migrate_state}[args.action]()
