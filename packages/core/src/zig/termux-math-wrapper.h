// termux-math-wrapper.h — NOT a standalone include. This is a wrapper
// for Bionic's math.h that #undefs the C macros after inclusion.
//
// This file is renamed to 'math.h' in a wrapper include dir that's
// placed FIRST in the -I search path. So when any C/C++ source does
// #include <math.h>, they get THIS file instead of Bionic's.
//
// This file then:
//   1. Includes the REAL Bionic math.h (via the next include path)
//   2. #undefs isinf/isnan/fabs/abs that Bionic defined as macros
//
// After this, std::isinf/std::isnan/std::abs in C++ work correctly
// because the macro names are no longer polluted.
#pragma once

// Step 1: Include the REAL Bionic math.h. Use the absolute path so we
// don't recurse into ourselves. Bionic's math.h lives at
// $PREFIX/include/math.h on Termux.
// NOTE: The path is filled in by build-native-termux.sh at build time
// via sed, OR we use __has_include to find it.

// Try to include the real math.h from Termux's include dir.
// We use a relative include path trick: the NEXT -I path in the search
// chain has the real math.h. But since we can't do "next path" in C,
// we hardcode the Termux path via a macro set by -DTERMUX_MATH_H_PATH.
#ifdef TERMUX_MATH_H_PATH
#include TERMUX_MATH_H_PATH
#else
// Fallback: try the standard Termux path directly
#include_next <math.h>
#endif

// Step 2: Undef the C macros that Bionic defined. These break C++
// std::isinf/std::isnan/std::abs because the preprocessor expands
// the function names.
#undef isinf
#undef isnan
#undef fabs
#undef abs
#undef isfinite
#undef isinf_double
#undef signbit
