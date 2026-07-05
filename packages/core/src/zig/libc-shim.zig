// libc-shim.zig — Provides extern "c" declarations that std.heap/std.c need.
// Used when link_libc=false to avoid -lc -lm -ldl → NEEDED: libc.so → TLS crash.
// The symbols resolve from the already-loaded Bionic libc at dlopen time.

pub extern "c" fn malloc(size: usize) ?*anyopaque;
pub extern "c" fn free(ptr: ?*anyopaque) void;
pub extern "c" fn calloc(nmemb: usize, size: usize) ?*anyopaque;
pub extern "c" fn realloc(ptr: ?*anyopaque, size: usize) ?*anyopaque;
pub extern "c" fn posix_memalign(memptr: *?*anyopaque, alignment: usize, size: usize) c_int;
pub extern "c" fn abort() noreturn;
pub extern "c" fn exit(code: c_int) noreturn;
