"""End-to-end install/rollback cycle against throwaway paths (never the real app)."""
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
for name in ('discovery', 'patch_desktop'):
    spec = importlib.util.spec_from_file_location(name, root / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    globals()[name] = module
patch = globals()['patch_desktop']
discovery = globals()['discovery']

BODY = ('const FACTORY = ' + discovery.FACTORY_TEXT + ';\n').encode()
BUNDLE = 'out/renderer/assets/main-ABC123XY.js'


def build_asar(path, main_body=BODY, version='2.0.18'):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    package = json.dumps({'name': '@opencode/desktop', 'version': version}).encode()
    files = {'package.json': package, BUNDLE: main_body, 'out/renderer/other.js': b'other content'}
    header = {'files': {}}
    offset = 0
    for name, body in files.items():
        node = header
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault('files', {}).setdefault(part, {'files': {}})
        node.setdefault('files', {})[parts[-1]] = {'size': len(body), 'offset': str(offset)}
        offset += len(body)
    text = json.dumps(header).encode()
    payload = struct.pack('<I', len(text)) + text
    payload += b'\0' * (-len(payload) % 4)
    hp = struct.pack('<I', len(payload)) + payload
    path.write_bytes(struct.pack('<II', 4, len(hp)) + hp + b''.join(files.values()))
    return path


class InstallCycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        (self.base / 'source').mkdir()
        for name in patch.PLUGIN_FILES:
            target = self.base / 'source' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f'// {name}\n'.encode())
        for name in patch.RENDERER_FILES:
            (self.base / 'source/src' / name).write_bytes(f'// {name}\n'.encode())
        self.app = build_asar(self.base / 'installed/app.asar')
        self.original = self.app.read_bytes()
        self.backup_copy = self.base / 'pristine-copy.asar'
        self.backup_copy.write_bytes(self.original)
        self.staged = self.base / 'build/app.asar'
        self.build = self.base / 'build'
        self.backups = self.base / 'backups'
        self.plugin = self.base / 'config/plugins/local-telemetry'
        self.paths = dict(app=self.app, staged=self.staged, build=self.build,
                          backups=self.backups, plugin=self.plugin,
                          source=self.base / 'source')

    def tearDown(self):
        self.tmp.cleanup()

    def stage(self):
        return patch.stage(app=self.app, output=self.staged, source=self.paths['source'],
                           build=self.build)

    def install(self, **overrides):
        kwargs = dict(check_closed=False, **self.paths)
        kwargs.update(overrides)
        return patch.install(**kwargs)

    def rollback(self):
        return patch.rollback(check_closed=False, **self.paths)

    def test_install_stages_automatically_when_nothing_is_staged_yet(self):
        """A fresh download has no build/ folder at all, so install must stage first."""
        self.assertFalse(self.staged.exists())
        result = patch.install(check_closed=False, **self.paths)
        self.assertEqual(result, {'status': 'installed'})
        self.assertEqual(self.app.read_bytes(), self.staged.read_bytes(),
                         'the app must carry the build that was staged during install')
        self.assertTrue(patch._fully_installed(self.paths['source'], self.plugin))
        record = json.loads((self.build / 'installed.json').read_text())
        self.assertEqual(record['original'], patch.digest(self.original))

    def test_install_rerstages_so_a_new_source_revision_actually_lands(self):
        self.install()
        first_install = self.app.read_bytes()
        (self.paths['source'] / 'src/sidebar.mjs').write_bytes(b'// revision two\n')
        result = patch.install(check_closed=False, **self.paths)
        self.assertEqual(result, {'status': 'installed'})
        self.assertNotEqual(self.app.read_bytes(), first_install,
                            'a changed source must produce a changed build')

    def test_install_rerstages_after_the_staged_output_is_deleted(self):
        self.install()
        shutil.rmtree(self.build)
        self.assertFalse(self.staged.exists())
        # Without the record, the app is patched and there is no pristine copy to stage against.
        with self.assertRaisesRegex(ValueError, 'Rollback-Sidebar.cmd'):
            patch.install(check_closed=False, **self.paths)

    def test_an_unpatchable_app_is_refused_with_guidance(self):
        unknown = build_asar(self.base / 'unknown.asar', main_body=b'const x = 1;\n')
        paths = dict(self.paths, app=unknown)
        before = unknown.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Verify-Compatibility'):
            patch.install(check_closed=False, **paths)
        self.assertEqual(unknown.read_bytes(), before, 'a refused install changes nothing')
        self.assertFalse(self.plugin.exists())

    def test_production_install_discards_a_tampered_staged_archive(self):
        """With restage on, a modified staged build is replaced, never installed."""
        self.stage()
        self.staged.write_bytes(b'tampered bytes')
        manifest = json.loads(self.staged.with_suffix('.manifest.json').read_text())
        result = self.install()
        self.assertEqual(result, {'status': 'installed'})
        self.assertNotEqual(self.app.read_bytes(), b'tampered bytes')
        self.assertEqual(patch.digest(self.app.read_bytes()), manifest['patched'])

    def test_restage_can_be_switched_off_for_tests_that_inject_a_staged_build(self):
        self.stage()
        result = patch.install(check_closed=False, restage=False, **self.paths)
        self.assertEqual(result, {'status': 'installed'})
        self.assertTrue(self.staged.exists())

    def test_full_cycle_installs_then_restores_byte_for_byte(self):
        original_bytes = self.app.read_bytes()
        self.stage()
        self.install()

        self.assertEqual(self.app.read_bytes(), self.staged.read_bytes(), 'app.asar should be the staged build')
        self.assertTrue(patch._fully_installed(self.paths['source'], self.plugin))
        record = json.loads((self.build / 'installed.json').read_text())
        self.assertEqual(record['original'], patch.digest(original_bytes))
        backup = self.build / 'installed.json'
        self.assertTrue(Path(record['backup']).exists(), 'backup archive must exist')

        self.rollback()
        self.assertEqual(self.app.read_bytes(), original_bytes, 'rollback must restore the original bytes')
        self.assertFalse(self.plugin.exists(), 'plugin must be moved aside on rollback')

    def test_install_refuses_a_stale_stage_when_restaging_is_off(self):
        original_bytes = self.app.read_bytes()
        self.stage()
        self.staged.write_bytes(b'stale bytes')
        with self.assertRaises(ValueError):
            self.install(restage=False)
        self.assertEqual(self.app.read_bytes(), original_bytes)
        self.assertFalse(self.plugin.exists())

    def test_install_refuses_when_the_app_changed_since_staging(self):
        self.stage()
        build_asar(self.app, main_body=('const FACTORY = ' + discovery.FACTORY_TEXT + '; // changed\n').encode())
        changed = self.app.read_bytes()
        with self.assertRaises(ValueError):
            self.install(restage=False)
        self.assertEqual(self.app.read_bytes(), changed)
        self.assertFalse(self.plugin.exists())

    def test_reinstalling_the_same_stage_is_idempotent(self):
        """Running install twice succeeds and changes nothing the second time."""
        self.stage()
        self.install()
        installed = self.app.read_bytes()
        before = (self.plugin / 'index.ts').stat().st_mtime_ns
        result = patch.install(check_closed=False, **self.paths)
        self.assertEqual(result, {'status': 'already-installed'})
        self.assertEqual(self.app.read_bytes(), installed)
        self.assertEqual((self.plugin / 'index.ts').stat().st_mtime_ns, before,
                         'an identical plugin must not be rewritten')

    def test_upgrade_replaces_a_previous_patch_without_a_rollback(self):
        """A second, different build installs over the first using the recorded backup."""
        self.stage()
        self.install()
        first = self.app.read_bytes()
        self.assertNotEqual(first, self.original)

        # A new source revision produces a different patched build, staged from the pristine backup.
        (self.paths['source'] / 'src/sidebar.mjs').write_bytes(b'// revised sidebar\n')
        (self.paths['source'] / 'src/metrics.mjs').write_bytes(b'// revised metrics\n')
        patch.stage(app=self.backup_copy, output=self.staged, source=self.paths["source"], build=self.build)
        second = patch.digest(self.staged.read_bytes())
        self.assertNotEqual(second, patch.digest(first))

        result = patch.install(check_closed=False, **self.paths)
        self.assertEqual(result, {'status': 'installed'})
        self.assertEqual(self.app.read_bytes(), self.staged.read_bytes(), 'upgrade must apply the new build')
        record = json.loads((self.build / 'installed.json').read_text())
        self.assertEqual(record['patched'], second)
        self.assertEqual(record['original'], patch.digest(self.original))

    def test_upgrade_refuses_an_app_that_is_neither_original_nor_the_recorded_patch(self):
        self.stage()
        self.install()
        self.app.write_bytes(b'some third party build')
        with self.assertRaises(ValueError):
            patch.install(check_closed=False, **self.paths)
        self.assertEqual(self.app.read_bytes(), b'some third party build')

    def test_upgrade_refuses_when_the_backup_no_longer_matches_the_original(self):
        self.stage()
        self.install()
        record = json.loads((self.build / 'installed.json').read_text())
        Path(record['backup']).write_bytes(b'tampered backup')
        (self.paths['source'] / 'src/sidebar.mjs').write_bytes(b'// revised sidebar\n')
        patch.stage(app=self.backup_copy, output=self.staged, source=self.paths["source"], build=self.build)
        with self.assertRaises(ValueError):
            patch.install(check_closed=False, **self.paths)

    def test_restaging_a_patched_app_rebuilds_from_the_pristine_backup(self):
        self.stage()
        self.install()
        (self.paths['source'] / 'src/sidebar.mjs').write_bytes(b'// revised sidebar\n')
        self.stage()  # live app is patched, so this must use the recorded pristine copy
        self.assertEqual(json.loads(self.staged.with_suffix('.manifest.json').read_text())['original'],
                         patch.digest(self.original))

    def test_staging_refuses_when_the_app_is_patched_and_the_backup_is_gone(self):
        self.stage()
        self.install()
        record = json.loads((self.build / 'installed.json').read_text())
        Path(record['backup']).unlink()
        with self.assertRaises(ValueError):
            self.stage()

    def test_rollback_refuses_when_the_app_is_not_the_patched_build(self):
        self.stage()
        self.install()
        self.app.write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            self.rollback()
        self.assertEqual(self.app.read_bytes(), b'tampered')

    def test_stage_rejects_a_different_desktop_version(self):
        other = build_asar(self.base / 'other.asar', version='9.9.9')
        with self.assertRaisesRegex(ValueError, '2.x'):
            patch.stage(app=other, output=self.base / 'out.asar')

    def test_stage_accepts_an_untested_but_compatible_2x_build(self):
        other = build_asar(self.base / 'newer.asar', version='2.1.4')
        manifest = patch.stage(app=other, output=self.base / 'newer-out.asar',
                               source=self.paths['source'], build=self.build)
        self.assertEqual(manifest['version'], '2.1.4')
        staged = patch.Asar(self.base / 'newer-out.asar')
        self.assertIn(discovery.WRAPPER, staged.read(BUNDLE).decode())

    def test_verify_reports_compatibility_without_writing_anything(self):
        before = self.app.read_bytes()
        report = patch.verify(app=self.app)
        self.assertEqual(report['version'], '2.0.18')
        self.assertEqual(self.app.read_bytes(), before, 'verify must not modify the archive')

    def test_verify_rejects_an_unrelated_archive(self):
        other = build_asar(self.base / 'notours.asar')
        archive = patch.Asar(other)
        changed = dict(archive.entries())
        with self.assertRaises(ValueError):
            patch.verify(app=self.base / 'missing.asar')


if __name__ == '__main__':
    unittest.main()
