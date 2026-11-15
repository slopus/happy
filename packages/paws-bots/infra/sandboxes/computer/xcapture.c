// Persistent, lossless X11 desktop capture with MIT-SHM and XDamage metadata.
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/XTest.h>
#include <png.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <poll.h>
#include <unistd.h>
#include <setjmp.h>
#include <sys/shm.h>

typedef struct {
  Display *display;
  Window root;
  XImage *image;
  XShmSegmentInfo shminfo;
  unsigned char *rgb;
  size_t rgb_size;
  unsigned char *png;
  size_t png_size;
  size_t png_capacity;
  int width;
  int height;
  Damage damage;
  int damage_supported;
} XCapture;

static void png_write(png_structp png, png_bytep data, png_size_t length) {
  XCapture *capture = png_get_io_ptr(png);
  if (length > SIZE_MAX - capture->png_size) png_error(png, "PNG output exceeds address space");
  const size_t needed = capture->png_size + length;
  if (needed > capture->png_capacity) {
    size_t capacity = capture->png_capacity ? capture->png_capacity : 65536;
    while (capacity < needed) capacity *= 2;
    unsigned char *output = realloc(capture->png, capacity);
    if (!output) png_error(png, "PNG allocation failed");
    capture->png = output;
    capture->png_capacity = capacity;
  }
  memcpy(capture->png + capture->png_size, data, length);
  capture->png_size += length;
}

static void png_flush(png_structp png) { (void)png; }

static unsigned long extract_pixel(const XImage *image, int x, int y) {
  const unsigned char *source = (const unsigned char *)image->data +
      (size_t)y * image->bytes_per_line + (size_t)x * (image->bits_per_pixel / 8);
  unsigned long pixel = 0;
  const int bytes = image->bits_per_pixel / 8;
  if (image->byte_order == LSBFirst) {
    for (int index = bytes - 1; index >= 0; index--) pixel = (pixel << 8) | source[index];
  } else {
    for (int index = 0; index < bytes; index++) pixel = (pixel << 8) | source[index];
  }
  return pixel;
}

static unsigned char channel(unsigned long pixel, unsigned long mask) {
  if (!mask) return 0;
  unsigned int shift = 0;
  while (((mask >> shift) & 1U) == 0U) shift++;
  unsigned long maximum = mask >> shift;
  return (unsigned char)((((pixel & mask) >> shift) * 255U + maximum / 2U) / maximum);
}

static __thread sigjmp_buf xio_jmp;
static __thread int xio_jmp_active = 0;

static int xio_error_handler(Display *display) {
  (void)display;
  if (xio_jmp_active) {
    xio_jmp_active = 0;
    siglongjmp(xio_jmp, 1);
  }
  return 0;
}

static int display_alive(Display *display) {
  if (!display) return 0;
  struct pollfd pfd = {.fd = XConnectionNumber(display), .events = POLLIN};
  if (poll(&pfd, 1, 0) < 0) return 0;
  return (pfd.revents & (POLLHUP | POLLERR | POLLNVAL)) == 0;
}

static void close_display(Display *display, int alive) {
  if (!display) return;
  if (!alive) {
    const int fd = XConnectionNumber(display);
    if (fd >= 0) close(fd);
    return;
  }
  XSetIOErrorHandler(xio_error_handler);
  if (sigsetjmp(xio_jmp, 1) == 0) {
    xio_jmp_active = 1;
    XCloseDisplay(display);
    xio_jmp_active = 0;
  } else {
    xio_jmp_active = 0;
    const int fd = XConnectionNumber(display);
    if (fd >= 0) close(fd);
  }
}

static void release_image(XCapture *capture, int detach_server) {
  if (!capture || !capture->image) return;
  if (detach_server && capture->display) XShmDetach(capture->display, &capture->shminfo);
  XDestroyImage(capture->image);
  shmdt(capture->shminfo.shmaddr);
  capture->image = NULL;
}

