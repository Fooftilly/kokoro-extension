#!/usr/bin/env python3
"""Send native X11 Alt+A for headed Firefox extension-command acceptance.

Must run in a process separate from Selenium/geckodriver: sharing one
DISPLAY with in-process ctypes X11 + Firefox caused munmap_chunk aborts
on CI. Focuses a Firefox/Navigator window then plays the chord.
"""
import json
import sys

from native_chromium_x11 import X11Session


def main(argv):
    if not argv:
        raise RuntimeError('Usage: native-firefox-keys.py Alt_L a')
    session = X11Session(focus_name_substr='Firefox')
    try:
        session.chord(argv)
        print(json.dumps(session.result(' '.join(argv))))
    finally:
        session.close()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as exc:
        print(f'Native Firefox X11 key input failed: {exc}', file=sys.stderr)
        sys.exit(1)
