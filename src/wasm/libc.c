#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

FILE *stderr;
FILE *stdout;

extern unsigned char __heap_base;
static unsigned char *brk;

static void heap_init(void) {
  if (!brk)
    brk = &__heap_base;
}

static void *sbrk_align(size_t n) {
  heap_init();
  n = (n + 15u) & ~15u;
  unsigned char *p = brk;
  unsigned char *next = p + n;
  size_t needed = (size_t)next;
  size_t have = __builtin_wasm_memory_size(0) << 16;
  if (needed > have) {
    size_t pages = (needed - have + 65535u) >> 16;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1)
      return 0;
  }
  brk = next;
  return p;
}

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  while (n--)
    *d++ = *s++;
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  if (d == s || n == 0)
    return dst;
  if (d < s) {
    while (n--)
      *d++ = *s++;
  } else {
    d += n;
    s += n;
    while (n--)
      *--d = *--s;
  }
  return dst;
}

void *memset(void *dst, int c, size_t n) {
  unsigned char *d = dst;
  while (n--)
    *d++ = (unsigned char)c;
  return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *p = a, *q = b;
  while (n--) {
    if (*p != *q)
      return *p - *q;
    p++;
    q++;
  }
  return 0;
}

void *malloc(size_t n) { return sbrk_align(n ? n : 1); }

void *calloc(size_t a, size_t b) {
  size_t n = a * b;
  void *p = malloc(n);
  if (p)
    memset(p, 0, n);
  return p;
}

void *realloc(void *ptr, size_t n) {
  if (!ptr)
    return malloc(n);
  void *p = malloc(n);
  if (p && n)
    memcpy(p, ptr, n);
  return p;
}

void free(void *ptr) { (void)ptr; }

void abort(void) { __builtin_trap(); }

void exit(int code) {
  (void)code;
  __builtin_trap();
}

int fprintf(FILE *f, const char *fmt, ...) {
  (void)f;
  (void)fmt;
  return 0;
}

int printf(const char *fmt, ...) {
  (void)fmt;
  return 0;
}
