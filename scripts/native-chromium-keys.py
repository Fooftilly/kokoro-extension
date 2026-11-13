#!/usr/bin/env python3
"""Send native X11 key chords for headed Chromium extension-command acceptance.

Playwright/CDP keyboard events do not reach chrome.commands.onCommand. Real
XTest key events do. Used for Alt+A `read-article` in live Chromium acceptance.
"""
import ctypes
import json
import os
import sys
import time

# X11 keysyms used by the live harness. Keep the map small and explicit.
KEYSYMS = {
    'Alt_L': 0xffe9,
    'a': 0x0061,
    'A': 0x0041,
}


def send_chord(display, x11, xtest, names):
    codes = []
    for name in names:
        keysym = KEYSYMS.get(name)
        if keysym is None:
            raise RuntimeError('Unsupported key name: ' + name)
        keycode = x11.XKeysymToKeycode(display, keysym)
        if not keycode:
            raise RuntimeError('X11 has no keycode for ' + name)
        codes.append((name, keycode))
    for name, keycode in codes:
        if not xtest.XTestFakeKeyEvent(display, keycode, 1, 0):
            raise RuntimeError('X11 rejected key press for ' + name)
        x11.XSync(display, 0)
        time.sleep(0.03)
    for name, keycode in reversed(codes):
        if not xtest.XTestFakeKeyEvent(display, keycode, 0, 0):
            raise RuntimeError('X11 rejected key release for ' + name)
        x11.XSync(display, 0)
        time.sleep(0.03)


def main(argv):
    if not os.environ.get('DISPLAY'):
        raise RuntimeError('DISPLAY must identify the headed Chromium X11 server')
    if not argv:
        raise RuntimeError('Usage: native-chromium-keys.py Alt_L a')

    x11 = ctypes.CDLL('libX11.so.6')
    xtest = ctypes.CDLL('libXtst.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.restype = ctypes.c_int
    x11.XGetInputFocus.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
    x11.XGetInputFocus.restype = ctypes.c_int
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_uint
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XSync.restype = ctypes.c_int
    xtest.XTestQueryExtension.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
    xtest.XTestQueryExtension.restype = ctypes.c_int
    xtest.XTestFakeKeyEvent.argtypes = [
        ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeKeyEvent.restype = ctypes.c_int

    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError('Cannot connect to X11 display: ' + os.environ['DISPLAY'])
    try:
        versions = [ctypes.c_int() for _ in range(4)]
        if not xtest.XTestQueryExtension(
                display, *[ctypes.byref(item) for item in versions]):
            raise RuntimeError('X11 server does not support XTest keyboard input')
        focused = ctypes.c_ulong()
        revert = ctypes.c_int()
        x11.XGetInputFocus(display, ctypes.byref(focused), ctypes.byref(revert))
        if focused.value in (0, 1):
            raise RuntimeError('No focused application window for Chromium key chord')

        send_chord(display, x11, xtest, argv)
        print(json.dumps({
            'focusedWindow': hex(focused.value),
            'nativeKeys': ' '.join(argv),
            'x11XTest': True,
        }))
    finally:
        x11.XCloseDisplay(display)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as exc:
        print(f'Native Chromium X11 key input failed: {exc}', file=sys.stderr)
        sys.exit(1)
