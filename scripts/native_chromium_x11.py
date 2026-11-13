"""Shared headed-Xvfb X11/XTest helpers for live browser acceptance.

Used by the optional-host dialog Tab/Return helper and the Alt+A
read-article command helper. Playwright/CDP/Selenium keys do not reach
extension commands or native permission dialogs.
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

# X11 focus revert-to modes / None+PointerRoot focus ids.
RevertToParent = 2
FocusNone = 0
PointerRoot = 1


class _XClassHint(ctypes.Structure):
    # c_void_p — c_char_p fields make ctypes own/convert the pointers so
    # XFree() then hits munmap_chunk on real browser WM_CLASS values.
    _fields_ = [('res_name', ctypes.c_void_p), ('res_class', ctypes.c_void_p)]


class X11Session:
    """Open display + XTest bindings for one short-lived key sequence."""

    def __init__(self, focus_name_substr=None):
        if not os.environ.get('DISPLAY'):
            raise RuntimeError(
                'DISPLAY must identify the headed browser X11 server')
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
        if focus_name_substr:
            self.focused_window = self.focus_client_window(focus_name_substr)
        else:
            focused = ctypes.c_ulong()
            revert = ctypes.c_int()
            self.x11.XGetInputFocus(
                self.display, ctypes.byref(focused), ctypes.byref(revert))
            if focused.value in (FocusNone, PointerRoot):
                self.close()
                raise RuntimeError(
                    'No focused application window for Chromium input')
            self.focused_window = focused.value

    def _bind(self):
        x11 = self.x11
        xtest = self.xtest
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x11.XCloseDisplay.restype = ctypes.c_int
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XQueryTree.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
            ctypes.POINTER(ctypes.c_uint)]
        x11.XQueryTree.restype = ctypes.c_int
        x11.XFree.argtypes = [ctypes.c_void_p]
        x11.XFree.restype = ctypes.c_int
        x11.XFetchName.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_void_p)]
        x11.XFetchName.restype = ctypes.c_int
        x11.XGetClassHint.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_XClassHint)]
        x11.XGetClassHint.restype = ctypes.c_int
        x11.XInternAtom.argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        x11.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
            ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
        x11.XGetWindowProperty.restype = ctypes.c_int
        x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XRaiseWindow.restype = ctypes.c_int
        x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XMapRaised.restype = ctypes.c_int
        x11.XGetGeometry.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint),
            ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        x11.XGetGeometry.restype = ctypes.c_int
        x11.XSetInputFocus.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        x11.XSetInputFocus.restype = ctypes.c_int
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

    def _xfree(self, ptr):
        if not ptr:
            return
        addr = ctypes.cast(ptr, ctypes.c_void_p).value
        if not addr:
            return
        self.x11.XFree(addr)

    def _window_title(self, window):
        # Prefer _NET_WM_NAME (UTF8); fall back to XA_WM_NAME via XFetchName.
        net_atom = self.x11.XInternAtom(self.display, b'_NET_WM_NAME', False)
        utf8_atom = self.x11.XInternAtom(self.display, b'UTF8_STRING', False)
        actual_type = ctypes.c_ulong()
        actual_format = ctypes.c_int()
        nitems = ctypes.c_ulong()
        bytes_after = ctypes.c_ulong()
        prop = ctypes.POINTER(ctypes.c_ubyte)()
        status = self.x11.XGetWindowProperty(
            self.display, window, net_atom, 0, 1024, False, utf8_atom,
            ctypes.byref(actual_type), ctypes.byref(actual_format),
            ctypes.byref(nitems), ctypes.byref(bytes_after), ctypes.byref(prop))
        title = ''
        if status == 0 and prop:
            try:
                if nitems.value:
                    title = ctypes.string_at(prop, nitems.value).decode(
                        'utf-8', 'replace')
            finally:
                self._xfree(prop)
            if title:
                return title
        # char** as void* — avoid c_char_p auto-conversion before XFree.
        name = ctypes.c_void_p()
        if (self.x11.XFetchName(
                self.display, window, ctypes.byref(name)) and name.value):
            try:
                title = ctypes.string_at(name.value).decode('utf-8', 'replace')
            finally:
                self._xfree(name.value)
        return title

    def _window_class_bits(self, window):
        hint = _XClassHint(None, None)
        if not self.x11.XGetClassHint(self.display, window, ctypes.byref(hint)):
            return ''
        bits = []
        try:
            if hint.res_name:
                bits.append(ctypes.string_at(hint.res_name).decode(
                    'utf-8', 'replace'))
            if hint.res_class:
                bits.append(ctypes.string_at(hint.res_class).decode(
                    'utf-8', 'replace'))
        finally:
            self._xfree(hint.res_name)
            self._xfree(hint.res_class)
        return ' '.join(bits)

    def _top_level_windows(self):
        """Immediate children of the root — enough to find Firefox's frame."""
        root = self.x11.XDefaultRootWindow(self.display)
        root_ret = ctypes.c_ulong()
        parent = ctypes.c_ulong()
        children = ctypes.POINTER(ctypes.c_ulong)()
        count = ctypes.c_uint()
        if not self.x11.XQueryTree(
                self.display, root, ctypes.byref(root_ret),
                ctypes.byref(parent), ctypes.byref(children),
                ctypes.byref(count)):
            return []
        try:
            return [children[index] for index in range(count.value)]
        finally:
            self._xfree(children)

    def _window_area(self, window):
        root = ctypes.c_ulong()
        x_pos = ctypes.c_int()
        y_pos = ctypes.c_int()
        width = ctypes.c_uint()
        height = ctypes.c_uint()
        border = ctypes.c_uint()
        depth = ctypes.c_uint()
        if not self.x11.XGetGeometry(
                self.display, window, ctypes.byref(root),
                ctypes.byref(x_pos), ctypes.byref(y_pos),
                ctypes.byref(width), ctypes.byref(height),
                ctypes.byref(border), ctypes.byref(depth)):
            return 0
        return int(width.value) * int(height.value)

    def focus_client_window(self, name_substr):
        """Raise + focus a top-level window whose title/WM_CLASS contains substr.

        Firefox under Selenium/Xvfb often has PointerRoot focus (id 1), so Alt+A
        never reaches browser.commands. Must run out-of-process from Selenium.
        """
        needle = name_substr.lower()
        # Also accept Navigator (Firefox WM_CLASS) when looking for Firefox.
        needles = {needle}
        if needle == 'firefox':
            needles.update({'navigator', 'firefox'})
        matches = []
        seen = []
        for window in self._top_level_windows():
            title = self._window_title(window)
            klass = self._window_class_bits(window)
            label = (title + ' ' + klass).strip()
            if label:
                seen.append(label)
            haystack = label.lower()
            if haystack and any(item in haystack for item in needles):
                # Prefer the largest mapped window when several match.
                area = self._window_area(window)
                matches.append((area, window, label))
        if not matches:
            raise RuntimeError(
                'No X11 window matching ' + repr(name_substr) +
                '; windows=' + json.dumps(seen[:20]))
        matches.sort(key=lambda item: item[0], reverse=True)
        _, window, label = matches[0]
        self.x11.XMapRaised(self.display, window)
        self.x11.XRaiseWindow(self.display, window)
        self.x11.XSetInputFocus(
            self.display, window, RevertToParent, 0)
        self.x11.XSync(self.display, 0)
        time.sleep(0.2)
        focused = ctypes.c_ulong()
        revert = ctypes.c_int()
        self.x11.XGetInputFocus(
            self.display, ctypes.byref(focused), ctypes.byref(revert))
        if focused.value in (FocusNone, PointerRoot):
            raise RuntimeError(
                'Failed to focus X11 window for ' + repr(label) +
                ' (still PointerRoot/None)')
        return focused.value

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
