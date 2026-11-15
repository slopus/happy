"""Offline regressions for computer startup, focus-or-launch and control argv."""
import base64
import ctypes
import errno
import fcntl
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch


def load_module(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(Path(__file__).with_name(filename)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


helper = load_module("focus_or_launch", "rakazo-focus-or-launch")
control = load_module("control", "control.py")

LISTING = """\
0x01800003  0 99999991 chromium.Chromium   box  Example page - Chromium
0x04000003  0 99999992 xterm.XTerm         box  Terminal
0x0400000f -1 99999993 N/A.N/A             box  dock
0x04400010  0
"""


class WmClassTest(unittest.TestCase):
    def test_known_launchers_have_fixed_classes(self):
        self.assertEqual(helper.wm_class("rakazo-browser"), helper.browser_wm_class())
        self.assertEqual(helper.wm_class("xterm"), "xterm")

    def test_browser_class_follows_the_installed_browser(self):
        def only(*names):
            return lambda name: f"/usr/bin/{name}" if name in names else None

        self.assertEqual(helper.browser_wm_class(only("chromium")), "chromium")
        self.assertEqual(helper.browser_wm_class(only("google-chrome", "google-chrome-stable")), "google-chrome")
        self.assertEqual(helper.browser_wm_class(only("brave-browser")), "brave-browser")
        self.assertEqual(helper.browser_wm_class(only()), "chromium")

    def test_other_launchers_match_their_binary_basename(self):
        self.assertEqual(helper.wm_class("/usr/bin/xterm"), "xterm")
        self.assertEqual(helper.wm_class("XTerm"), "xterm")


class MatchingWindowTest(unittest.TestCase):
    def test_matches_the_wm_class_field_not_id_host_or_title(self):
        self.assertEqual(helper.matching_window(LISTING, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window(LISTING, "chromium"), "0x01800003")
        self.assertEqual(helper.matching_window(LISTING, "Terminal"), "")

    def test_matching_is_case_insensitive(self):
        listing = LISTING.replace("xterm.XTerm", "XTerm.XTerm")
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")

    def test_first_match_wins_and_malformed_rows_are_skipped(self):
        listing = LISTING + "0x05000000  0 99999994 xterm.XTerm         box  second\n"
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window("garbage\n\n", "xterm"), "")
        self.assertEqual(helper.matching_window("", "xterm"), "")

    def test_components_do_not_match_a_longer_class_name(self):
        listing = "0x04000001  0 99999995 uxterm.UXTerm host uxterm\n" + LISTING
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window(listing, "uxterm"), "0x04000001")

    def test_browser_windows_are_limited_to_the_requested_profile(self):
        listing = (
            "0x01800003  0 100 chromium.Chromium box Other\n"
            "0x01800004  0 200 chromium.Chromium box Mine\n"
        )
        profiles = {"100": "/profiles/other", "200": "/profiles/mine"}
        with patch.object(helper, "window_profile", side_effect=lambda pid: profiles.get(pid)):
            self.assertEqual(
                helper.matching_window(listing, "chromium", "/profiles/mine"), "0x01800004"
            )
            self.assertEqual(helper.matching_window(listing, "chromium", "/profiles/missing"), "")
        # No profile request keeps the first class match, including when profiles are unreadable.
        self.assertEqual(helper.matching_window(listing, "chromium"), "0x01800003")


class MainTest(unittest.TestCase):
    def run_wrapper(self, argv, listing=LISTING, launch_code=None):
        calls = []

        def fake_run(run_argv, **_kwargs):
            if run_argv[:2] == ["wmctrl", "-lxp"]:
                return subprocess.CompletedProcess(run_argv, 0, listing, "")
            calls.append(("run", run_argv))
            return subprocess.CompletedProcess(run_argv, 0, "", "")

        def fake_popen(popen_argv, **_kwargs):
            calls.append(("popen", popen_argv))

            class Child:
                def wait(self, timeout=None):
                    calls.append(("wait", timeout))
                    if launch_code is None:
                        raise subprocess.TimeoutExpired(popen_argv, timeout or 0)
                    return launch_code

            return Child()

        # The fixtures list Chromium windows; the host's own browsers must not matter.
        with patch.object(helper.subprocess, "run", side_effect=fake_run), patch.object(
            helper.subprocess, "Popen", side_effect=fake_popen
        ), patch.dict(helper.WM_CLASS, {"rakazo-browser": "chromium"}):
            try:
                helper.main(argv)
            except SystemExit as error:
                if error.code:
                    calls.append(("exit", error.code))
        return calls

    def test_activates_a_matching_window_without_spawning(self):
        calls = self.run_wrapper(["xterm"])
        self.assertEqual(calls, [("run", ["wmctrl", "-ia", "0x04000003"])])

    def test_spawns_the_launcher_when_no_window_matches(self):
        calls = self.run_wrapper(["xterm"], listing="")
        self.assertEqual(calls, [("popen", ["xterm"]), ("wait", helper.DEFAULT_LAUNCH_WAIT_SEC)])

    def test_missing_wmctrl_still_spawns(self):
        calls = []

        def fake_popen(popen_argv, **_kwargs):
            calls.append(popen_argv)

            class Child:
                def wait(self, timeout=None):
                    raise subprocess.TimeoutExpired(popen_argv, timeout or 0)

            return Child()

        with patch.object(helper.subprocess, "run", side_effect=OSError), patch.object(
            helper.subprocess, "Popen", side_effect=fake_popen
        ):
            with self.assertRaises(SystemExit) as raised:
                helper.main(["xterm"])
        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(calls, [["xterm"]])

    def test_arguments_reach_the_launcher_before_the_window_is_raised(self):
        calls = self.run_wrapper(["rakazo-browser", "https://example.test"], launch_code=0)
        self.assertEqual(
            calls,
            [
                ("popen", ["rakazo-browser", "https://example.test"]),
                ("wait", helper.LAUNCH_WAIT_SEC["rakazo-browser"]),
                ("run", ["wmctrl", "-ia", "0x01800003"]),
            ],
        )

    def test_a_live_launcher_does_not_block_the_raise(self):
        calls = self.run_wrapper(["rakazo-browser", "https://example.test"])
        self.assertEqual(calls[-1], ("run", ["wmctrl", "-ia", "0x01800003"]))

    def test_a_failing_launcher_does_not_raise_or_succeed(self):
        calls = self.run_wrapper(["xterm", "bad-flag"], launch_code=1)
        self.assertEqual(
            calls,
            [
                ("popen", ["xterm", "bad-flag"]),
                ("wait", helper.DEFAULT_LAUNCH_WAIT_SEC),
                ("exit", 1),
            ],
        )

    def test_usage_error_without_a_launcher(self):
        with self.assertRaises(SystemExit):
            helper.main([])

    def test_a_different_browser_profile_is_not_raised(self):
        calls = self.run_wrapper(["rakazo-browser"])
        # The fixture PIDs expose no profile, so the only chromium window is raised.
        self.assertEqual(calls, [("run", ["wmctrl", "-ia", "0x01800003"])])
        with patch.object(helper, "window_profile", return_value="/profiles/other"), patch.dict(
            os.environ, {"RAKAZO_BROWSER_PROFILE": "/profiles/mine"}
        ):
            calls = self.run_wrapper(["rakazo-browser"])
        self.assertEqual(
            calls,
            [("popen", ["rakazo-browser"]), ("wait", helper.LAUNCH_WAIT_SEC["rakazo-browser"])],
        )


PROFILE = "/home/rakazo/.browser-profiles/chromium-bot-" + "a" * 32


XLIB_H = """\
#ifndef XSTUB_XLIB_H
#define XSTUB_XLIB_H
#include <stddef.h>
typedef struct _XDisplay { int fd; } Display;
typedef unsigned long Window;
typedef unsigned long Drawable;
typedef unsigned long Pixmap;
typedef struct _Visual Visual;
typedef int Bool;
typedef unsigned long KeySym;
typedef unsigned char KeyCode;
#define True 1
#define False 0
#define None 0L
#define NoSymbol 0L
#define CurrentTime 0L
#define AllPlanes (~0UL)
#define ZPixmap 2
#define LSBFirst 0
#define MSBFirst 1
#define XConnectionNumber(dpy) ((dpy)->fd)
#define DefaultScreen(dpy) 0
#define RootWindow(dpy, scr) ((Window)1)
#define DefaultDepth(dpy, scr) 24
#define DefaultVisual(dpy, scr) ((Visual *)0)
typedef struct _XImage {
  int width;
  int height;
  char *data;
  int byte_order;
  int bytes_per_line;
  int bits_per_pixel;
  unsigned long red_mask;
  unsigned long green_mask;
  unsigned long blue_mask;
} XImage;
typedef struct {
  int width;
  int height;
} XWindowAttributes;
typedef int (*XIOErrorHandler)(Display *);
Display *XOpenDisplay(const char *name);
int XCloseDisplay(Display *display);
int XSync(Display *display, Bool discard);
int XFlush(Display *display);
int XGetWindowAttributes(Display *display, Window window, XWindowAttributes *attributes);
int XFree(void *data);
XIOErrorHandler XSetIOErrorHandler(XIOErrorHandler handler);
KeySym XStringToKeysym(const char *name);
KeyCode XKeysymToKeycode(Display *display, KeySym keysym);
int XDestroyImage(XImage *image);
#endif
"""

XUTIL_H = """\
#ifndef XSTUB_XUTIL_H
#define XSTUB_XUTIL_H
#include <X11/Xlib.h>
#endif
"""

XSHM_H = """\
#ifndef XSTUB_XSHM_H
#define XSTUB_XSHM_H
#include <X11/Xlib.h>
typedef struct {
  int shmid;
  char *shmaddr;
  Bool readOnly;
} XShmSegmentInfo;
Bool XShmQueryExtension(Display *display);
XImage *XShmCreateImage(Display *display, Visual *visual, unsigned int depth, int format,
    char *data, XShmSegmentInfo *shminfo, unsigned int width, unsigned int height);
Bool XShmAttach(Display *display, XShmSegmentInfo *shminfo);
Bool XShmDetach(Display *display, XShmSegmentInfo *shminfo);
int XShmGetImage(Display *display, Drawable drawable, XImage *image, int x, int y, unsigned long plane);
#endif
"""

XDAMAGE_H = """\
#ifndef XSTUB_XDAMAGE_H
#define XSTUB_XDAMAGE_H
#include <X11/Xlib.h>
typedef unsigned long Damage;
#define XDamageReportNonEmpty 2
int XDamageQueryExtension(Display *display, int *event_base, int *error_base);
Damage XDamageCreate(Display *display, Window window, int level);
void XDamageSubtract(Display *display, Damage damage, Damage repair, unsigned long region);
void XDamageDestroy(Display *display, Damage damage);
#endif
"""

XFIXES_H = """\
#ifndef XSTUB_XFIXES_H
#define XSTUB_XFIXES_H
#include <X11/Xlib.h>
typedef unsigned long XserverRegion;
typedef struct { short x, y; unsigned short width, height; } XRectangle;
XserverRegion XFixesCreateRegion(Display *display, XRectangle *rectangles, int count);
XRectangle *XFixesFetchRegion(Display *display, XserverRegion region, int *count);
void XFixesDestroyRegion(Display *display, XserverRegion region);
#endif
"""

XKBLIB_H = """\
#ifndef XSTUB_XKBLIB_H
#define XSTUB_XKBLIB_H
#include <X11/Xlib.h>
KeySym XkbKeycodeToKeysym(Display *display, KeyCode keycode, int group, int level);
#endif
"""

XTEST_H = """\
#ifndef XSTUB_XTEST_H
#define XSTUB_XTEST_H
#include <X11/Xlib.h>
Bool XTestQueryExtension(Display *display, int *event_base, int *error_base, int *major, int *minor);
int XTestFakeKeyEvent(Display *display, unsigned int keycode, Bool is_press, unsigned long delay);
int XTestFakeMotionEvent(Display *display, int screen, int x, int y, unsigned long delay);
int XTestFakeButtonEvent(Display *display, unsigned int button, Bool is_press, unsigned long delay);
#endif
"""

PNG_H = """\
#ifndef XSTUB_PNG_H
#define XSTUB_PNG_H
#include <setjmp.h>
#include <stddef.h>
typedef unsigned char png_byte;
typedef png_byte *png_bytep;
typedef size_t png_size_t;
typedef struct png_struct_def png_struct;
typedef png_struct *png_structp;
typedef struct png_info_def png_info;
typedef png_info *png_infop;
typedef void (*png_rw_ptr)(png_structp, png_bytep, png_size_t);
typedef void (*png_flush_ptr)(png_structp);
struct png_struct_def {
  jmp_buf jmp;
  void *io_ptr;
  png_rw_ptr write_fn;
  png_flush_ptr flush_fn;
};
struct png_info_def { int unused; };
#define png_jmpbuf(png_ptr) ((png_ptr)->jmp)
#define PNG_LIBPNG_VER_STRING "1.6.0"
#define PNG_FILTER_TYPE_BASE 0
#define PNG_FILTER_SUB 1
#define PNG_FILTER_PAETH 4
#define PNG_COLOR_TYPE_RGB 2
#define PNG_INTERLACE_NONE 0
#define PNG_COMPRESSION_TYPE_BASE 0
void *png_get_io_ptr(png_structp png);
void png_error(png_structp png, const char *message);
png_structp png_create_write_struct(const char *ver, void *error_ptr, void *error_fn, void *warn_fn);
png_infop png_create_info_struct(png_structp png);
void png_destroy_write_struct(png_structp *png, png_infop *info);
void png_set_write_fn(png_structp png, void *io_ptr, png_rw_ptr write_fn, png_flush_ptr flush_fn);
void png_set_compression_level(png_structp png, int level);
void png_set_filter(png_structp png, int method, int filters);
void png_set_IHDR(png_structp png, png_infop info, unsigned width, unsigned height, int depth, int color,
    int interlace, int compression, int filter);
void png_write_info(png_structp png, png_infop info);
void png_write_row(png_structp png, png_bytep row);
void png_write_end(png_structp png, png_infop info);
#endif
"""

XSTUB_C = """\
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/XTest.h>
#include <png.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int xstub_peer_fd = -1;
int xstub_display_fd = -1;
int xstub_xclose_calls = 0;
int xstub_io_target = 0;

static XIOErrorHandler io_handler = NULL;

static void raise_io(Display *display) {
  if (io_handler) io_handler(display);
  _exit(70);
}

static void maybe_io(Display *display, int target) {
  if (xstub_io_target != target) return;
  xstub_io_target = 0;
  raise_io(display);
}

Display *XOpenDisplay(const char *name) {
  int fds[2];
  (void)name;
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) return NULL;
  Display *display = calloc(1, sizeof(*display));
  if (!display) {
    close(fds[0]);
    close(fds[1]);
    return NULL;
  }
  display->fd = fds[0];
  xstub_display_fd = fds[0];
  xstub_peer_fd = fds[1];
  return display;
}

int XCloseDisplay(Display *display) {
  xstub_xclose_calls += 1;
  if (display && display->fd >= 0) {
    close(display->fd);
    display->fd = -1;
  }
  free(display);
  return 0;
}

int XSync(Display *display, Bool discard) { (void)display; (void)discard; return 1; }
int XFlush(Display *display) { (void)display; return 1; }

int XGetWindowAttributes(Display *display, Window window, XWindowAttributes *attributes) {
  (void)window;
  maybe_io(display, 1);
  if (!attributes) return 0;
  attributes->width = 4;
  attributes->height = 3;
  return 1;
}

int XFree(void *data) { free(data); return 1; }

XIOErrorHandler XSetIOErrorHandler(XIOErrorHandler handler) {
  XIOErrorHandler previous = io_handler;
  io_handler = handler;
  return previous;
}

KeySym XStringToKeysym(const char *name) { (void)name; return 0x61; }
KeyCode XKeysymToKeycode(Display *display, KeySym keysym) { (void)display; (void)keysym; return 38; }
KeySym XkbKeycodeToKeysym(Display *display, KeyCode keycode, int group, int level) {
  (void)display; (void)group; (void)level; return keycode == 38 ? 0x61 : 0;
}

int XDestroyImage(XImage *image) { free(image); return 1; }

Bool XShmQueryExtension(Display *display) { (void)display; return 1; }

XImage *XShmCreateImage(Display *display, Visual *visual, unsigned int depth, int format,
    char *data, XShmSegmentInfo *shminfo, unsigned int width, unsigned int height) {
  XImage *image = calloc(1, sizeof(*image));
  (void)display; (void)visual; (void)depth; (void)format; (void)data; (void)shminfo;
  if (!image) return NULL;
  image->width = (int)width;
  image->height = (int)height;
  image->bits_per_pixel = 32;
  image->bytes_per_line = (int)width * 4;
  image->byte_order = LSBFirst;
  image->red_mask = 0xff;
  image->green_mask = 0xff00;
  image->blue_mask = 0xff0000;
  return image;
}

Bool XShmAttach(Display *display, XShmSegmentInfo *shminfo) { (void)display; (void)shminfo; return 1; }
Bool XShmDetach(Display *display, XShmSegmentInfo *shminfo) { (void)display; (void)shminfo; return 1; }

int XShmGetImage(Display *display, Drawable drawable, XImage *image, int x, int y, unsigned long plane) {
  (void)display; (void)drawable; (void)x; (void)y; (void)plane;
  if (!image || !image->data || image->height < 0 || image->bytes_per_line < 0) return 0;
  memset(image->data, 0, (size_t)image->bytes_per_line * (size_t)image->height);
  return 1;
}

int XDamageQueryExtension(Display *display, int *event_base, int *error_base) {
  (void)display;
  if (event_base) *event_base = 0;
  if (error_base) *error_base = 0;
  return 0;
}
Damage XDamageCreate(Display *display, Window window, int level) {
  (void)display; (void)window; (void)level; return 0;
}
void XDamageSubtract(Display *display, Damage damage, Damage repair, unsigned long region) {
  (void)display; (void)damage; (void)repair; (void)region;
}
void XDamageDestroy(Display *display, Damage damage) { (void)display; (void)damage; }

XserverRegion XFixesCreateRegion(Display *display, XRectangle *rectangles, int count) {
  (void)display; (void)rectangles; (void)count; return 0;
}
XRectangle *XFixesFetchRegion(Display *display, XserverRegion region, int *count) {
  (void)display; (void)region;
  if (count) *count = 0;
  return NULL;
}
void XFixesDestroyRegion(Display *display, XserverRegion region) { (void)display; (void)region; }

Bool XTestQueryExtension(Display *display, int *event_base, int *error_base, int *major, int *minor) {
  (void)display;
  if (event_base) *event_base = 0;
  if (error_base) *error_base = 0;
  if (major) *major = 0;
  if (minor) *minor = 0;
  return 1;
}
int XTestFakeKeyEvent(Display *display, unsigned int keycode, Bool is_press, unsigned long delay) {
  (void)keycode; (void)is_press; (void)delay;
  maybe_io(display, 2);
  return 1;
}
int XTestFakeMotionEvent(Display *display, int screen, int x, int y, unsigned long delay) {
  (void)display; (void)screen; (void)x; (void)y; (void)delay; return 1;
}
int XTestFakeButtonEvent(Display *display, unsigned int button, Bool is_press, unsigned long delay) {
  (void)display; (void)button; (void)is_press; (void)delay; return 1;
}

void *png_get_io_ptr(png_structp png) { return png ? png->io_ptr : NULL; }
void png_error(png_structp png, const char *message) {
  (void)message;
  if (png) longjmp(png->jmp, 1);
  _exit(71);
}
png_structp png_create_write_struct(const char *ver, void *error_ptr, void *error_fn, void *warn_fn) {
  (void)ver; (void)error_ptr; (void)error_fn; (void)warn_fn;
  return calloc(1, sizeof(png_struct));
}
png_infop png_create_info_struct(png_structp png) { (void)png; return calloc(1, sizeof(png_info)); }
void png_destroy_write_struct(png_structp *png, png_infop *info) {
  if (png) { free(*png); *png = NULL; }
  if (info) { free(*info); *info = NULL; }
}
void png_set_write_fn(png_structp png, void *io_ptr, png_rw_ptr write_fn, png_flush_ptr flush_fn) {
  if (!png) return;
  png->io_ptr = io_ptr;
  png->write_fn = write_fn;
  png->flush_fn = flush_fn;
}
void png_set_compression_level(png_structp png, int level) { (void)png; (void)level; }
void png_set_filter(png_structp png, int method, int filters) { (void)png; (void)method; (void)filters; }
void png_set_IHDR(png_structp png, png_infop info, unsigned width, unsigned height, int depth, int color,
    int interlace, int compression, int filter) {
  (void)png; (void)info; (void)width; (void)height; (void)depth; (void)color;
  (void)interlace; (void)compression; (void)filter;
}
void png_write_info(png_structp png, png_infop info) { (void)png; (void)info; }
void png_write_row(png_structp png, png_bytep row) { (void)png; (void)row; }
void png_write_end(png_structp png, png_infop info) {
  png_byte bytes[8] = {137, 80, 78, 71, 0, 0, 0, 0};
  (void)info;
  if (png && png->write_fn) png->write_fn(png, bytes, sizeof bytes);
}
"""

class ControlArgvTest(unittest.TestCase):
    def test_accepts_wrapped_known_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser", "https://example.test"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "rakazo-browser",
                "https://example.test",
            ],
        ):
            with self.subTest(argv=argv):
                self.assertTrue(control.allowed_control_argv(argv, ":1"))
                self.assertFalse(control.is_long_lived_control(argv))

    def test_rejects_launchers_outside_the_allowlist(self):
        for inner in ("sh", "wmctrl", "rakazo-focus-or-launch", "/usr/bin/xterm"):
            argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", inner]
            with self.subTest(inner=inner):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_rejects_bad_arity_and_a_browser_profile_on_other_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "one", "two"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "-e", "sh"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "xterm",
            ],
            ["env", "DISPLAY=:8", "rakazo-focus-or-launch", "xterm"],
        ):
            with self.subTest(argv=argv):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_wrapped_browser_keeps_the_browser_spawn_poll(self):
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.BROWSER_OPEN_POLL_SEC)
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.LAUNCH_SPAWN_POLL_SEC)

    def test_focus_waits_for_the_wrapper_instead_of_the_spawn_poll(self):
        argv = [
            "env",
            "DISPLAY=:1",
            f"RAKAZO_BROWSER_PROFILE={PROFILE}",
            "rakazo-focus-or-launch",
            "rakazo-browser",
        ]
        with patch.object(
            control.subprocess, "run", return_value=subprocess.CompletedProcess(argv, 0)
        ) as run:
            control.run_control_argv(argv, ":1")
        self.assertEqual(run.call_args.args[0], argv)
        self.assertEqual(run.call_args.kwargs["timeout"], control.FOCUS_COMPLETION_SEC)
        self.assertGreater(control.FOCUS_COMPLETION_SEC, control.LAUNCH_SPAWN_POLL_SEC)

    def test_slow_focus_is_not_reported_before_the_wrapper_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "rakazo-focus-or-launch"
            marker = Path(tmp) / "done"
            script.write_text(f"#!/bin/sh\nsleep 0.5\ntouch {marker}\n")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)
            argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"]
            with patch.object(control, "CHILD_PATH", f"{tmp}{os.pathsep}{control.CHILD_PATH}"):
                started = time.monotonic()
                control.run_control_argv(argv, ":1")
                elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 0.45)
            self.assertTrue(marker.exists())

    def test_capture_reconnects_after_cached_native_capture_fails(self):
        created = []

        class FakeCapture:
            def __init__(self, display):
                self.display = display
                self.closed = False
                self.dead = not created
                created.append(self)

            def copy(self):
                if self.dead:
                    raise RuntimeError("MIT-SHM screen capture failed")
                return (b"replacement-png", 19, 17, {"x": 1, "y": 2, "width": 3, "height": 4})

            def close(self):
                self.closed = True

        def run(argv, **_kwargs):
            if argv and argv[0] == "import":
                return subprocess.CompletedProcess(argv, 0, b"fallback-png", b"")
            if argv[:2] == ["xdotool", "getdisplaygeometry"]:
                return subprocess.CompletedProcess(argv, 0, "640 480\n", "")
            return subprocess.CompletedProcess(argv, 0, "", "")

        control.NATIVE_CAPTURES.clear()
        stale = FakeCapture(":100")
        control.NATIVE_CAPTURES[":100"] = stale
        try:
            with (
                patch.object(control, "NativeCapture", FakeCapture),
                patch.object(control.subprocess, "run", side_effect=run) as run_mock,
            ):
                result = control.capture(":100")
            self.assertEqual(base64.b64decode(result["image"]), b"replacement-png")
            self.assertEqual((result["width"], result["height"]), (19, 17))
            self.assertEqual(result["damage"], {"x": 1, "y": 2, "width": 3, "height": 4})
            self.assertNotIn("import", [call.args[0][0] for call in run_mock.call_args_list])
            self.assertTrue(stale.closed)
            self.assertEqual(len(created), 2)
            self.assertFalse(created[1].closed)
            self.assertIs(control.NATIVE_CAPTURES[":100"], created[1])
        finally:
            control.NATIVE_CAPTURES.clear()

    def test_capture_evicts_failed_replacement_before_ffmpeg_fallback(self):
        # The computer image falls back to ImageMagick `import`, the capture path beside native MIT-SHM.
        created = []

        class FakeCapture:
            def __init__(self, display):
                self.display = display
                self.closed = False
                created.append(self)

            def copy(self):
                raise RuntimeError("MIT-SHM screen capture failed")

            def close(self):
                self.closed = True

        def run(argv, **kwargs):
            if argv[0] == "import":
                return subprocess.CompletedProcess(argv, 0, b"import-png", b"")
            if argv[:2] == ["xdotool", "getdisplaygeometry"]:
                return subprocess.CompletedProcess(argv, 0, "640 480\n", "")
            return subprocess.CompletedProcess(argv, 0, "", "")

        control.NATIVE_CAPTURES.clear()
        stale = FakeCapture(":100")
        control.NATIVE_CAPTURES[":100"] = stale
        try:
            with (
                patch.object(control, "NativeCapture", FakeCapture),
                patch.object(control.subprocess, "run", side_effect=run),
            ):
                result = control.capture(":100")
            self.assertEqual(len(created), 2)
            self.assertTrue(all(capture.closed for capture in created))
            self.assertNotIn(":100", control.NATIVE_CAPTURES)
            self.assertEqual(base64.b64decode(result["image"]), b"import-png")
            self.assertEqual((result["width"], result["height"]), (640, 480))
            self.assertNotIn("damage", result)
        finally:
            control.NATIVE_CAPTURES.clear()

    def test_act_reconnects_after_cached_native_capture_loses_display(self):
        created = []
        argv = ["env", "DISPLAY=:100", "xdotool", "mousemove", "--", "10", "20"]

        class FakeCapture:
            def __init__(self, display):
                self.display = display
                self.closed = False
                self.lost = not created
                self.argv = None
                created.append(self)

            def act(self, command):
                self.argv = command
                return -1 if self.lost else 1

            def close(self):
                self.closed = True

        control.NATIVE_CAPTURES.clear()
        stale = FakeCapture(":100")
        control.NATIVE_CAPTURES[":100"] = stale
        try:
            with (
                patch.object(control, "NativeCapture", FakeCapture),
                patch.object(
                    control.subprocess, "run", return_value=subprocess.CompletedProcess(argv, 0)
                ) as run,
            ):
                control.run_computer_step(":100", argv)
            run.assert_not_called()
            self.assertTrue(stale.closed)
            self.assertEqual(len(created), 2)
            self.assertEqual(created[1].argv, argv)
            self.assertFalse(created[1].closed)
            self.assertIs(control.NATIVE_CAPTURES[":100"], created[1])
        finally:
            control.NATIVE_CAPTURES.clear()

    def test_xcapture_survives_dead_display_socket_and_xio_error(self):
        source = Path(__file__).with_name("xcapture.c")
        key = ["env", "DISPLAY=:100", "xdotool", "key", "--clearmodifiers", "a"]
        with tempfile.TemporaryDirectory() as tmp:
            include = Path(tmp) / "include"
            (include / "X11" / "extensions").mkdir(parents=True)
            headers = {
                "X11/Xlib.h": XLIB_H,
                "X11/XKBlib.h": XKBLIB_H,
                "X11/Xutil.h": XUTIL_H,
                "X11/extensions/XShm.h": XSHM_H,
                "X11/extensions/Xdamage.h": XDAMAGE_H,
                "X11/extensions/Xfixes.h": XFIXES_H,
                "X11/extensions/XTest.h": XTEST_H,
                "png.h": PNG_H,
            }
            for name, contents in headers.items():
                path = include / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents)
            stub = Path(tmp) / "xstub.c"
            stub.write_text(XSTUB_C)
            library_path = Path(tmp) / "librakazo-xcapture.so"
            compiled = subprocess.run(
                [
                    "cc",
                    "-O3",
                    "-fPIC",
                    "-shared",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-I",
                    str(include),
                    "-o",
                    str(library_path),
                    str(source),
                    str(stub),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            lib = ctypes.CDLL(str(library_path))
            lib.rakazo_xcapture_open.argtypes = [ctypes.c_char_p]
            lib.rakazo_xcapture_open.restype = ctypes.c_void_p
            lib.rakazo_xcapture_png.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
                ctypes.POINTER(ctypes.c_size_t),
                ctypes.POINTER(ctypes.c_int),
                ctypes.POINTER(ctypes.c_int),
            ]
            lib.rakazo_xcapture_png.restype = ctypes.c_int
            lib.rakazo_xinput_argv.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
            lib.rakazo_xinput_argv.restype = ctypes.c_int
            lib.rakazo_xcapture_close.argtypes = [ctypes.c_void_p]
            lib.rakazo_xcapture_close.restype = None
            peer = ctypes.c_int.in_dll(lib, "xstub_peer_fd")
            display_fd = ctypes.c_int.in_dll(lib, "xstub_display_fd")
            closes = ctypes.c_int.in_dll(lib, "xstub_xclose_calls")
            io_target = ctypes.c_int.in_dll(lib, "xstub_io_target")

            def read_png(handle):
                png = ctypes.POINTER(ctypes.c_ubyte)()
                size = ctypes.c_size_t()
                width, height = ctypes.c_int(), ctypes.c_int()
                code = lib.rakazo_xcapture_png(
                    handle, ctypes.byref(png), ctypes.byref(size), ctypes.byref(width), ctypes.byref(height)
                )
                return code, size.value, width.value, height.value

            def send_key(handle):
                encoded = [part.encode("utf-8") for part in key]
                array = (ctypes.c_char_p * len(encoded))(*encoded)
                return lib.rakazo_xinput_argv(handle, len(encoded), array)

            handle = lib.rakazo_xcapture_open(b":100")
            self.assertTrue(handle)
            try:
                code, size, width, height = read_png(handle)
                self.assertEqual(code, 0)
                self.assertGreater(size, 0)
                self.assertEqual((width, height), (4, 3))
                self.assertEqual(send_key(handle), 1)
                fd = display_fd.value
                self.assertGreaterEqual(fd, 0)
                os.close(peer.value)
                self.assertEqual(read_png(handle)[0], -1)
                self.assertEqual(send_key(handle), -1)
                self.assertEqual(closes.value, 0)
                lib.rakazo_xcapture_close(handle)
                handle = None
                self.assertEqual(closes.value, 0)
                with self.assertRaises(OSError) as caught:
                    fcntl.fcntl(fd, fcntl.F_GETFD)
                self.assertEqual(caught.exception.errno, errno.EBADF)

                handle = lib.rakazo_xcapture_open(b":100")
                self.assertTrue(handle)
                io_target.value = 1  # XGetWindowAttributes calls the IO error handler.
                self.assertEqual(read_png(handle)[0], -1)
                lib.rakazo_xcapture_close(handle)
                handle = lib.rakazo_xcapture_open(b":100")
                self.assertTrue(handle)
                io_target.value = 2  # XTestFakeKeyEvent calls the IO error handler.
                self.assertEqual(send_key(handle), -1)
            finally:
                if handle:
                    lib.rakazo_xcapture_close(handle)


class ScriptTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux /proc process arguments")
    def test_window_profile_reads_the_user_data_dir_flag(self):
        # The flag has to stay on this process. A shell would exec the sleep away.
        equals = subprocess.Popen(
            ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/mine"]
        )
        separate = subprocess.Popen(
            [
                "python3",
                "-c",
                "import time; time.sleep(30)",
                "--user-data-dir",
                "/profiles/other",
            ]
        )
        try:
            # Popen returns after fork, before exec; until then /proc shows this test's arguments.
            for proc in (equals, separate):
                deadline = time.monotonic() + 5
                while b"--user-data-dir" not in Path(f"/proc/{proc.pid}/cmdline").read_bytes():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
            self.assertEqual(helper.window_profile(str(equals.pid)), "/profiles/mine")
            self.assertEqual(helper.window_profile(str(separate.pid)), "/profiles/other")
            self.assertIsNone(helper.window_profile("99999999"))
        finally:
            for proc in (equals, separate):
                proc.kill()
                proc.wait()

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux /proc process arguments")
    def test_script_raises_the_requested_browser_profile_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            windows = Path(tmp) / "windows"
            args_log = Path(tmp) / "args"
            other = subprocess.Popen(
                ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/other"]
            )
            mine = subprocess.Popen(
                ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/mine"]
            )
            try:
                windows.write_text(
                    f"0x111 0 {other.pid} chromium.Chromium host Other\n"
                    f"0x222 0 {mine.pid} chromium.Chromium host Mine\n"
                )
                wmctrl = bin_dir / "wmctrl"
                wmctrl.write_text(
                    "#!/bin/sh\n"
                    'if [ "$1" = "-lxp" ]; then cat "$RAKAZO_TEST_WINDOWS"; exit 0; fi\n'
                    'printf "wmctrl %s\\n" "$*" >> "$RAKAZO_TEST_ARGS"\n'
                )
                browser = bin_dir / "rakazo-browser"
                browser.write_text('#!/bin/sh\nprintf "browser %s\\n" "$*" >> "$RAKAZO_TEST_ARGS"\n')
                # The listed windows are Chromium's, whatever browser the host has.
                chromium = bin_dir / "chromium"
                chromium.write_text("#!/bin/sh\n")
                wmctrl.chmod(0o755)
                browser.chmod(0o755)
                chromium.chmod(0o755)
                env = {
                    **os.environ,
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                    "RAKAZO_BROWSER_PROFILE": "/profiles/mine",
                    "RAKAZO_TEST_WINDOWS": str(windows),
                    "RAKAZO_TEST_ARGS": str(args_log),
                }
                script = str(Path(__file__).with_name("rakazo-focus-or-launch"))
                result = subprocess.run(
                    ["python3", script, "rakazo-browser"],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(args_log.read_text().strip(), "wmctrl -ia 0x222")

                args_log.write_text("")
                windows.write_text(f"0x111 0 {other.pid} chromium.Chromium host Other\n")
                result = subprocess.run(
                    ["python3", script, "rakazo-browser"],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(args_log.read_text().strip(), "browser")
            finally:
                for proc in (other, mine):
                    proc.kill()
                    proc.wait()


class ComputerUserEnvTest(unittest.TestCase):
    def run_user_env(self, root, before=""):
        computer = Path(__file__).parent
        dockerfile = (computer / "Dockerfile").read_text()
        command = json.loads(next(
            line.removeprefix("CMD ") for line in dockerfile.splitlines()
            if line.startswith("CMD ")
        ))
        self.assertEqual(command[-1], "/usr/local/bin/rakazo-computer")
        # Exercise the image's startup environment without starting the desktop.
        script = '''
set -uo pipefail
id() {
    [[ -z "${LD_PRELOAD+x}" ]] || return 1
    case "$1" in
        -u) echo 42424 ;;
        -g) echo 42425 ;;
    esac
}
''' + before + '\nsource "$1"\n[[ "$LD_PRELOAD" == /usr/local/lib/libnss_wrapper.so ]]'
        return subprocess.run(
            command[:-1] + ["bash", "-c", script, "bash", str(computer / "user-env.sh")],
            env={**os.environ, "LD_PRELOAD": "",
                 "NSS_WRAPPER_PASSWD": str(root / "passwd"),
                 "NSS_WRAPPER_GROUP": str(root / "group")},
            text=True, capture_output=True, timeout=5,
        )

    def test_creates_private_identity_files_before_enabling_preload(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "nss"
            result = self.run_user_env(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertIn("rakazo-runtime:x:42424:42425:", (root / "passwd").read_text())
            self.assertIn("rakazo-runtime:x:42425:", (root / "group").read_text())
            for name in ("passwd", "group"):
                self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o600)

    def test_reports_directory_copy_and_append_failures(self):
        failures = (
            "mkdir() { return 1; }",
            'cp() { [[ "$1" != /etc/passwd ]] && command cp "$@"; }',
            'cp() { [[ "$1" != /etc/group ]] && command cp "$@"; }',
            "printf() { return 1; }",
        )
        for failure in failures:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                result = self.run_user_env(Path(temp) / "nss", failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Failed to create nss_wrapper passwd/group files", result.stderr)


import ctypes
import textwrap


class IsolatedHelperTest(unittest.TestCase):
    """The image's Python helpers run as the computer's user, whose home the bot can write.

    Code planted there (a .pth in the user site-packages, a python3 early in PATH, PYTHON*
    variables) must not run inside them: the page browser holds saved logins and cards.
    """

    HELPERS = {
        "control.py": [],
        "rakazo-focus-or-launch": [],
        "rakazo-page-browser": [],
    }

    def interpreter(self, line):
        """The interpreter and its flags from a shebang or command line, as exec would run it."""
        parts = line.split()
        if Path(parts[0]).name == "env":
            parts = parts[1:]
            if parts[0] == "-S":
                parts = parts[1:]
        return parts[0], parts[1:]

    def shebang(self, name):
        first = Path(__file__).with_name(name).read_text().splitlines()[0]
        self.assertTrue(first.startswith("#!"), name)
        return self.interpreter(first.removeprefix("#!"))

    def browser_heredoc(self):
        text = Path(__file__).with_name("rakazo-browser").read_text()
        match = re.search(r"^\s*timeout \S+ (\S*python3\S*(?: -\w+)*) - \"\$@\" <<'PY'$", text, re.M)
        self.assertIsNotNone(match)
        return self.interpreter(match.group(1))

    def plant(self, root):
        """A home and environment that run code in any Python that reads them; returns env, marker."""
        home = root / "home"
        marker = root / "planted-code-ran"
        payload = f"import os; open({str(marker)!r}, 'a').write('ran\\n'); os._exit(97)\n"
        local_bin = home / ".local" / "bin"
        local_bin.mkdir(parents=True)
        fake = local_bin / "python3"
        fake.write_text(f"#!/bin/sh\necho ran >> {shlex.quote(str(marker))}\nexit 97\n")
        fake.chmod(0o755)
        on_path = root / "pythonpath"
        on_path.mkdir()
        (on_path / "sitecustomize.py").write_text(payload)
        env = {"HOME": str(home), "PATH": f"{local_bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
               "PYTHONPATH": str(on_path), "PYTHONSTARTUP": str(on_path / "sitecustomize.py")}
        user_site = subprocess.run(
            [sys.executable, "-c", "import site; print(site.getusersitepackages())"],
            env={**env, "PYTHONPATH": ""}, capture_output=True, text=True, check=True, timeout=10,
        ).stdout.strip()
        Path(user_site).mkdir(parents=True)
        (Path(user_site) / "zz-planted.pth").write_text(payload)
        (home / "json.py").write_text(payload)
        return env, home, marker

    def test_helpers_start_the_system_python_isolated(self):
        for name in self.HELPERS:
            with self.subTest(name=name):
                self.assertEqual(self.shebang(name), ("/usr/bin/python3", ["-I"]))
        self.assertEqual(self.browser_heredoc(), ("/usr/bin/python3", ["-I"]))

    def test_code_planted_in_the_home_does_not_run_in_a_helper(self):
        with tempfile.TemporaryDirectory() as temp:
            env, home, marker = self.plant(Path(temp))
            # The control server would listen on 7070; holding the port makes it exit at once.
            held = socket.socket()
            try:
                held.bind(("0.0.0.0", 7070))
            except OSError:
                pass  # Already taken, so the server exits all the same.
            try:
                for name, args in self.HELPERS.items():
                    _, flags = self.shebang(name)
                    # Run this test's Python the way the kernel runs the shebang: the flags are what
                    # decide which of the planted files load.
                    script = str(Path(__file__).with_name(name))
                    with self.subTest(name=name):
                        try:
                            subprocess.run([sys.executable, *flags, script, *args], env=env, cwd=home,
                                           capture_output=True, timeout=10, check=False)
                        except subprocess.TimeoutExpired:
                            pass
                        self.assertFalse(marker.exists(), f"planted code ran in {name}")
                _, flags = self.browser_heredoc()
                subprocess.run([sys.executable, *flags, "-", "1", "profile", "about:blank"], input=b"",
                               env=env, cwd=home, capture_output=True, timeout=10, check=False)
                self.assertFalse(marker.exists(), "planted code ran in rakazo-browser")
            finally:
                held.close()

    def test_the_screen_gateway_starts_without_the_user_site_packages(self):
        start = Path(__file__).with_name("start.sh").read_text()
        launch = [line for line in start.splitlines() if "websockify --" in line]
        self.assertEqual(len(launch), 1)
        # By its full path (not ~/.local/bin first in PATH), and with the command line the desktop
        # runtime's process patterns expect.
        self.assertTrue(launch[0].startswith("PYTHONNOUSERSITE=1 /usr/bin/websockify "), launch[0])
        with tempfile.TemporaryDirectory() as temp:
            env, home, marker = self.plant(Path(temp))
            gateway = Path(temp) / "bin" / "websockify"
            gateway.parent.mkdir()
            gateway.write_text("pass\n")
            # Only the user site-packages: start.sh's own environment comes from the container.
            clean = {"HOME": env["HOME"], "PATH": env["PATH"], "PYTHONNOUSERSITE": "1"}
            subprocess.run([sys.executable, str(gateway)], env=clean, cwd=home, capture_output=True,
                           timeout=10, check=False)
            self.assertFalse(marker.exists())
            subprocess.run([sys.executable, str(gateway)], env={**clean, "PYTHONNOUSERSITE": ""},
                           cwd=home, capture_output=True, timeout=10, check=False)
            self.assertTrue(marker.exists(), "the plant must run without the setting")

    def test_control_children_get_image_programs_and_no_control_token(self):
        with tempfile.TemporaryDirectory() as temp:
            env, _home, marker = self.plant(Path(temp))
            local_bin = env["PATH"].split(os.pathsep)[0]
            for name in ("xdotool", "env"):
                fake = Path(local_bin) / name
                fake.write_text(f"#!/bin/sh\necho ran >> {shlex.quote(str(marker))}\nexit 0\n")
                fake.chmod(0o755)
            argv = ["env", "DISPLAY=:1", "xdotool", "key", "a"]
            with patch.dict(os.environ, {"PATH": f"{local_bin}{os.pathsep}{control.CHILD_PATH}",
                                         "RAKAZO_COMPUTER_CONTROL_TOKEN": "secret-token"}):
                with patch.object(control.subprocess, "run",
                                  return_value=subprocess.CompletedProcess(argv, 0)) as run:
                    control.run_control_argv(argv, ":1")
                child = run.call_args.kwargs["env"]
                self.assertEqual(child["PATH"], control.CHILD_PATH)
                self.assertEqual(child["DISPLAY"], ":1")
                self.assertNotIn("RAKAZO_COMPUTER_CONTROL_TOKEN", child)
                try:
                    control.run_control_argv(argv, ":1")
                except RuntimeError:
                    pass  # No xdotool where the test runs; the planted one must not stand in.
            self.assertFalse(marker.exists())

    @unittest.skipUnless(os.access("/usr/bin/python3", os.X_OK), "requires /usr/bin/python3")
    def test_a_python3_early_in_path_is_not_the_interpreter(self):
        with tempfile.TemporaryDirectory() as temp:
            env, home, marker = self.plant(Path(temp))
            for name in self.HELPERS:
                with self.subTest(name=name):
                    # The helper's own shebang, exec'd for real, over a body that does nothing.
                    script = Path(temp) / name
                    first = Path(__file__).with_name(name).read_text().splitlines()[0]
                    script.write_text(f"{first}\n")
                    script.chmod(0o755)
                    subprocess.run([str(script)], env=env, cwd=home, capture_output=True, timeout=10,
                                   check=False)
                    self.assertFalse(marker.exists(), f"a planted python3 ran {name}")


class XcaptureKeyTest(unittest.TestCase):
    """Level-0 keysyms go through XTest; shifted names are left for xdotool."""

    # name, keycode, level-0 name. None means this name is itself level 0.
    KEYS = (
        ("a", 38, None),
        ("Shift_L", 50, None),
        ("Control_L", 37, None),
        ("Return", 36, None),
        ("slash", 61, None),
        ("equal", 21, None),
        ("2", 11, None),
        ("semicolon", 47, None),
        ("1", 10, None),
        ("question", 61, "slash"),
        ("A", 38, "a"),
        ("plus", 21, "equal"),
        ("at", 11, "2"),
        ("colon", 47, "semicolon"),
        ("exclam", 10, "1"),
    )

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        try:
            root = Path(cls.directory.name)
            include = root / "include"
            for relative, content in cls.headers().items():
                path = include / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            stub = root / "x11_stub.c"
            stub.write_text(cls.stub_source())
            library_path = root / "librakazo-xcapture.so"
            compiled = subprocess.run(
                [
                    "cc",
                    "-O2",
                    "-fPIC",
                    "-shared",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{include}",
                    str(Path(__file__).with_name("xcapture.c")),
                    str(stub),
                    "-o",
                    str(library_path),
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
            if compiled.returncode != 0:
                raise RuntimeError(compiled.stderr or compiled.stdout or f"cc exited {compiled.returncode}")
            library = ctypes.CDLL(str(library_path))
            library.rakazo_xcapture_open.argtypes = [ctypes.c_char_p]
            library.rakazo_xcapture_open.restype = ctypes.c_void_p
            library.rakazo_xcapture_close.argtypes = [ctypes.c_void_p]
            library.rakazo_xcapture_close.restype = None
            library.rakazo_xinput_argv.argtypes = [
                ctypes.c_void_p,
                ctypes.c_int,
                ctypes.POINTER(ctypes.c_char_p),
            ]
            library.rakazo_xinput_argv.restype = ctypes.c_int
            library.rakazo_test_reset_keys.argtypes = []
            library.rakazo_test_reset_keys.restype = None
            library.rakazo_test_key_count.argtypes = []
            library.rakazo_test_key_count.restype = ctypes.c_int
            library.rakazo_test_key_code.argtypes = [ctypes.c_int]
            library.rakazo_test_key_code.restype = ctypes.c_uint
            library.rakazo_test_key_press.argtypes = [ctypes.c_int]
            library.rakazo_test_key_press.restype = ctypes.c_int
            context = library.rakazo_xcapture_open(b":1")
            if not context:
                raise RuntimeError("native capture did not open")
            cls.library = library
            cls.context = context
        except Exception:
            cls.directory.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            if getattr(cls, "context", None):
                cls.library.rakazo_xcapture_close(cls.context)
        finally:
            cls.directory.cleanup()

    def native_key(self, combo):
        self.library.rakazo_test_reset_keys()
        argv = ["env", "DISPLAY=:1", "xdotool", "key", "--clearmodifiers", combo]
        encoded = (ctypes.c_char_p * len(argv))(*(value.encode("utf-8") for value in argv))
        code = self.library.rakazo_xinput_argv(self.context, len(argv), encoded)
        count = self.library.rakazo_test_key_count()
        events = [
            (self.library.rakazo_test_key_code(index), self.library.rakazo_test_key_press(index))
            for index in range(count)
        ]
        return code, events

    def test_level_zero_keysyms_are_pressed_and_released(self):
        cases = {
            "a": [(38, 1), (38, 0)],
            "Return": [(36, 1), (36, 0)],
            "ctrl+a": [(37, 1), (38, 1), (38, 0), (37, 0)],
            "shift+a": [(50, 1), (38, 1), (38, 0), (50, 0)],
        }
        for combo, events in cases.items():
            with self.subTest(combo=combo):
                self.assertEqual(self.native_key(combo), (1, events))

    def test_shifted_keysyms_are_left_for_xdotool(self):
        for combo in ("question", "A", "plus", "at", "colon", "exclam", "ctrl+A", ""):
            with self.subTest(combo=combo):
                self.assertEqual(self.native_key(combo), (0, []))

    @classmethod
    def headers(cls):
        def source(text):
            return textwrap.dedent(text)

        return {
            "X11/Xlib.h": source("""\
                #ifndef RAKAZO_STUB_XLIB_H
                #define RAKAZO_STUB_XLIB_H
                typedef unsigned long XID;
                typedef XID Window;
                typedef XID Drawable;
                typedef XID KeySym;
                typedef unsigned char KeyCode;
                typedef int Bool;
                typedef int Status;
                typedef struct _XDisplay Display;
                typedef struct _Visual Visual;
                typedef struct {
                  int width;
                  int height;
                } XWindowAttributes;
                typedef struct _XImage {
                  char *data;
                  int byte_order;
                  int bytes_per_line;
                  int bits_per_pixel;
                  unsigned long red_mask;
                  unsigned long green_mask;
                  unsigned long blue_mask;
                } XImage;
                typedef struct {
                  short x, y;
                  unsigned short width, height;
                } XRectangle;
                #define True 1
                #define False 0
                #define None 0L
                #define CurrentTime 0L
                #define NoSymbol 0L
                #define AllPlanes ((unsigned long)~0L)
                #define ZPixmap 2
                #define LSBFirst 0
                #define DefaultScreen(dpy) ((void)(dpy), 0)
                #define DefaultDepth(dpy, screen) ((void)(dpy), (void)(screen), 24)
                #define DefaultVisual(dpy, screen) ((void)(dpy), (void)(screen), (Visual *)0)
                #define RootWindow(dpy, screen) ((void)(dpy), (void)(screen), (Window)1)
                #define XConnectionNumber(dpy) ((void)(dpy), -1)
                typedef int (*XIOErrorHandler)(Display *);
                XIOErrorHandler XSetIOErrorHandler(XIOErrorHandler handler);
                Display *XOpenDisplay(const char *name);
                int XCloseDisplay(Display *display);
                int XSync(Display *display, Bool discard);
                Status XGetWindowAttributes(Display *display, Window window, XWindowAttributes *attributes);
                int XFlush(Display *display);
                int XFree(void *data);
                int XDestroyImage(XImage *image);
                KeySym XStringToKeysym(const char *name);
                KeyCode XKeysymToKeycode(Display *display, KeySym symbol);
                #endif
                """),
            "X11/XKBlib.h": source("""\
                #ifndef RAKAZO_STUB_XKBLIB_H
                #define RAKAZO_STUB_XKBLIB_H
                #include <X11/Xlib.h>
                KeySym XkbKeycodeToKeysym(Display *display, KeyCode key, int group, int level);
                #endif
                """),
            "X11/Xutil.h": source("""\
                #ifndef RAKAZO_STUB_XUTIL_H
                #define RAKAZO_STUB_XUTIL_H
                #include <X11/Xlib.h>
                #endif
                """),
            "X11/extensions/XShm.h": source("""\
                #ifndef RAKAZO_STUB_XSHM_H
                #define RAKAZO_STUB_XSHM_H
                #include <X11/Xlib.h>
                typedef struct {
                  int shmid;
                  char *shmaddr;
                  Bool readOnly;
                } XShmSegmentInfo;
                Bool XShmQueryExtension(Display *display);
                XImage *XShmCreateImage(Display *display, Visual *visual, unsigned int depth, int format,
                    char *data, XShmSegmentInfo *shminfo, unsigned int width, unsigned int height);
                Bool XShmAttach(Display *display, XShmSegmentInfo *shminfo);
                Bool XShmDetach(Display *display, XShmSegmentInfo *shminfo);
                Bool XShmGetImage(Display *display, Drawable drawable, XImage *image, int x, int y,
                    unsigned long plane_mask);
                #endif
                """),
            "X11/extensions/Xdamage.h": source("""\
                #ifndef RAKAZO_STUB_XDAMAGE_H
                #define RAKAZO_STUB_XDAMAGE_H
                #include <X11/Xlib.h>
                typedef XID Damage;
                typedef XID XserverRegion;
                #define XDamageReportNonEmpty 3
                Bool XDamageQueryExtension(Display *display, int *event_base, int *error_base);
                Damage XDamageCreate(Display *display, Drawable drawable, int level);
                void XDamageSubtract(Display *display, Damage damage, XserverRegion repair, XserverRegion parts);
                void XDamageDestroy(Display *display, Damage damage);
                #endif
                """),
            "X11/extensions/Xfixes.h": source("""\
                #ifndef RAKAZO_STUB_XFIXES_H
                #define RAKAZO_STUB_XFIXES_H
                #include <X11/Xlib.h>
                #include <X11/extensions/Xdamage.h>
                XserverRegion XFixesCreateRegion(Display *display, XRectangle *rectangles, int count);
                XRectangle *XFixesFetchRegion(Display *display, XserverRegion region, int *count);
                void XFixesDestroyRegion(Display *display, XserverRegion region);
                #endif
                """),
            "X11/extensions/XTest.h": source("""\
                #ifndef RAKAZO_STUB_XTEST_H
                #define RAKAZO_STUB_XTEST_H
                #include <X11/Xlib.h>
                Bool XTestQueryExtension(Display *display, int *event_base, int *error_base, int *major, int *minor);
                int XTestFakeKeyEvent(Display *display, unsigned int keycode, Bool is_press, unsigned long delay);
                int XTestFakeButtonEvent(Display *display, unsigned int button, Bool is_press, unsigned long delay);
                int XTestFakeMotionEvent(Display *display, int screen, int x, int y, unsigned long delay);
                #endif
                """),
            "png.h": source("""\
                #ifndef RAKAZO_STUB_PNG_H
                #define RAKAZO_STUB_PNG_H
                #include <setjmp.h>
                #include <stddef.h>
                #include <stdint.h>
                typedef struct png_struct_def { jmp_buf jmpbuf; } png_struct;
                typedef png_struct *png_structp;
                typedef struct png_info_def { int unused; } png_info;
                typedef png_info *png_infop;
                typedef unsigned char png_byte;
                typedef png_byte *png_bytep;
                typedef size_t png_size_t;
                typedef uint32_t png_uint_32;
                typedef void (*png_rw_ptr)(png_structp, png_bytep, png_size_t);
                typedef void (*png_flush_ptr)(png_structp);
                #define PNG_LIBPNG_VER_STRING "1.6.0"
                #define png_jmpbuf(png) ((png)->jmpbuf)
                #define PNG_FILTER_TYPE_BASE 0
                #define PNG_FILTER_SUB 1
                #define PNG_FILTER_PAETH 2
                #define PNG_COLOR_TYPE_RGB 2
                #define PNG_INTERLACE_NONE 0
                #define PNG_COMPRESSION_TYPE_BASE 0
                void png_error(png_structp png, const char *message);
                void *png_get_io_ptr(png_structp png);
                png_structp png_create_write_struct(const char *version, void *error_ptr, void *error_fn, void *warn_fn);
                png_infop png_create_info_struct(png_structp png);
                void png_destroy_write_struct(png_structp *png, png_infop *info);
                void png_set_write_fn(png_structp png, void *io, png_rw_ptr write, png_flush_ptr flush);
                void png_set_compression_level(png_structp png, int level);
                void png_set_filter(png_structp png, int method, int filters);
                void png_set_IHDR(png_structp png, png_infop info, png_uint_32 width, png_uint_32 height, int depth,
                    int color, int interlace, int compression, int filter);
                void png_write_info(png_structp png, png_infop info);
                void png_write_row(png_structp png, png_bytep row);
                void png_write_end(png_structp png, png_infop info);
                #endif
                """),
        }

    @classmethod
    def stub_source(cls):
        rows = []
        for name, code, level0 in cls.KEYS:
            level = "NULL" if level0 is None else f'"{level0}"'
            rows.append(f'{{"{name}", {code}, {level}}}')
        table = ",\n  ".join(rows)
        return textwrap.dedent("""\
            #include <X11/Xlib.h>
            #include <X11/XKBlib.h>
            #include <X11/extensions/XShm.h>
            #include <X11/extensions/Xdamage.h>
            #include <X11/extensions/Xfixes.h>
            #include <X11/extensions/XTest.h>
            #include <png.h>
            #include <stddef.h>
            #include <string.h>

            static int display_slot;

            Display *XOpenDisplay(const char *name) {
              (void)name;
              display_slot = 1;
              return (Display *)&display_slot;
            }
            int XCloseDisplay(Display *display) { (void)display; return 0; }
            int XSync(Display *display, Bool discard) { (void)display; (void)discard; return 0; }
            Status XGetWindowAttributes(Display *display, Window window, XWindowAttributes *attributes) {
              (void)display; (void)window; (void)attributes; return 0;
            }
            int XFlush(Display *display) { (void)display; return 1; }
            XIOErrorHandler XSetIOErrorHandler(XIOErrorHandler handler) { (void)handler; return NULL; }
            int XFree(void *data) { (void)data; return 0; }
            int XDestroyImage(XImage *image) { (void)image; return 0; }

            typedef struct {
              const char *name;
              unsigned int keycode;
              const char *level0;
            } KeyEntry;

            static const KeyEntry KEYS[] = {
              __KEYS__
            };

            static KeySym symbol_for(const char *name) {
              for (size_t index = 0; index < sizeof KEYS / sizeof KEYS[0]; index++) {
                if (!strcmp(KEYS[index].name, name)) return (KeySym)(index + 1);
              }
              return NoSymbol;
            }

            KeySym XStringToKeysym(const char *name) { return symbol_for(name); }

            KeyCode XKeysymToKeycode(Display *display, KeySym symbol) {
              (void)display;
              if (symbol == NoSymbol || symbol > sizeof KEYS / sizeof KEYS[0]) return 0;
              return (KeyCode)KEYS[symbol - 1].keycode;
            }

            KeySym XkbKeycodeToKeysym(Display *display, KeyCode key, int group, int level) {
              (void)display;
              if (group != 0 || level != 0) return NoSymbol;
              for (size_t index = 0; index < sizeof KEYS / sizeof KEYS[0]; index++) {
                if (KEYS[index].keycode == key && KEYS[index].level0 == NULL) return (KeySym)(index + 1);
              }
              return NoSymbol;
            }

            enum { KEY_EVENT_CAP = 64 };
            static unsigned int key_codes[KEY_EVENT_CAP];
            static int key_presses[KEY_EVENT_CAP];
            static int key_event_count;

            void rakazo_test_reset_keys(void) { key_event_count = 0; }
            int rakazo_test_key_count(void) { return key_event_count; }
            unsigned int rakazo_test_key_code(int index) {
              if (index < 0 || index >= key_event_count || index >= KEY_EVENT_CAP) return 0;
              return key_codes[index];
            }
            int rakazo_test_key_press(int index) {
              if (index < 0 || index >= key_event_count || index >= KEY_EVENT_CAP) return 0;
              return key_presses[index];
            }

            Bool XShmQueryExtension(Display *display) { (void)display; return True; }
            XImage *XShmCreateImage(Display *display, Visual *visual, unsigned int depth, int format, char *data,
                XShmSegmentInfo *shminfo, unsigned int width, unsigned int height) {
              (void)display; (void)visual; (void)depth; (void)format; (void)data; (void)shminfo;
              (void)width; (void)height; return 0;
            }
            Bool XShmAttach(Display *display, XShmSegmentInfo *shminfo) { (void)display; (void)shminfo; return False; }
            Bool XShmDetach(Display *display, XShmSegmentInfo *shminfo) { (void)display; (void)shminfo; return True; }
            Bool XShmGetImage(Display *display, Drawable drawable, XImage *image, int x, int y,
                unsigned long plane_mask) {
              (void)display; (void)drawable; (void)image; (void)x; (void)y; (void)plane_mask; return False;
            }
            Bool XDamageQueryExtension(Display *display, int *event_base, int *error_base) {
              (void)display;
              if (event_base) *event_base = 0;
              if (error_base) *error_base = 0;
              return False;
            }
            Damage XDamageCreate(Display *display, Drawable drawable, int level) {
              (void)display; (void)drawable; (void)level; return 0;
            }
            void XDamageSubtract(Display *display, Damage damage, XserverRegion repair, XserverRegion parts) {
              (void)display; (void)damage; (void)repair; (void)parts;
            }
            void XDamageDestroy(Display *display, Damage damage) { (void)display; (void)damage; }
            XserverRegion XFixesCreateRegion(Display *display, XRectangle *rectangles, int count) {
              (void)display; (void)rectangles; (void)count; return 0;
            }
            XRectangle *XFixesFetchRegion(Display *display, XserverRegion region, int *count) {
              (void)display; (void)region; (void)count; return 0;
            }
            void XFixesDestroyRegion(Display *display, XserverRegion region) { (void)display; (void)region; }
            Bool XTestQueryExtension(Display *display, int *event_base, int *error_base, int *major, int *minor) {
              (void)display; (void)event_base; (void)error_base; (void)major; (void)minor; return True;
            }
            int XTestFakeKeyEvent(Display *display, unsigned int keycode, Bool is_press, unsigned long delay) {
              (void)display; (void)delay;
              if (key_event_count < KEY_EVENT_CAP) {
                key_codes[key_event_count] = keycode;
                key_presses[key_event_count] = is_press;
              }
              key_event_count++;
              return 1;
            }
            int XTestFakeButtonEvent(Display *display, unsigned int button, Bool is_press, unsigned long delay) {
              (void)display; (void)button; (void)is_press; (void)delay; return 1;
            }
            int XTestFakeMotionEvent(Display *display, int screen, int x, int y, unsigned long delay) {
              (void)display; (void)screen; (void)x; (void)y; (void)delay; return 1;
            }
            void png_error(png_structp png, const char *message) { (void)png; (void)message; }
            void *png_get_io_ptr(png_structp png) { (void)png; return 0; }
            png_structp png_create_write_struct(const char *version, void *error_ptr, void *error_fn, void *warn_fn) {
              (void)version; (void)error_ptr; (void)error_fn; (void)warn_fn; return 0;
            }
            png_infop png_create_info_struct(png_structp png) { (void)png; return 0; }
            void png_destroy_write_struct(png_structp *png, png_infop *info) { (void)png; (void)info; }
            void png_set_write_fn(png_structp png, void *io, png_rw_ptr write, png_flush_ptr flush) {
              (void)png; (void)io; (void)write; (void)flush;
            }
            void png_set_compression_level(png_structp png, int level) { (void)png; (void)level; }
            void png_set_filter(png_structp png, int method, int filters) {
              (void)png; (void)method; (void)filters;
            }
            void png_set_IHDR(png_structp png, png_infop info, png_uint_32 width, png_uint_32 height, int depth,
                int color, int interlace, int compression, int filter) {
              (void)png; (void)info; (void)width; (void)height; (void)depth; (void)color;
              (void)interlace; (void)compression; (void)filter;
            }
            void png_write_info(png_structp png, png_infop info) { (void)png; (void)info; }
            void png_write_row(png_structp png, png_bytep row) { (void)png; (void)row; }
            void png_write_end(png_structp png, png_infop info) { (void)png; (void)info; }
            """).replace("__KEYS__", table)


if __name__ == "__main__":
    unittest.main()
