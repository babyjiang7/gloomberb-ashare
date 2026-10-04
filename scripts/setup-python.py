#!/usr/bin/env python3
"""Prepare or check the plugin's own Python environment; never upgrade Python."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import venv

REQUIRED_VERSION = "0.55.0"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROBE = """import importlib.metadata,json,sys
print(json.dumps({'prefix':sys.prefix,'basePrefix':sys.base_prefix,'version':list(sys.version_info[:3])}))
"""
DEPENDENCY_PROBE = """import importlib.metadata,json,pypinyin
print(json.dumps({'version':importlib.metadata.version('pypinyin'),'moduleVersion':pypinyin.__version__}))
"""


class SetupError(RuntimeError):
    pass


def venv_python_path(directory, platform=None):
    directory = Path(directory)
    return directory / ("Scripts" if (platform or sys.platform) == "win32" else "bin") / (
        "python.exe" if (platform or sys.platform) == "win32" else "python")


def checked_venv_directory(directory):
    candidate = Path(os.path.abspath(Path(directory).expanduser()))
    if candidate.name != ".venv":
        raise SetupError("The environment directory must be named .venv; choose an existing parent directory.")
    if not candidate.parent.is_dir():
        raise SetupError("The environment's parent directory must already exist.")
    if candidate.is_symlink() or candidate.parent.resolve() != candidate.parent:
        raise SetupError("Use a real directory path; .venv and its parent path must not be symbolic links.")
    return candidate


def validate_lock(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise SetupError("requirements-lock.txt is missing or unreadable; restore it from the plugin release.") from error
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    requirement = " ".join(lines).replace("\\", " ")
    if not re.fullmatch(r"pypinyin==0\.55\.0(?:\s+--hash=sha256:[a-fA-F0-9]{64})+", requirement.strip()):
        raise SetupError("The lock must contain only pypinyin==0.55.0 with SHA-256 hashes; restore the release lock.")


def run_python(python, arguments):
    try:
        result = subprocess.run([str(python), "-I", "-B", *arguments], text=True, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SetupError("The environment's Python could not run; check this .venv manually, without replacing another environment.") from error
    if result.returncode:
        raise SetupError("The environment check failed. Run the setup command without --check to install its locked dependency.")
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise SetupError("The environment's Python returned an invalid check result.") from error


def verify_environment(directory):
    python = venv_python_path(directory)
    config = directory / "pyvenv.cfg"
    if not directory.is_dir() or not config.is_file() or not python.is_file():
        raise SetupError("A usable .venv was not found. Run: python3 scripts/setup-python.py (Windows: py -3 scripts/setup-python.py).")
    try:
        settings = dict(line.split("=", 1) for line in config.read_text(encoding="utf-8").splitlines() if "=" in line)
    except (OSError, ValueError) as error:
        raise SetupError("The existing .venv has an unreadable pyvenv.cfg; inspect it manually.") from error
    settings = {key.strip().lower(): value.strip().lower() for key, value in settings.items()}
    if settings.get("include-system-site-packages") != "false":
        raise SetupError("The existing .venv must not inherit system packages; choose a separate .venv rather than modifying it.")
    info = run_python(python, ["-c", PROBE])
    if not isinstance(info, dict) or not isinstance(info.get("prefix"), str) or not isinstance(info.get("basePrefix"), str):
        raise SetupError("The environment's Python did not identify its virtual environment.")
    if Path(info["prefix"]).resolve() != directory.resolve() or Path(info["prefix"]).resolve() == Path(info["basePrefix"]).resolve():
        raise SetupError("The existing Python does not belong to the selected .venv; no packages were changed.")
    version = info.get("version")
    if not isinstance(version, list) or len(version) < 2 or not all(isinstance(value, int) for value in version):
        raise SetupError("The environment's Python version could not be verified.")
    if tuple(version[:2]) < (3, 10):
        raise SetupError("Python 3.10 or newer is required. Choose another .venv; this script will not upgrade the existing interpreter.")
    return python


def verify_dependency(python):
    info = run_python(python, ["-c", DEPENDENCY_PROBE])
    if not isinstance(info, dict) or info.get("version") != REQUIRED_VERSION or info.get("moduleVersion") != REQUIRED_VERSION:
        raise SetupError("pypinyin==0.55.0 is required. Run the setup command without --check to install the release lock.")


def setup(directory, lock, check=False):
    if sys.version_info < (3, 10):
        raise SetupError("Run this script with Python 3.10 or newer. It will not install or upgrade Python.")
    directory = checked_venv_directory(directory)
    validate_lock(lock)
    if not directory.exists():
        if check:
            raise SetupError("The plugin's .venv does not exist. Run the setup command without --check first.")
        try:
            venv.EnvBuilder(with_pip=True, clear=False, upgrade=False, system_site_packages=False).create(directory)
        except (OSError, subprocess.SubprocessError) as error:
            raise SetupError("Could not create .venv. Check Python's venv/ensurepip support; any partial directory was left untouched.") from error
    python = verify_environment(directory)
    if not check:
        command = [str(python), "-I", "-B", "-m", "pip", "--isolated", "install", "--require-hashes", "--no-deps",
                   "--no-cache-dir", "--no-compile", "--disable-pip-version-check", "--no-input", "-r", str(Path(lock).resolve())]
        try:
            result = subprocess.run(command, check=False)
        except OSError as error:
            raise SetupError("pip could not run inside .venv; check this environment's pip installation.") from error
        if result.returncode:
            raise SetupError("Locked dependency installation failed. Check the network and rerun setup; the environment was not deleted.")
    verify_dependency(python)
    print(f"Ready: pypinyin=={REQUIRED_VERSION}; Python executable: {python}")
    return python


def main(argv=None, project_root=PROJECT_ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check an existing environment without networking, installation, or environment writes.")
    parser.add_argument("--venv-dir", type=Path, help="Optional absolute path to a .venv directory beneath an existing real directory; use its Python in plugin Setup.")
    args = parser.parse_args(argv)
    try:
        if args.venv_dir is not None and not args.venv_dir.is_absolute():
            raise SetupError("--venv-dir requires an absolute path ending in .venv.")
        setup(args.venv_dir or Path(project_root) / ".venv", Path(project_root) / "requirements-lock.txt", args.check)
    except SetupError as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
