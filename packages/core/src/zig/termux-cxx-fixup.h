// termux-cxx-fixup.h — Force-included BEFORE every C++ source file.
//
// This header does NOT touch <math.h>. Instead, it provides std:: function
// overloads that call the __builtin_ functions directly. The problem:
//
// Bionic's <math.h> defines:  #define isinf(x) __builtin_isinf(x)
// When C++ does:              std::isinf(value)
// The preprocessor expands:   std::__builtin_isinf(value)  ← doesn't exist
//
// <cmath> tries:              using ::isinf;
// But 'isinf' is a macro, not a function, so 'using' fails or imports nothing.
//
// FIX: This header runs BEFORE user code (via -include). It:
//   1. #undefs the C macros (clears the pollution)
//   2. Declares the functions in global namespace (matches what <cmath> expects)
//   3. <cmath>'s 'using ::isinf' can now find them
//
// IMPORTANT: This runs via -include, which means it runs BEFORE the source
// file but AFTER any -include'd system headers. <cmath> gets included by
// the source file LATER, at which point our #undefs + declarations are
// already in place. <cmath> does #include <math.h> (re-defining macros),
// then 'using ::isinf' (finds our declaration). Then user code runs with
// the macros still defined BUT std::isinf now resolves to our function.

#pragma once

#ifdef __cplusplus

// Step 1: Undef any pre-existing macros (from previous includes)
#undef isinf
#undef isnan
#undef fabs
#undef abs

// Step 2: Provide function declarations in the global namespace.
// These match Bionic's C library functions. <cmath> will do
// 'using ::isinf' which imports these into std::.
extern "C" {
    int __builtin_isinf_alias(double);
    int __builtin_isnan_alias(double);
    double __builtin_fabs_alias(double);
}

// Provide the actual function definitions as inline wrappers
inline int isinf(double x) { return __builtin_isinf(x); }
inline int isnan(double x) { return __builtin_isnan(x); }
inline double fabs(double x) { return __builtin_fabs(x); }

// Also provide float overloads
inline int isinf(float x) { return __builtin_isinf(x); }
inline int isnan(float x) { return __builtin_isnan(x); }
inline float fabs(float x) { return __builtin_fabsf(x); }

// std::abs for integers and floats
namespace std {
    inline int abs(int x) { return __builtin_abs(x); }
    inline long abs(long x) { return __builtin_labs(x); }
    inline long long abs(long long x) { return __builtin_llabs(x); }
    inline float abs(float x) { return __builtin_fabsf(x); }
    inline double abs(double x) { return __builtin_fabs(x); }
    inline long double abs(long double x) { return __builtin_fabsl(x); }

    // std::isinf / std::isnan — call the builtins directly
    inline bool isinf(float x) { return __builtin_isinf(x); }
    inline bool isinf(double x) { return __builtin_isinf(x); }
    inline bool isinf(long double x) { return __builtin_isinf(x); }
    inline bool isnan(float x) { return __builtin_isnan(x); }
    inline bool isnan(double x) { return __builtin_isnan(x); }
    inline bool isnan(long double x) { return __builtin_isnan(x); }
}

#endif // __cplusplus
