"""Shared headed-Xvfb X11/XTest helpers for Chromium live acceptance.

Used by the optional-host dialog Tab/Return helper and the Alt+A
read-article command helper. Playwright/CDP keys do not reach
chrome.commands or native permission dialogs.
"""
import ctypes
import json
import os
import time

# Small explicit map for harness chords/dialog keys.
KEYSYMS = {
    'Alt_L': 0xffe9,
    'a': 0x0061,
    'A': 0x0041,
    'Tab': 0xff09,
    'Return': 0xff0d,
}


class X11Session:
    """Open display + XTest bindings for one short-lived key sequence."""

    def __init__(self):
        if not os.environ.get('DISPLAY'):
            raise RuntimeError(
                'DISPLAY must identify the headed Chromium X11 server')
        self.x11 = ctypes.CDLL('libX11.so.6')
        self.xtest = ctypes.CDLL('libXtst.so.6')
        self._bind()
        self.display = self.x11.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError(
                'Cannot connect to X11 display: ' + os.environ['DISPLAY'])
        versions = [ctypes.c_int() for _ in range(4)]
        if not self.xtest.XTestQueryExtension(
                self.display, *[ctypes.byref(item) for item in versions]):
            self.close()
            raise RuntimeError('X11 server does not support XTest keyboard input')
        focused = ctypes.c_ulong()
        revert = ctypes.c_int()
        self.x11.XGetInputFocus(
            self.display, ctypes.byref(focused), ctypes.byref(revert))
        if focused.value in (0, 1):
            self.close()
            raise RuntimeError('No focused application window for Chromium input')
        self.focused_window = focused.value

    def _bind(self):
        x11 = self.x11
        xtest = self.xtest
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x11.XCloseDisplay.restype = ctypes.c_int
        x11.XGetInputFocus.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int)]
        x11.XGetInputFocus.restype = ctypes.c_int
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XKeysymToKeycode.restype = ctypes.c_uint
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XSync.restype = ctypes.c_int
        xtest.XTestQueryExtension.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int)]
        xtest.XTestQueryExtension.restype = ctypes.c_int
        xtest.XTestFakeKeyEvent.argtypes = [
            ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xtest.XTestFakeKeyEvent.restype = ctypes.c_int

    def keycode(self, name):
        keysym = KEYSYMS.get(name)
        if keysym is None:
            raise RuntimeError('Unsupported key name: ' + name)
        code = self.x11.XKeysymToKeycode(self.display, keysym)
        if not code:
            raise RuntimeError('X11 has no keycode for ' + name)
        return code

    def tap(self, name, pause=0.18):
        """Press and release one key (dialog Tab/Return style)."""
        code = self.keycode(name)
        for pressed in (1, 0):
            if not self.xtest.XTestFakeKeyEvent(self.display, code, pressed, 0):
                raise RuntimeError('X11 rejected native keyboard input for ' + name)
            self.x11.XSync(self.display, 0)
        time.sleep(pause)

    def chord(self, names, pause=0.03):
        """Hold modifiers then tap the final key (Alt+A style)."""
        codes = [(name, self.keycode(name)) for name in names]
        for name, code in codes:
            if not self.xtest.XTestFakeKeyEvent(self.display, code, 1, 0):
                raise RuntimeError('X11 rejected key press for ' + name)
            self.x11.XSync(self.display, 0)
            time.sleep(pause)
        for name, code in reversed(codes):
            if not self.xtest.XTestFakeKeyEvent(self.display, code, 0, 0):
                raise RuntimeError('X11 rejected key release for ' + name)
            self.x11.XSync(self.display, 0)
            time.sleep(pause)

    def result(self, native_keys):
        return {
            'focusedWindow': hex(self.focused_window),
            'nativeKeys': native_keys,
            'x11XTest': True,
        }

    def close(self):
        if getattr(self, 'display', None):
            self.x11.XCloseDisplay(self.display)
            self.display = None


def run_taps(names):
    session = X11Session()
    try:
        for name in names:
            session.tap(name)
        print(json.dumps(session.result(' '.join(names))))
    finally:
        session.close()


def run_chord(names):
    session = X11Session()
    try:
        session.chord(names)
        print(json.dumps(session.result(' '.join(names))))
    finally:
        session.close()
