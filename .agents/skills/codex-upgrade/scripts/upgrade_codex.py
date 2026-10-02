#!/usr/bin/env python3
"""Safely upgrade this Mac's isolated Codex CLI installation."""

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REGISTRY = "https://registry.npmjs.org"
PACKAGE = "@openai/codex"
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


def run(args, timeout=120):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited with status {result.returncode}")
    return result.stdout.strip()


def codex_version(binary):
    output = run([str(binary), "--version"], timeout=20)
    match = re.fullmatch(r"codex-cli ([0-9]+\.[0-9]+\.[0-9]+)", output)
    if not match:
        raise RuntimeError(f"Unexpected Codex version output: {output[:100]}")
    return match.group(1)


def native_binary(prefix):
    packages = prefix / "lib/node_modules/@openai/codex/node_modules"
    candidates = list(packages.glob("@openai/codex-*/vendor/*/bin/codex"))
    if len(candidates) != 1 or not candidates[0].is_file():
        raise RuntimeError(f"Expected exactly one native Codex binary in {prefix}")
    return candidates[0]


def replace_link(link, destination):
    temporary = link.with_name(f".codex-upgrade-link-{os.getpid()}")
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError(f"Temporary link already exists: {temporary}")
    try:
        os.symlink(destination, temporary)
        os.replace(temporary, link)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="Read current and latest stable versions")
    action.add_argument("--upgrade", action="store_true", help="Install and activate the latest stable version")
    args = parser.parse_args()

    user_home = Path.home()
    link = user_home / ".local/bin/codex"
    releases = user_home / ".local/share/codex/releases"
    if args.check:
        return inspect_and_upgrade(args, link, releases)

    with (releases.parent / ".codex-upgrade.lock").open("a+") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another Codex upgrade is already running") from error
        return inspect_and_upgrade(args, link, releases)


def inspect_and_upgrade(args, link, releases):
    found = shutil.which("codex")
    if not link.is_symlink() or not found or Path(found) != link:
        raise RuntimeError("Codex on PATH is not this machine's expected symlink; inspect the installation")
    current_binary = link.resolve(strict=True)
    try:
        relative = current_binary.relative_to(releases.resolve(strict=True))
    except ValueError as error:
        raise RuntimeError("Codex symlink points outside the isolated releases directory") from error
    current = codex_version(current_binary)
    if not relative.parts or relative.parts[0] != current:
        raise RuntimeError("Codex symlink version and release directory disagree")

    latest = run(["npm", "view", PACKAGE, "dist-tags.latest", "--registry", REGISTRY], timeout=120)
    if not VERSION.fullmatch(latest):
        raise RuntimeError(f"npm returned an unexpected stable version: {latest[:100]}")
    result = {"current": current, "latest": latest, "link": str(link)}
    if tuple(map(int, latest.split("."))) <= tuple(map(int, current.split("."))):
        result["status"] = "up_to_date" if latest == current else "newer_than_registry"
        print(json.dumps(result))
        return
    if args.check:
        result["status"] = "update_available"
        print(json.dumps(result))
        return

    target = releases / latest
    if target.exists():
        new_binary = native_binary(target)
        if codex_version(new_binary) != latest:
            raise RuntimeError("Existing target release has the wrong version; refusing to overwrite it")
    else:
        stage = Path(tempfile.mkdtemp(prefix=f".{latest}.staging-", dir=releases))
        try:
            run(["npm", "install", "-g", "--prefix", str(stage), f"{PACKAGE}@{latest}", "--registry", REGISTRY], timeout=300)
            new_binary = native_binary(stage)
            if codex_version(new_binary) != latest:
                raise RuntimeError("Installed Codex version did not match the npm stable release")
            stage.rename(target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        new_binary = native_binary(target)

    replace_link(link, new_binary)
    try:
        if link.resolve(strict=True) != new_binary.resolve(strict=True) or codex_version(link) != latest:
            raise RuntimeError("PATH Codex did not resolve to the new version")
    except Exception:
        replace_link(link, current_binary)
        raise
    result.update(status="upgraded", installed=latest, previous_binary=str(current_binary))
    try:
        run([str(new_binary), "doctor", "--summary", "--no-color"], timeout=90)
        result["doctor"] = "passed"
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        result.update(doctor="warning", doctor_error=str(error))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Codex upgrade stopped: {error}", file=sys.stderr)
        sys.exit(1)
