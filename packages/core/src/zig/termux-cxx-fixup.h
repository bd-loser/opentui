// termux-cxx-fixup.h — Force-included before every C++ source file.
//
// Termux's math.h defines isinf/isnan/fabs/abs as C macros:
//   #define isinf(x) __builtin_isinf(x)
//   #define isnan(x) __builtin_isnan(x)
//
// In C++ context these macros break std::isinf/std::isnan/std::abs
// because the preprocessor expands the identifier 'isinf' inside
// 'std::isinf(value)' to '__builtin_isinf' → 'std::__builtin_isinf'.
//
// This header is force-included via -include BEFORE any source file.
// It doesn't help BEFORE math.h (math.h re-defines the macros), but
// it sets up a wrapper that prevents the macros from being defined.
//
// The trick: we define the macros as IDENTICAL to themselves using
// a technique that prevents math.h's #define from taking effect.
// Actually the cleanest approach: we #undef them and redefine as
// no-ops that call the C++ std:: versions. But since math.h might
// be included AFTER this file, we use a different approach:
//
// We provide wrapper functions in the global namespace that call
// std::isinf etc. Then we #undef the macros so they don't interfere.
// This runs BEFORE math.h, so when math.h does #define isinf(x)...,
// our #undef has already run and the macro will be defined — BUT
// we then re-#undef it after math.h using __attribute__((constructor)).
//
// Actually the simplest: just #undef them here. math.h will redefine
// them when it's included. So we ALSO need to prevent math.h from
// being included, OR accept the macros and use them.
//
// FINAL APPROACH: Don't fight the macros. Instead, tell the compiler
// to treat isinf/isnan as function calls, not macros, by wrapping
// them in parentheses in user code. But we can't modify yoga's source.
//
// REAL FIX: Use -include with this file which does:
//   #pragma once
//   #undef isinf
//   #undef isnan
//   #undef fabs
//   #undef abs
//
// This runs before the source file. When math.h is included later,
// it will #define them — but in C++ mode, <cmath> typically #undefs
// them itself. The problem is when <math.h> (C) is included WITHOUT
// <cmath>. In that case, our #undef here doesn't help.
//
// So we use the NUCLEAR option: define __NO_MATH_MACROS before math.h.

#pragma once

// Prevent math.h from defining isinf/isnan/fabs/abs as macros.
// Bionic's math.h respects this guard in some versions.
#define __NO_MATH_MACROS 1

// Also undef in case they're already defined from a previous include
#undef isinf
#undef isnan
#undef fabs
#undef abs

// Provide inline C++ replacements that call std:: versions
#ifdef __cplusplus
#include <cmath>
inline bool isinf(float x) { return std::isinf(x); }
inline bool isinf(double x) { return std::isinf(x); }
inline bool isnan(float x) { return std::isnan(x); }
inline bool isnan(double x) { return std::isnan(x); }
inline float fabs(float x) { return std::fabs(x); }
inline double fabs(double x) { return std::fabs(x); }
#endif
