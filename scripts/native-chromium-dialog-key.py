#!/usr/bin/env python3
"""Send native X11 Tab/Return for Chromium's optional host-permission dialog.

The JavaScript harness still must verify real chrome.permissions state.
No permissions are pregranted, and browser APIs are not modified.
"""
import sys

from native_chromium_x11 import run_taps


def main():
    # Chromium defaults this dialog to Cancel; Tab then Return selects Allow.
    run_taps(['Tab', 'Return'])


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Native Chromium dialog X11 input failed: {exc}', file=sys.stderr)
        sys.exit(1)
