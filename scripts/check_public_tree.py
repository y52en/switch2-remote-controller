#!/usr/bin/env python3
"""Reject private configuration and legacy transport artifacts."""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".cache", ".pio", ".venv", "node_modules", ".wrangler"}
SKIP_SUFFIXES = {".a", ".bin", ".elf", ".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_CONFIG_TEMPLATES = {".env.example", ".dev.vars.example"}
FORBIDDEN_PATTERNS = {
    "private Windows path": re.compile(r"[A-Za-z]:\\(?:Users|code)\\", re.IGNORECASE),
    "private WSL path": re.compile(r"/mnt/[a-z]/(?:Users|code)/", re.IGNORECASE),
    "legacy host setting": re.compile(r"\b(?:PI_HOST|PI_PORT|CONTROLLER_HOSTS|LINK_TOKEN)\b"),
    "legacy wire protocol": re.compile(r"\bRPI2\b"),
    "private network tooling": re.compile(r"\bOPENWRT_[A-Z_]+\b"),
}


def files():
    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if tracked.returncode == 0:
        for relative in tracked.stdout.split("\0"):
            if relative:
                yield ROOT / relative
        return

    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def is_private_config(name: str) -> bool:
    if name in ALLOWED_CONFIG_TEMPLATES:
        return False
    return (
        name == ".env"
        or name.startswith(".env.")
        or name == ".dev.vars"
        or name.startswith(".dev.vars.")
    )


def main() -> int:
    failures: list[str] = []
    checked = 0
    for path in files():
        relative = path.relative_to(ROOT)
        if relative == Path("scripts/check_public_tree.py"):
            continue
        if is_private_config(path.name):
            failures.append(f"private configuration file: {relative}")
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        checked += 1
        for label, pattern in FORBIDDEN_PATTERNS.items():
            if pattern.search(text):
                failures.append(f"{label}: {relative}")
    if failures:
        print("Public-tree check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(f"Public-tree check passed ({checked} text files checked).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
