#!/usr/bin/env python3
"""Convenience launcher for the HTML PPT Editor (web app).

This project is a React + Vite + TypeScript app — there is no Python backend.
This script just exists so you can hit ▶ Run in your IDE: it starts the Vite
dev server (which first rebuilds the injected editor bundle) and opens your
browser at the served URL.

Equivalent to running `npm run dev` in a terminal.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-9;]*m")
URL = re.compile(r"https?://(?:localhost|127\.0\.0\.1):\d+/?")


def find_npm() -> str | None:
    # On Windows npm resolves to npm.cmd; shutil.which handles that.
    return shutil.which("npm")


def ensure_dependencies(npm: str) -> None:
    if (ROOT / "node_modules").is_dir():
        return
    print("node_modules not found — running `npm install` (first run only)...\n", flush=True)
    subprocess.run([npm, "install"], cwd=ROOT, check=True)
    print("\nDependencies installed.\n", flush=True)


def main() -> int:
    os.chdir(ROOT)

    # Vite prints UTF-8 (✓, ➜). On consoles with a non-UTF-8 locale (e.g. cp949
    # on Korean Windows) reading/writing that output would raise, so force UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

    npm = find_npm()
    if not npm:
        print(
            "Node.js / npm was not found on your PATH.\n"
            "Install Node.js 18+ from https://nodejs.org and try again.",
            file=sys.stderr,
        )
        return 1

    try:
        ensure_dependencies(npm)
    except subprocess.CalledProcessError as exc:
        print(f"`npm install` failed (exit {exc.returncode}).", file=sys.stderr)
        return exc.returncode

    print("Starting dev server (npm run dev). Press Ctrl+C to stop.\n", flush=True)

    # Stream the dev server output; open the browser once the URL appears.
    proc = subprocess.Popen(
        [npm, "run", "dev"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    opened = False

    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            sys.stdout.write(raw_line)
            sys.stdout.flush()
            if not opened:
                match = URL.search(ANSI.sub("", raw_line))
                if match:
                    webbrowser.open(match.group(0))
                    opened = True
        return proc.wait()
    except KeyboardInterrupt:
        print("\nStopping dev server...", flush=True)
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
