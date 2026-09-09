#ifndef _STDIO_H
#define _STDIO_H

typedef struct FILE FILE;
extern FILE *stderr;
extern FILE *stdout;

int fprintf(FILE *f, const char *fmt, ...);
int printf(const char *fmt, ...);

#ifndef NULL
#define NULL ((void *)0)
#endif

#endif
