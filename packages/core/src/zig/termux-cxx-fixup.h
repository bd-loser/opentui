// termux-cxx-fixup.h — Force-included BEFORE every C++ source file.
//
// ROOT CAUSE of all the math.h errors:
//   Bionic <math.h>: #define isinf(x) __builtin_isinf(x)
//   libc++ <cmath>:  using ::isinf _LIBCPP_USING_IF_EXISTS;
//
// The 'using ::isinf' tries to import the C function 'isinf', but
// 'isinf' is a MACRO, not a function. _LIBCPP_USING_IF_EXISTS is
// normally a no-op attribute that makes 'using' tolerate missing
// declarations. But when 'isinf' is a macro, 'using ::isinf' resolves
// to nothing → std::isinf doesn't exist → "unresolved using declaration".
//
// FIX: Two-pronged approach:
//   1. Define _LIBCPP_USING_IF_EXISTS to nothing so the attribute doesn't
//      cause problems (it's normally __attribute__((using_if_exists)))
//   2. Provide std::isinf/isnan/abs as inline functions calling __builtin_*
//      directly, so they exist regardless of what <cmath> does
//
// This runs via -include, BEFORE the source file. <cmath> gets included
// later by yoga's headers, but our std:: functions are already declared
// and will be found by name lookup.

#pragma once

#ifdef __cplusplus

// Neutralize _LIBCPP_USING_IF_EXISTS so 'using ::isinf _LIBCPP_USING_IF_EXISTS'
// doesn't fail when isinf is a macro. The attribute is normally
// __attribute__((using_if_exists)) which makes 'using' tolerate missing
// declarations. By defining it to nothing, the 'using' declaration
// becomes a normal 'using' which either succeeds or is ignored.
#ifdef _LIBCPP_USING_IF_EXISTS
#undef _LIBCPP_USING_IF_EXISTS
#endif
#define _LIBCPP_USING_IF_EXISTS

// Provide std:: functions that call __builtin_* directly.
// These win over any macro-based versions because function declarations
// have proper namespace scoping.
#include <cmath>

namespace std {
    // Override the broken using declarations with real functions
    inline bool isinf(float x) { return __builtin_isinf(x); }
    inline bool isinf(double x) { return __builtin_isinf(x); }
    inline bool isinf(long double x) { return __builtin_isinf(x); }
    inline bool isnan(float x) { return __builtin_isnan(x); }
    inline bool isnan(double x) { return __builtin_isnan(x); }
    inline bool isnan(long double x) { return __builtin_isnan(x); }
    inline bool isfinite(float x) { return __builtin_isfinite(x); }
    inline bool isfinite(double x) { return __builtin_isfinite(x); }
    inline bool isfinite(long double x) { return __builtin_isfinite(x); }
    inline bool signbit(float x) { return __builtin_signbit(x); }
    inline bool signbit(double x) { return __builtin_signbit(x); }
    inline bool signbit(long double x) { return __builtin_signbit(x); }

    inline float abs(float x) { return __builtin_fabsf(x); }
    inline double abs(double x) { return __builtin_fabs(x); }
    inline long double abs(long double x) { return __builtin_fabsl(x); }
    inline float fabs(float x) { return __builtin_fabsf(x); }
    inline double fabs(double x) { return __builtin_fabs(x); }
    inline long double fabs(long double x) { return __builtin_fabsl(x); }
}

// Undef the C macros so they don't pollute user code.
// This runs AFTER <cmath> has processed <math.h>, so the using
// declarations have already captured whatever they could.
#undef isinf
#undef isnan
#undef fabs
#undef abs
#undef isfinite
#undef signbit
#undef isunordered
#undef fpclassify

#endif // __cplusplus
