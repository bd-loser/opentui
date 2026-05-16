const std = @import("std");

pub const EventCallback = *const fn (namePtr: [*]const u8, nameLen: usize, dataPtr: [*]const u8, dataLen: usize) callconv(.c) void;

pub const EventSink = struct {
    callback: ?EventCallback,
};

var global_event_callback: ?EventCallback = null;

pub fn createEventSink(allocator: std.mem.Allocator, callback: ?EventCallback) !*EventSink {
    const sink = try allocator.create(EventSink);
    sink.* = .{ .callback = callback };
    return sink;
}

pub fn destroyEventSink(allocator: std.mem.Allocator, sink: *EventSink) void {
    sink.callback = null;
    allocator.destroy(sink);
}

pub fn setEventCallback(callback: ?EventCallback) void {
    global_event_callback = callback;
}

pub fn emit(sink: ?*EventSink, name: []const u8, data: []const u8) void {
    if (sink) |event_sink| {
        if (event_sink.callback) |callback| callback(name.ptr, name.len, data.ptr, data.len);
        return;
    }

    if (global_event_callback) |callback| {
        callback(name.ptr, name.len, data.ptr, data.len);
    }
}
