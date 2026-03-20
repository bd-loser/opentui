const std = @import("std");
const Allocator = std.mem.Allocator;

pub const FileLock = struct {
    allocator: Allocator,
    file: std.fs.File,
    acquired: bool,

    pub fn create(allocator: Allocator, path: []const u8) !*FileLock {
        const self = try allocator.create(FileLock);
        errdefer allocator.destroy(self);

        self.* = .{
            .allocator = allocator,
            .file = try open(path),
            .acquired = false,
        };
        return self;
    }

    pub fn destroy(self: *FileLock) void {
        self.release();
        self.file.close();
        self.allocator.destroy(self);
    }

    pub fn acquire(self: *FileLock) !void {
        if (self.acquired) return;
        try self.file.lock(.exclusive);
        self.acquired = true;
    }

    pub fn tryAcquire(self: *FileLock) !bool {
        if (self.acquired) return true;
        const acquired = try self.file.tryLock(.exclusive);
        self.acquired = acquired;
        return acquired;
    }

    pub fn release(self: *FileLock) void {
        if (!self.acquired) return;
        self.file.unlock();
        self.acquired = false;
    }
};

fn open(path: []const u8) !std.fs.File {
    return std.fs.openFileAbsolute(path, .{ .mode = .read_write }) catch |err| switch (err) {
        error.FileNotFound => std.fs.createFileAbsolute(path, .{ .read = true, .truncate = false }),
        else => err,
    };
}