static int allocate_image(XCapture *capture, int width, int height) {
  release_image(capture, 1);
  capture->image = XShmCreateImage(capture->display, DefaultVisual(capture->display, DefaultScreen(capture->display)),
      DefaultDepth(capture->display, DefaultScreen(capture->display)), ZPixmap, NULL, &capture->shminfo, width, height);
  if (!capture->image) return -1;
  const size_t size = (size_t)capture->image->bytes_per_line * height;
  capture->shminfo.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
  if (capture->shminfo.shmid < 0) return -1;
  capture->shminfo.shmaddr = shmat(capture->shminfo.shmid, NULL, 0);
  shmctl(capture->shminfo.shmid, IPC_RMID, NULL);
  if (capture->shminfo.shmaddr == (char *)-1) return -1;
  capture->shminfo.readOnly = False;
  capture->image->data = capture->shminfo.shmaddr;
  if (!XShmAttach(capture->display, &capture->shminfo)) return -1;
  XSync(capture->display, False);
  capture->width = width;
  capture->height = height;
  capture->rgb_size = (size_t)width * height * 3;
  capture->rgb = realloc(capture->rgb, capture->rgb_size);
  return capture->rgb ? 0 : -1;
}

static int open_capture(XCapture *capture, const char *display_name) {
  capture->display = XOpenDisplay(display_name);
  if (!capture->display || !display_alive(capture->display) || !XShmQueryExtension(capture->display)) return -1;
  capture->root = RootWindow(capture->display, DefaultScreen(capture->display));
  int event_base, error_base;
  capture->damage_supported = XDamageQueryExtension(capture->display, &event_base, &error_base);
  if (capture->damage_supported) capture->damage = XDamageCreate(capture->display, capture->root, XDamageReportNonEmpty);
  return 0;
}

void *rakazo_xcapture_open(const char *display_name) {
  XCapture *volatile capture = calloc(1, sizeof(*capture));
  if (!capture) return NULL;
  XSetIOErrorHandler(xio_error_handler);
  if (sigsetjmp(xio_jmp, 1) != 0) {
    xio_jmp_active = 0;
    release_image(capture, 0);
    close_display(capture->display, 0);
    free(capture);
    return NULL;
  }
  xio_jmp_active = 1;
  const int failed = open_capture(capture, display_name);
  xio_jmp_active = 0;
  if (failed) {
    close_display(capture->display, display_alive(capture->display));
    free(capture);
    return NULL;
  }
  return capture;
}

int rakazo_xcapture_copy(void *context, const unsigned char **rgb, int *width, int *height) {
  XCapture *volatile capture = context;
  if (!capture || !rgb || !width || !height || !display_alive(capture->display)) return -1;
  XSetIOErrorHandler(xio_error_handler);
  if (sigsetjmp(xio_jmp, 1) != 0) {
    xio_jmp_active = 0;
    return -1;
  }
  xio_jmp_active = 1;
  XWindowAttributes attributes;
  if (!XGetWindowAttributes(capture->display, capture->root, &attributes)) {
    xio_jmp_active = 0;
    return -1;
  }
  if (!capture->image || attributes.width != capture->width || attributes.height != capture->height) {
    if (allocate_image(capture, attributes.width, attributes.height)) {
      xio_jmp_active = 0;
      return -1;
    }
  }
  if (!XShmGetImage(capture->display, capture->root, capture->image, 0, 0, AllPlanes)) {
    xio_jmp_active = 0;
    return -1;
  }
  xio_jmp_active = 0;
  for (int y = 0; y < capture->height; y++) {
    for (int x = 0; x < capture->width; x++) {
      const unsigned long pixel = extract_pixel(capture->image, x, y);
      unsigned char *target = capture->rgb + ((size_t)y * capture->width + x) * 3;
      target[0] = channel(pixel, capture->image->red_mask);
      target[1] = channel(pixel, capture->image->green_mask);
      target[2] = channel(pixel, capture->image->blue_mask);
    }
  }
  *rgb = capture->rgb;
  *width = capture->width;
  *height = capture->height;
  return 0;
}

