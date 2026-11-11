#!/usr/bin/env python3
"""Send native X11 keyboard input for Chromium's optional host-permission dialog.

The JavaScript harness still must verify real chrome.permissions state.
No permissions are pregranted, and browser APIs are not modified.
"""
import ctypes
import json
import os
import sys
import time


def main():
    if not os.environ.get('DISPLAY'):
        raise RuntimeError('DISPLAY must identify the headed Chromium X11 server')
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
            raise RuntimeError('No focused application window for Chromium permission dialog')

        # Chromium defaults this dialog to Cancel; Tab then Return selects Allow.
        # Both are real X11 key events, not DOM events or permission API shims.
        for keysym in (0xff09, 0xff0d):
            keycode = x11.XKeysymToKeycode(display, keysym)
            if not keycode:
                raise RuntimeError('X11 has no keycode for required dialog input')
            for pressed in (1, 0):
                if not xtest.XTestFakeKeyEvent(display, keycode, pressed, 0):
                    raise RuntimeError('X11 rejected native keyboard input')
                x11.XSync(display, 0)
            time.sleep(0.18)
        print(json.dumps({
            'focusedWindow': hex(focused.value),
            'nativeKeys': 'Tab Return',
            'x11XTest': True,
        }))
    finally:
        x11.XCloseDisplay(display)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Native Chromium dialog X11 input failed: {exc}', file=sys.stderr)
        sys.exit(1)
