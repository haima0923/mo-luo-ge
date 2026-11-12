"""Run with python3 -m unittest discover -s test -p '*_test.py'. No system services are touched."""
import importlib.util
import json
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_installer', ROOT / 'deploy/native/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='crm-upgrade-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.base = self.root / 'application'
        self.config = self.root / 'configuration'
        self.config.mkdir()
        self.old = self.base / 'releases/old'
        self.old.mkdir(parents=True)
        (self.old / 'server.mjs').write_text('// existing application')
        (self.base / 'current').symlink_to(self.old)
        self.unit = self.root / 'crm.service'
        self.previous_unit = installer.MARKER + '\nExisting service\n'
        self.unit.write_text(self.previous_unit)
        (self.config / 'state.json').write_text(json.dumps({'node': '/test/runtime/bin/node'}))
        (self.config / 'app.env').write_text('APP_PASSWORD=synthetic-test-only\n')
        self.data = self.root / 'customer-data'
        self.data.mkdir()
        for name in ('crm.sqlite', 'company-knowledge.sqlite', 'intelligence.sqlite', 'qwen-settings.json'):
            (self.data / name).write_text('synthetic-preserved-content')
        (self.data / 'intelligence-uploads').mkdir()
        (self.data / 'intelligence-uploads/source.png').write_text('synthetic-preserved-content')
        for name, value in {'BASE': self.base, 'CONFIG': self.config, 'DATA': self.data,
                            'SERVICE_UNIT': self.unit, 'APPLICATION': ROOT}.items():
            patcher = patch.object(installer, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.calls = []

    def record_command(self, arguments, **kwargs):
        self.calls.append([str(part) for part in arguments])
        return subprocess.CompletedProcess(arguments, 0)

    def check_private_files(self):
        self.assertEqual((self.config / 'app.env').read_text(), 'APP_PASSWORD=synthetic-test-only\n')
        for item in self.data.rglob("*"):
            if item.is_file():
                self.assertEqual(item.read_text(), 'synthetic-preserved-content')

    def test_upgrade_0311_activates_0312_and_preserves_data(self):
        with patch.object(installer, 'app_status', return_value={'version': '0.3.11'}), \
             patch.object(installer, 'website_status', return_value=(200, None)), \
             patch.object(installer, 'backup') as backup, \
             patch.object(installer, 'run', side_effect=self.record_command), \
             patch.object(installer, 'wait_for_app', return_value={'version': '0.3.12'}), \
             patch.object(installer, 'check_navigation') as navigation:
            installer.upgrade()
        release = (self.base / 'current').resolve()
        self.assertNotEqual(release, self.old)
        self.assertTrue(release.name.startswith('v0.3.12-'))
        self.assertEqual(json.loads((release / 'package.json').read_text())['version'], '0.3.12')
        self.assertEqual((release / 'lib/product-match.mjs').read_bytes(), (ROOT / 'lib/product-match.mjs').read_bytes())
        self.assertEqual((release / 'lib/qwen.mjs').read_bytes(), (ROOT / 'lib/qwen.mjs').read_bytes())
        self.assertFalse((release / '.git').exists())
        self.assertFalse((release / 'data').exists())
        self.assertIn(str(release / 'server.mjs'), self.unit.read_text())
        self.assertEqual(self.calls[0][0:2], ['/test/runtime/bin/node', '--test'])
        self.assertIn(['systemctl', 'restart', 'morocco-ai-crm'], self.calls)
        backup.assert_called_once()
        navigation.assert_called_once()
        self.assertTrue((self.old / 'server.mjs').is_file())
        self.check_private_files()

    def test_failed_health_check_restores_previous_release_and_service(self):
        with patch.object(installer, 'app_status', return_value={'version': '0.3.10'}), \
             patch.object(installer, 'website_status', return_value=(200, None)), \
             patch.object(installer, 'backup'), \
             patch.object(installer, 'run', side_effect=self.record_command), \
             patch.object(installer, 'wait_for_app', side_effect=RuntimeError('simulated health check failure')):
            with self.assertRaisesRegex(RuntimeError, 'simulated health check failure'):
                installer.upgrade()
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertEqual(self.unit.read_text(), self.previous_unit)
        self.assertEqual(self.calls.count(['systemctl', 'restart', 'morocco-ai-crm']), 2)
        self.check_private_files()

    def test_0312_is_idempotent_without_backup_or_restart(self):
        with patch.object(installer, 'app_status', return_value={'version': '0.3.12'}), \
             patch.object(installer, 'run') as run, patch.object(installer, 'backup') as backup:
            installer.upgrade()
        run.assert_not_called()
        backup.assert_not_called()
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.check_private_files()

    def test_status_accepts_old_and_new_versions_but_requires_password(self):
        for version in ('0.2.4', '0.2.5', '0.2.6', '0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.3.8', '0.3.9', '0.3.10', '0.3.11', '0.3.12'):
            with self.subTest(version=version), patch.object(installer.http.client, 'HTTPConnection') as connection:
                result = connection.return_value.getresponse.return_value
                result.status = 200
                result.read.return_value = json.dumps({'version': version, 'password_required': True}).encode()
                self.assertEqual(installer.app_status()['version'], version)
                result.read.return_value = json.dumps({'version': version, 'password_required': False}).encode()
                with self.assertRaises(RuntimeError):
                    installer.app_status()

    def test_password_reset_preserves_other_config_and_data_and_verifies_login(self):
        previous = 'HOST="127.0.0.1"\nAPP_PASSWORD="old-synthetic"\nDASHSCOPE_API_KEY="synthetic-private-key"\n'
        (self.config / 'app.env').write_text(previous)
        password = 'Test5678'
        with patch.object(installer, 'app_status'), patch.object(installer, 'wait_for_app'), \
             patch.object(installer, 'check_navigation'), patch.object(installer, 'check_password_login') as login, \
             patch.object(installer, 'run', side_effect=self.record_command):
            installer.reset_password(password)
        login.assert_called_once_with(password)
        saved = (self.config / 'app.env').read_text()
        self.assertIn('DASHSCOPE_API_KEY="synthetic-private-key"\n', saved)
        value = next(line.partition('=')[2] for line in saved.splitlines() if line.startswith('APP_PASSWORD='))
        self.assertEqual(shlex.split(value), [password])
        secret = next(line.partition('=')[2] for line in saved.splitlines() if line.startswith('APP_SESSION_SECRET='))
        self.assertEqual(len(shlex.split(secret)[0]), 64)
        self.assertEqual((self.config / 'app.env').stat().st_mode & 0o777, 0o600)
        backups = list(self.config.glob('app.env.before-password-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), previous)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        for item in self.data.rglob('*'):
            if item.is_file():
                self.assertEqual(item.read_text(), 'synthetic-preserved-content')

    def test_password_reset_failure_restores_original_config(self):
        with patch.object(installer, 'app_status'), patch.object(installer, 'wait_for_app'), \
             patch.object(installer, 'check_navigation'), \
             patch.object(installer, 'check_password_login', side_effect=RuntimeError('test failed')), \
             patch.object(installer, 'run', side_effect=self.record_command):
            with self.assertRaisesRegex(RuntimeError, '已恢复原配置'):
                installer.reset_password('Test5678')
        self.check_private_files()
        self.assertEqual(self.calls.count(['systemctl', 'restart', 'morocco-ai-crm']), 2)

    def test_password_reset_rejects_invalid_input_before_mutation(self):
        for value in ('short', 'with\nnewline', 'null\0character'):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                installer.reset_password(value)
        self.check_private_files()
        self.assertEqual(list(self.config.glob('app.env.before-password-*')), [])

    def test_password_checker_requires_authenticated_cookie_and_password_protection(self):
        with patch.object(installer.http.client, 'HTTPConnection') as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.getheader.return_value = 'crm_session=synthetic-cookie; HttpOnly; Secure'
            response.read.return_value = b'{"authenticated":true,"password_required":true}'
            installer.check_password_login('synthetic-test-only')
            self.assertEqual(connection.return_value.request.call_count, 2)
            response.read.return_value = b'{"authenticated":false,"password_required":true}'
            with self.assertRaisesRegex(RuntimeError, '登录会话验证失败'):
                installer.check_password_login('synthetic-test-only')


if __name__ == '__main__':
    unittest.main()
