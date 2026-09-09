#ifndef _MATH_H
#define _MATH_H

/* Speex fixed-point decoder should not need libm. Stubs keep #include <math.h> happy. */
double floor(double x);
double exp(double x);
double log(double x);
double sqrt(double x);
double pow(double x, double y);
double fabs(double x);
float floorf(float x);
float fabsf(float x);

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#endif
