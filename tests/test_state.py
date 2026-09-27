"""The install keeps its state outside the project folder.

A downloaded folder is both the repo and the install source. When build/ and backups/ land
beside the source, the folder balloons by ~236 MB and a well-meaning cleanup can strand a
patched install. These tests pin the state elsewhere, with a legacy fallback so an existing
install keeps working.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('patch_desktop', root / 'patch_desktop.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


class StateLocationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.previous = os.environ.get('OPENCODE_TELEMETRY_STATE')
        os.environ['OPENCODE_TELEMETRY_STATE'] = str(self.base / 'state')

    def tearDown(self):
        if self.previous is None:
            os.environ.pop('OPENCODE_TELEMETRY_STATE', None)
        else:
            os.environ['OPENCODE_TELEMETRY_STATE'] = self.previous
        self.tmp.cleanup()

    def test_state_root_honours_the_environment_override(self):
        self.assertEqual(patch.state_root(), self.base / 'state')

    def test_default_state_root_is_outside_the_project_folder(self):
        os.environ.pop('OPENCODE_TELEMETRY_STATE', None)
        location = patch.state_root()
        self.assertFalse(str(location).startswith(str(patch.ROOT)),
                         'state must never default to a subfolder of the source tree')
        self.assertIn('opencode-telemetry', location.name)

    def test_defaults_place_build_and_backups_under_the_state_root(self):
        build, backups = patch.state_dirs()
        self.assertEqual(build, self.base / 'state/build')
        self.assertEqual(backups, self.base / 'state/backups')

    def test_explicit_paths_still_win(self):
        build, backups = patch.state_dirs(self.base / 'b', self.base / 'k')
        self.assertEqual(build, self.base / 'b')
        self.assertEqual(backups, self.base / 'k')

    def test_legacy_in_folder_state_is_used_when_the_state_root_is_empty(self):
        legacy_build, legacy_backups = patch.legacy_dirs()
        self.assertEqual(legacy_build, patch.ROOT / 'build')
        # Simulate a legacy install record without touching the real repo folders.
        original_root = patch.ROOT
        try:
            patch.ROOT = self.base / 'project'
            (patch.ROOT / 'build').mkdir(parents=True)
            (patch.ROOT / 'build/installed.json').write_text('{}')
            build, backups = patch.resolve_dirs()
            self.assertEqual(build, patch.ROOT / 'build',
                             'an existing in-folder record must keep working')
        finally:
            patch.ROOT = original_root

    def test_the_state_root_wins_once_it_has_a_record(self):
        original_root = patch.ROOT
        try:
            patch.ROOT = self.base / 'project'
            (patch.ROOT / 'build').mkdir(parents=True)
            (patch.ROOT / 'build/installed.json').write_text('{}')
            state = self.base / 'state'
            (state / 'build').mkdir(parents=True)
            (state / 'build/installed.json').write_text('{}')
            build, _ = patch.resolve_dirs()
            self.assertEqual(build, state / 'build')
        finally:
            patch.ROOT = original_root


class MigrateStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.previous = os.environ.get('OPENCODE_TELEMETRY_STATE')
        os.environ['OPENCODE_TELEMETRY_STATE'] = str(self.base / 'state')
        self.original_root = patch.ROOT
        patch.ROOT = self.base / 'project'
        self.project = patch.ROOT
        original = b'original-bytes'

        (self.project / 'build').mkdir(parents=True)
        (self.project / 'backups/abc123').mkdir(parents=True)
        (self.project / 'backups/abc123/app.asar').write_bytes(original)
        (self.project / 'build/app.asar').write_bytes(b'patched-bytes')
        (self.project / 'build/installed.json').write_text(json.dumps({
            'original': 'a' * 64, 'patched': 'b' * 64,
            'app': str(self.base / 'app.asar'),
            'backup': str(self.project / 'backups/abc123/app.asar'),
            'plugin': str(self.base / 'plugin'),
        }))

    def tearDown(self):
        patch.ROOT = self.original_root
        if self.previous is None:
            os.environ.pop('OPENCODE_TELEMETRY_STATE', None)
        else:
            os.environ['OPENCODE_TELEMETRY_STATE'] = self.previous
        self.tmp.cleanup()

    def test_migration_moves_state_out_of_the_project_folder(self):
        moved = patch.migrate_state()
        self.assertTrue(moved, 'migration should report that it acted')
        self.assertFalse((self.project / 'build').exists(), 'build/ must leave the source tree')
        self.assertFalse((self.project / 'backups').exists(), 'backups/ must leave the source tree')
        state = self.base / 'state'
        self.assertTrue((state / 'build/installed.json').is_file())
        self.assertEqual((state / 'backups/abc123/app.asar').read_bytes(), b'original-bytes')

    def test_migration_rewrites_the_recorded_backup_path(self):
        patch.migrate_state()
        record = json.loads((self.base / 'state/build/installed.json').read_text())
        self.assertEqual(record['backup'], str(self.base / 'state/backups/abc123/app.asar'))
        self.assertTrue(Path(record['backup']).is_file(), 'the rewritten path must resolve')

    def test_migration_is_idempotent(self):
        patch.migrate_state()
        second = patch.migrate_state()
        self.assertFalse(second, 'a second run has nothing to do')
        self.assertTrue((self.base / 'state/build/installed.json').is_file())

    def test_migration_does_nothing_without_a_legacy_record(self):
        shutil.rmtree(self.project / 'build')
        self.assertFalse(patch.migrate_state())

    def test_migration_refuses_rather_than_clobbering_stray_files(self):
        state = self.base / 'state'
        (state / 'backups').mkdir(parents=True)
        (state / 'backups/something-important.txt').write_text('keep me')
        with self.assertRaises(patch.StateConflict):
            patch.migrate_state()
        self.assertTrue((self.project / 'build/installed.json').is_file(),
                        'the legacy copy must survive a refused migration')
        self.assertEqual((state / 'backups/something-important.txt').read_text(), 'keep me')

    def test_migration_defers_when_the_state_root_already_has_an_install(self):
        state = self.base / 'state'
        (state / 'build').mkdir(parents=True)
        (state / 'build/installed.json').write_text('{"keep": true}')
        self.assertFalse(patch.migrate_state(), 'nothing to do: already migrated')
        self.assertEqual(json.loads((state / 'build/installed.json').read_text()), {'keep': True})
        self.assertTrue((self.project / 'build/installed.json').is_file(),
                        'the legacy copy is left for a human to remove')

    def test_explicit_paths_disable_migration(self):
        self.assertFalse(patch.migrate_state(build=self.base / 'x', backups=self.base / 'y'))


if __name__ == '__main__':
    unittest.main()