int rakazo_xcapture_png(void *context, const unsigned char **png_bytes, size_t *png_size,
    int *width, int *height) {
  XCapture *capture = context;
  if (!png_bytes || !png_size) return -1;
  const unsigned char *rgb = NULL;
  if (rakazo_xcapture_copy(context, &rgb, width, height)) return -1;
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
  if (!png) return -1;
  png_infop info = png_create_info_struct(png);
  if (!info) {
    png_destroy_write_struct(&png, NULL);
    return -1;
  }
  if (setjmp(png_jmpbuf(png))) {
    png_destroy_write_struct(&png, &info);
    return -1;
  }
  capture->png_size = 0;
  png_set_write_fn(png, capture, png_write, png_flush);
  png_set_compression_level(png, 3);
  png_set_filter(png, PNG_FILTER_TYPE_BASE, PNG_FILTER_SUB | PNG_FILTER_PAETH);
  png_set_IHDR(png, info, *width, *height, 8, PNG_COLOR_TYPE_RGB,
      PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_BASE, PNG_FILTER_TYPE_BASE);
  png_write_info(png, info);
  for (int y = 0; y < *height; y++) png_write_row(png, (png_bytep)(rgb + (size_t)y * *width * 3));
  png_write_end(png, info);
  png_destroy_write_struct(&png, &info);
  *png_bytes = capture->png;
  *png_size = capture->png_size;
  return 0;
}

int rakazo_xcapture_damage(void *context, int *x, int *y, int *width, int *height) {
  XCapture *volatile capture = context;
  if (!capture || !capture->damage_supported || !capture->damage || !display_alive(capture->display)) return 0;
  XSetIOErrorHandler(xio_error_handler);
  if (sigsetjmp(xio_jmp, 1) != 0) {
    xio_jmp_active = 0;
    return 0;
  }
  xio_jmp_active = 1;
  XserverRegion region = XFixesCreateRegion(capture->display, NULL, 0);
  XDamageSubtract(capture->display, capture->damage, None, region);
  int count = 0;
  XRectangle *rectangles = XFixesFetchRegion(capture->display, region, &count);
  XFixesDestroyRegion(capture->display, region);
  xio_jmp_active = 0;
  if (!rectangles || count == 0) {
    if (rectangles) XFree(rectangles);
    return 0;
  }
  int left = rectangles[0].x, top = rectangles[0].y;
  int right = rectangles[0].x + rectangles[0].width, bottom = rectangles[0].y + rectangles[0].height;
  for (int index = 1; index < count; index++) {
    if (rectangles[index].x < left) left = rectangles[index].x;
    if (rectangles[index].y < top) top = rectangles[index].y;
    if (rectangles[index].x + rectangles[index].width > right) right = rectangles[index].x + rectangles[index].width;
    if (rectangles[index].y + rectangles[index].height > bottom) bottom = rectangles[index].y + rectangles[index].height;
  }
  XFree(rectangles);
  if (x) *x = left;
  if (y) *y = top;
  if (width) *width = right - left;
  if (height) *height = bottom - top;
  return 1;
}

void rakazo_xcapture_close(void *context) {
  XCapture *volatile capture = context;
  if (!capture) return;
  const int alive = display_alive(capture->display);
  XSetIOErrorHandler(xio_error_handler);
  if (alive && sigsetjmp(xio_jmp, 1) == 0) {
    xio_jmp_active = 1;
    if (capture->damage) XDamageDestroy(capture->display, capture->damage);
    release_image(capture, 1);
    xio_jmp_active = 0;
  } else {
    xio_jmp_active = 0;
    release_image(capture, 0);
  }
  free(capture->rgb);
  free(capture->png);
  close_display(capture->display, alive);
  free(capture);
}

