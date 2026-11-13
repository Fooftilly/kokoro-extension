#!/usr/bin/env python3
"""Send native X11 key chords for headed Chromium extension-command acceptance.

Playwright/CDP keyboard events do not reach chrome.commands.onCommand. Real
XTest key events do. Used for Alt+A `read-article` in live Chromium acceptance.
"""
import sys

from native_chromium_x11 import run_chord


def main(argv):
    if not argv:
        raise RuntimeError('Usage: native-chromium-keys.py Alt_L a')
    run_chord(argv)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as exc:
        print(f'Native Chromium X11 key input failed: {exc}', file=sys.stderr)
        sys.exit(1)
