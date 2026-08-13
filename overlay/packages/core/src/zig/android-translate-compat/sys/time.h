#pragma once

#include <sys/cdefs.h>

// Zig 0.16 translate-c rejects Bionic's nullable fixed-size array parameter.
#undef _Nullable
#define _Nullable
#include "@ANDROIDTUI_SYS_TIME_HEADER@"
