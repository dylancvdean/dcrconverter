#ifndef _STDLIB_H
#define _STDLIB_H

typedef unsigned int size_t;

void *malloc(size_t n);
void *calloc(size_t a, size_t b);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void);
void exit(int code);

#ifndef NULL
#define NULL ((void *)0)
#endif

#endif
