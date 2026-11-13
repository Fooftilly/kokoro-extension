#!/usr/bin/env python3
"""Smoke-test native Alt+A XTest helper under isolated Xvfb."""
import ctypes
import json
from pathlib import Path
import subprocess
import sys


def main():
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XCreateSimpleWindow.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
        ctypes.c_ulong, ctypes.c_ulong]
    x11.XCreateSimpleWindow.restype = ctypes.c_ulong
    x11.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
    x11.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XSetInputFocus.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XPending.argtypes = [ctypes.c_void_p]
    x11.XPending.restype = ctypes.c_int
    x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError('X11 test server unavailable')
    try:
        root = x11.XDefaultRootWindow(display)
        window = x11.XCreateSimpleWindow(display, root, 0, 0, 300, 100, 0, 0, 0)
        x11.XSelectInput(display, window, 1 | 2)  # KeyPress, KeyRelease
        x11.XMapWindow(display, window)
        x11.XSetInputFocus(display, window, 1, 0)
        x11.XSync(display, 0)
        result = subprocess.run([
            sys.executable,
            str(Path(__file__).with_name('native-chromium-keys.py')),
            'Alt_L', 'a',
        ], check=True, capture_output=True, text=True, timeout=8)
        payload = json.loads(result.stdout)
        assert payload['x11XTest'] is True
        assert payload['nativeKeys'] == 'Alt_L a'
        assert payload['focusedWindow'] == hex(window)
        x11.XSync(display, 0)
        event_types = []
        while x11.XPending(display):
            buf = ctypes.create_string_buffer(192)
            x11.XNextEvent(display, buf)
            event_type = int.from_bytes(buf.raw[:4], 'little')
            if event_type in (2, 3):
                event_types.append(event_type)
        # Alt press, a press, a release, Alt release
        if event_types != [2, 2, 3, 3]:
            raise RuntimeError(
                f'Expected Alt+a press/release events, got: {event_types}')
        print('Native X11 Alt+A key test passed:', payload)
    finally:
        x11.XCloseDisplay(display)


if __name__ == '__main__':
    main()
