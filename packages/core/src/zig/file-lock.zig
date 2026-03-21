const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const is_windows = builtin.os.tag == .windows;
const windows = std.os.windows;
const posix = std.posix;

const lock_range_off: windows.LARGE_INTEGER = 0;
const lock_range_len: windows.LARGE_INTEGER = 1;

pub const Status = enum(i32) {
    ok = 0,
    busy = 1,
    invalid_path = 2,
    access_denied = 3,
    file_not_found = 4,
    locks_not_supported = 5,
    system_resources = 6,
    out_of_memory = 7,
    unexpected = 8,
    closing = 9,
};

pub const FileLock = struct {
    allocator: Allocator,
    file: std.fs.File,
    acquired: bool,

    pub fn create(allocator: Allocator, path: []const u8, create_if_missing: bool, create_parent_path: bool) !*FileLock {
        const self = try allocator.create(FileLock);
        errdefer allocator.destroy(self);

        self.* = .{
            .allocator = allocator,
            .file = try open(path, create_if_missing, create_parent_path),
            .acquired = false,
        };
        return self;
    }

    pub fn createAndTryAcquire(allocator: Allocator, path: []const u8, create_if_missing: bool, create_parent_path: bool) !?*FileLock {
        const self = try create(allocator, path, create_if_missing, create_parent_path);
        errdefer self.destroy();

        if (!(try self.tryAcquire())) {
            self.destroy();
            return null;
        }

        return self;
    }

    pub fn destroy(self: *FileLock) void {
        self.release();
        self.file.close();
        self.allocator.destroy(self);
    }

    pub fn tryAcquire(self: *FileLock) !bool {
        if (self.acquired) return true;

        const acquired = try tryLockExclusive(self.file);
        self.acquired = acquired;
        return acquired;
    }

    pub fn release(self: *FileLock) void {
        if (!self.acquired) return;

        self.file.unlock();
        self.acquired = false;
    }
};

pub fn statusFromError(err: anyerror) Status {
    return switch (err) {
        error.AccessDenied,
        error.PermissionDenied,
        => .access_denied,
        error.EmptyPath,
        error.RelativePath,
        error.BadPathName,
        error.NameTooLong,
        => .invalid_path,
        error.FileNotFound,
        error.PathNotFound,
        error.NotDir,
        => .file_not_found,
        error.FileLocksNotSupported => .locks_not_supported,
        error.OutOfMemory => .out_of_memory,
        error.SystemResources => .system_resources,
        else => .unexpected,
    };
}

fn tryLockExclusive(file: std.fs.File) !bool {
    if (is_windows) {
        var io_status_block: windows.IO_STATUS_BLOCK = undefined;
        windows.LockFile(
            file.handle,
            null,
            null,
            null,
            &io_status_block,
            &lock_range_off,
            &lock_range_len,
            null,
            windows.TRUE,
            windows.TRUE,
        ) catch |err| switch (err) {
            error.WouldBlock => return false,
            else => |e| return e,
        };

        return true;
    }

    posix.flock(file.handle, posix.LOCK.EX | posix.LOCK.NB) catch |err| switch (err) {
        error.WouldBlock => return false,
        else => |e| return e,
    };

    return true;
}

fn open(path: []const u8, create_if_missing: bool, create_parent_path: bool) !std.fs.File {
    if (path.len == 0) return error.EmptyPath;
    if (!std.fs.path.isAbsolute(path)) return error.RelativePath;

    if (create_parent_path) {
        const parent = std.fs.path.dirname(path) orelse return error.BadPathName;
        try makePathAbsolute(parent);
    }

    if (create_if_missing) {
        return std.fs.createFileAbsolute(path, .{ .read = true, .truncate = false }) catch |err| switch (err) {
            error.PathAlreadyExists => std.fs.openFileAbsolute(path, .{ .mode = .read_write }),
            else => err,
        };
    }

    return std.fs.openFileAbsolute(path, .{ .mode = .read_write });
}

fn makePathAbsolute(path: []const u8) !void {
    std.fs.makeDirAbsolute(path) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        error.FileNotFound => {
            const parent = std.fs.path.dirname(path) orelse return err;
            if (std.mem.eql(u8, parent, path)) return err;
            try makePathAbsolute(parent);
            try std.fs.makeDirAbsolute(path);
        },
        else => return err,
    };
}
