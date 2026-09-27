import importlib.util
from pathlib import Path
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('patch_desktop', root / 'patch_desktop.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)

SOURCES = {
    'index.ts': b'export default {}\n',
    'package.json': b'{"name":"x"}\n',
    'src/quota.mjs': b'export const q = 1\n',
}


class PluginInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.source = self.base / 'source'
        for name, body in SOURCES.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        self.plugin = self.base / 'config/plugins/local-telemetry'
        self.cleanup = self.base / 'backup/plugin-install-failed'

    def tearDown(self):
        self.tmp.cleanup()

    def run_install(self, **overrides):
        kwargs = dict(source=self.source, plugin=self.plugin,
                      cleanup_into=self.cleanup, fail_after_files=None)
        kwargs.update(overrides)
        return patch.install_plugin(**kwargs)

    def assertSourcesWritten(self):
        for name, body in SOURCES.items():
            self.assertEqual((self.plugin / name).read_bytes(), body, name)

    def test_missing_plugin_dir_is_created_and_filled(self):
        result = self.run_install()
        self.assertEqual(result['status'], 'installed')
        self.assertSourcesWritten()

    def test_empty_leftover_plugin_dir_is_filled_instead_of_refused(self):
        (self.plugin / 'src').mkdir(parents=True)
        result = self.run_install()
        self.assertEqual(result['status'], 'installed')
        self.assertSourcesWritten()

    def test_matching_existing_plugin_is_left_alone(self):
        for name, body in SOURCES.items():
            target = self.plugin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        before = (self.plugin / 'index.ts').stat().st_mtime_ns
        result = self.run_install()
        self.assertEqual(result['status'], 'already-installed')
        self.assertEqual((self.plugin / 'index.ts').stat().st_mtime_ns, before)

    def test_conflicting_plugin_files_are_refused_and_left_untouched(self):
        self.plugin.mkdir(parents=True)
        (self.plugin / 'index.ts').write_bytes(b'custom user plugin')
        with self.assertRaises(patch.PluginConflict) as ctx:
            self.run_install()
        self.assertIn('index.ts', str(ctx.exception))
        self.assertEqual((self.plugin / 'index.ts').read_bytes(), b'custom user plugin')

    def test_failure_moves_leftover_aside_and_reports_the_real_error(self):
        (self.plugin / 'src').mkdir(parents=True)
        with self.assertRaises(RuntimeError) as ctx:
            self.run_install(fail_after_files=1)
        self.assertIn('simulated failure', str(ctx.exception))
        self.assertFalse(self.plugin.exists(), 'leftover dir must be moved aside, never deleted')
        moved = list(self.cleanup.glob('local-telemetry*'))
        self.assertEqual(len(moved), 1, moved)

    def test_cleanup_collision_never_masks_the_original_error(self):
        (self.plugin / 'src').mkdir(parents=True)
        self.cleanup.mkdir(parents=True)
        (self.cleanup / 'local-telemetry').mkdir()
        (self.cleanup / 'occupied').write_bytes(b'x')
        with self.assertRaises(RuntimeError) as ctx:
            self.run_install(fail_after_files=1)
        self.assertIn('simulated failure', str(ctx.exception))
        self.assertTrue((self.cleanup / 'occupied').exists())
        self.assertFalse(self.plugin.exists(), 'leftover dir must still be moved aside')
        self.assertEqual(sorted(p.name for p in self.cleanup.glob('local-telemetry*')),
                         ['local-telemetry', 'local-telemetry-2'])

    def test_second_cleanup_run_does_not_collide_with_the_first(self):
        for _ in range(2):
            (self.plugin / 'src').mkdir(parents=True, exist_ok=True)
            with self.assertRaises(RuntimeError):
                self.run_install(fail_after_files=1)
        moved = sorted(p.name for p in self.cleanup.glob('local-telemetry*'))
        self.assertEqual(len(moved), 2, moved)

    def test_complete_plugin_write_failure_keeps_the_directory(self):
        """A failure after every file is written leaves a good plugin in place."""
        with self.assertRaises(RuntimeError):
            self.run_install(fail_after_files=len(SOURCES))
        self.assertTrue(self.plugin.exists())
        self.assertSourcesWritten()


if __name__ == '__main__':
    unittest.main()
