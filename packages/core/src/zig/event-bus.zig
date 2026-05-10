const std = @import("std");

var global_event_callback: ?*const fn (namePtr: [*]const u8, nameLen: u32, dataPtr: [*]const u8, dataLen: u32) callconv(.c) void = null;

pub fn setEventCallback(callback: ?*const fn (namePtr: [*]const u8, nameLen: u32, dataPtr: [*]const u8, dataLen: u32) callconv(.c) void) void {
    global_event_callback = callback;
}

pub fn emit(name: []const u8, data: []const u8) void {
    if (global_event_callback) |callback| {
        const name_len = std.math.cast(u32, name.len) orelse return;
        const data_len = std.math.cast(u32, data.len) orelse return;
        callback(name.ptr, name_len, data.ptr, data_len);
    }
}
