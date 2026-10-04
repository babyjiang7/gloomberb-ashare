import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "setup-python.py"
SPEC = importlib.util.spec_from_file_location("ashare_setup_python", SCRIPT)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)

LOCK = "# Release dependency\npypinyin==0.55.0 --hash=sha256:" + "a" * 64 + "\n"


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / ".venv"
        self.lock = self.root / "requirements-lock.txt"
        self.lock.write_text(LOCK, encoding="utf-8")

    def environment(self, directory=None, system_packages=False):
        directory = directory or self.directory
        directory.mkdir()
        (directory / "pyvenv.cfg").write_text(
            "include-system-site-packages = " + ("true" if system_packages else "false") + "\n", encoding="utf-8")
        python = setup.venv_python_path(directory)
        python.parent.mkdir()
        python.touch()
        return python

    def subprocess_result(self, command, **kwargs):
        if setup.PROBE in command:
            result = {"prefix": str(self.directory), "basePrefix": str(self.root / "base-python"), "version": [3, 11, 1]}
        elif setup.DEPENDENCY_PROBE in command:
            result = {"version": "0.55.0", "moduleVersion": "0.55.0"}
        else:
            return subprocess.CompletedProcess(command, 0)
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(result))

    def test_platform_paths(self):
        self.assertEqual(setup.venv_python_path(self.directory, "win32"), self.directory / "Scripts" / "python.exe")
        self.assertEqual(setup.venv_python_path(self.directory, "darwin"), self.directory / "bin" / "python")
        self.assertEqual(setup.venv_python_path(self.directory, "linux"), self.directory / "bin" / "python")

    def test_multiline_lock_accepts_both_release_artifact_hashes(self):
        contents = ("# Release artifacts\npypinyin==0.55.0 " + chr(92) + "\n    --hash=sha256:" +
                    "a" * 64 + " " + chr(92) + "\n    --hash=sha256:" + "b" * 64 + "\n")
        self.lock.write_text(contents, encoding="utf-8")
        setup.validate_lock(self.lock)

    def test_missing_check_never_creates_an_environment_or_calls_python(self):
        before = set(self.root.iterdir())
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "does not exist"):
                setup.setup(self.directory, self.lock, check=True)
            builder.assert_not_called()
            run.assert_not_called()
        self.assertEqual(set(self.root.iterdir()), before)

    def test_successful_check_only_uses_isolated_read_probes(self):
        self.environment()
        before = {file.relative_to(self.root): file.read_bytes() for file in self.root.rglob("*") if file.is_file()}
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run", side_effect=self.subprocess_result) as run, patch("sys.stdout", new=io.StringIO()):
            setup.setup(self.directory, self.lock, check=True)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                command = call.args[0]
                self.assertEqual(command[1:4], ["-I", "-B", "-c"])
                self.assertNotIn("pip", command)
        after = {file.relative_to(self.root): file.read_bytes() for file in self.root.rglob("*") if file.is_file()}
        self.assertEqual(after, before)

    def test_lock_is_validated_before_any_creation_or_install(self):
        invalid_locks = ["pypinyin==0.55.0\n", LOCK + "pandas==3.0.6\n", LOCK.replace("0.55.0", "0.55.1"),
                         LOCK + "--index-url https://example.com/simple\n", LOCK.replace("a" * 64, "a" * 63)]
        for contents in invalid_locks:
            with self.subTest(contents=contents), patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run") as run:
                self.lock.write_text(contents, encoding="utf-8")
                with self.assertRaisesRegex(setup.SetupError, "lock must contain only"):
                    setup.setup(self.directory, self.lock)
                builder.assert_not_called()
                run.assert_not_called()
                self.assertFalse(self.directory.exists())

    def test_existing_non_virtual_directory_is_left_untouched(self):
        self.directory.mkdir()
        marker = self.directory / "important.txt"
        marker.write_text("keep", encoding="utf-8")
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "usable .venv was not found"):
                setup.setup(self.directory, self.lock)
            builder.assert_not_called()
            run.assert_not_called()
        self.assertEqual(marker.read_text(), "keep")

    def test_system_package_environment_is_rejected_before_install(self):
        self.environment(system_packages=True)
        with patch.object(setup.subprocess, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "must not inherit"):
                setup.setup(self.directory, self.lock)
            run.assert_not_called()

    def test_interpreter_for_another_environment_cannot_be_modified(self):
        self.environment()
        result = {"prefix": str(self.root / "another-env"), "basePrefix": str(self.root / "base"), "version": [3, 11, 0]}
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(result))) as run:
            with self.assertRaisesRegex(setup.SetupError, "does not belong"):
                setup.setup(self.directory, self.lock)
            self.assertEqual(run.call_count, 1)

    def test_existing_old_python_is_never_upgraded(self):
        self.environment()
        result = {"prefix": str(self.directory), "basePrefix": str(self.root / "base"), "version": [3, 9, 19]}
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(result))) as run:
            with self.assertRaisesRegex(setup.SetupError, "will not upgrade"):
                setup.setup(self.directory, self.lock)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 1)

    def test_explicit_install_is_hash_required_and_never_upgrades_pip(self):
        python = self.environment()
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run", side_effect=self.subprocess_result) as run, patch("sys.stdout", new=io.StringIO()):
            setup.setup(self.directory, self.lock)
            builder.assert_not_called()
            command = run.call_args_list[1].args[0]
            self.assertEqual(command[:7], [str(python), "-I", "-B", "-m", "pip", "--isolated", "install"])
            self.assertIn("--require-hashes", command)
            self.assertIn("--no-deps", command)
            self.assertIn("--no-cache-dir", command)
            self.assertNotIn("--upgrade", command)
            self.assertEqual(command[-2:], ["-r", str(self.lock)])

    def test_new_environment_uses_non_destructive_venv_flags(self):
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run", side_effect=self.subprocess_result), patch("sys.stdout", new=io.StringIO()):
            builder.return_value.create.side_effect = self.environment
            setup.setup(self.directory, self.lock)
            builder.assert_called_once_with(with_pip=True, clear=False, upgrade=False, system_site_packages=False)
            builder.return_value.create.assert_called_once_with(self.directory)

    def test_non_venv_name_and_symlink_are_rejected(self):
        other = self.root / "other"
        with self.assertRaisesRegex(setup.SetupError, "must be named .venv"):
            setup.checked_venv_directory(other)
        other.mkdir()
        try:
            self.directory.symlink_to(other, target_is_directory=True)
        except OSError:
            self.skipTest("Creating directory symlinks is not allowed on this platform.")
        with patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "symbolic links"):
                setup.setup(self.directory, self.lock)
            builder.assert_not_called()
            run.assert_not_called()

    def test_partial_install_failure_does_not_delete_an_existing_environment(self):
        self.environment()
        marker = self.directory / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        def fail_pip(command, **kwargs):
            if "pip" in command:
                return subprocess.CompletedProcess(command, 1)
            return self.subprocess_result(command, **kwargs)
        with patch.object(setup.subprocess, "run", side_effect=fail_pip):
            with self.assertRaisesRegex(setup.SetupError, "was not deleted"):
                setup.setup(self.directory, self.lock)
        self.assertEqual(marker.read_text(), "keep")

    def test_wrong_dependency_version_fails_check_without_install(self):
        self.environment()
        def wrong_dependency(command, **kwargs):
            if setup.DEPENDENCY_PROBE in command:
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"version": "0.54.0", "moduleVersion": "0.54.0"}))
            return self.subprocess_result(command, **kwargs)
        with patch.object(setup.subprocess, "run", side_effect=wrong_dependency) as run:
            with self.assertRaisesRegex(setup.SetupError, "pypinyin==0.55.0 is required"):
                setup.setup(self.directory, self.lock, check=True)
            self.assertEqual(run.call_count, 2)
            self.assertTrue(all("pip" not in call.args[0] for call in run.call_args_list))

    def test_main_check_failure_has_actionable_output_and_exit_code(self):
        with patch("sys.stderr", new=io.StringIO()) as error:
            self.assertEqual(setup.main(["--check"], project_root=self.root), 1)
            self.assertIn("without --check", error.getvalue())

    def test_override_requires_absolute_path_without_creating_any_directory(self):
        with patch("sys.stderr", new=io.StringIO()) as error, patch.object(setup.venv, "EnvBuilder") as builder:
            self.assertEqual(setup.main(["--venv-dir", "relative/.venv"], project_root=self.root), 1)
            self.assertIn("absolute path", error.getvalue())
            builder.assert_not_called()

    def test_outdated_setup_python_does_not_create_or_install_anything(self):
        with patch.object(setup.sys, "version_info", (3, 9, 19)), patch.object(setup.venv, "EnvBuilder") as builder, patch.object(setup.subprocess, "run") as run:
            with self.assertRaisesRegex(setup.SetupError, "3.10 or newer"):
                setup.setup(self.directory, self.lock)
            builder.assert_not_called()
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