static KeySym key_symbol(const char *name) {
  if (!strcmp(name, "ctrl")) return XStringToKeysym("Control_L");
  if (!strcmp(name, "alt")) return XStringToKeysym("Alt_L");
  if (!strcmp(name, "shift")) return XStringToKeysym("Shift_L");
  if (!strcmp(name, "super")) return XStringToKeysym("Super_L");
  return XStringToKeysym(name);
}

static int xinput_argv_locked(XCapture *capture, int argc, const char *const *argv);

int rakazo_xinput_argv(void *context, int argc, const char *const *argv) {
  XCapture *volatile capture = context;
  if (!capture || !capture->display) return 0;
  if (!display_alive(capture->display)) return -1;
  XSetIOErrorHandler(xio_error_handler);
  if (sigsetjmp(xio_jmp, 1) != 0) {
    xio_jmp_active = 0;
    return -1;
  }
  xio_jmp_active = 1;
  const int result = xinput_argv_locked(capture, argc, argv);
  xio_jmp_active = 0;
  return display_alive(capture->display) ? result : -1;
}

static int xinput_argv_locked(XCapture *capture, int argc, const char *const *argv) {
  if (!capture || argc < 4 || strcmp(argv[0], "env") || strncmp(argv[1], "DISPLAY=", 8) || strcmp(argv[2], "xdotool")) return 0;
  if (!XTestQueryExtension(capture->display, &(int){0}, &(int){0}, &(int){0}, &(int){0})) return -1;
  if (!strcmp(argv[3], "key") && argc == 6 && !strcmp(argv[4], "--clearmodifiers")) {
    char combo[128];
    if (strlen(argv[5]) >= sizeof(combo)) return 0;
    strcpy(combo, argv[5]);
    KeyCode keys[8]; int count = 0;
    for (char *part = strtok(combo, "+"); part; part = strtok(NULL, "+")) {
      const KeySym symbol = key_symbol(part);
      const KeyCode key = symbol == NoSymbol ? 0 : XKeysymToKeycode(capture->display, symbol);
      if (!key || XkbKeycodeToKeysym(capture->display, key, 0, 0) != symbol || count == 8) return 0;
      keys[count++] = key;
    }
    if (!count) return 0;
    for (int i = 0; i < count; i++) XTestFakeKeyEvent(capture->display, keys[i], True, CurrentTime);
    for (int i = count - 1; i >= 0; i--) XTestFakeKeyEvent(capture->display, keys[i], False, CurrentTime);
    XFlush(capture->display);
    return 1;
  }
  if (!strcmp(argv[3], "mousemove") && argc >= 7 && !strcmp(argv[4], "--")) {
    int x = atoi(argv[5]), y = atoi(argv[6]);
    XTestFakeMotionEvent(capture->display, DefaultScreen(capture->display), x, y, CurrentTime);
    if (argc == 7) { XFlush(capture->display); return 1; }
    if (argc == 9 && (!strcmp(argv[7], "click") || !strcmp(argv[7], "mousedown"))) {
      const unsigned int button = (unsigned int)atoi(argv[8]);
      XTestFakeButtonEvent(capture->display, button, True, CurrentTime);
      if (!strcmp(argv[7], "click")) XTestFakeButtonEvent(capture->display, button, False, CurrentTime);
      XFlush(capture->display); return 1;
    }
  }
  if (!strcmp(argv[3], "mouseup") && argc == 5) {
    XTestFakeButtonEvent(capture->display, (unsigned int)atoi(argv[4]), False, CurrentTime);
    XFlush(capture->display); return 1;
  }
  if (!strcmp(argv[3], "click") && argc == 6) {
    const int count = atoi(argv[4]); const unsigned int button = (unsigned int)atoi(argv[5]);
    if (count < 1 || count > 20) return 0;
    for (int i = 0; i < count; i++) { XTestFakeButtonEvent(capture->display, button, True, CurrentTime); XTestFakeButtonEvent(capture->display, button, False, CurrentTime); }
    XFlush(capture->display); return 1;
  }
  return 0;
}
