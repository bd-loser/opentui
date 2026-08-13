#pragma once

#include <sys/cdefs.h>

// Zig 0.16 translate-c rejects Bionic's nullable fixed-size array parameter.
#undef _Nullable
#define _Nullable
#include_next <sys/time.h>
