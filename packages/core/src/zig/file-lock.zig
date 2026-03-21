const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Status = enum(i32) {
    ok = 0,
    busy = 1,
    invalid_handle = 2,
    invalid_path = 3,
    access_denied = 4,
    file_not_found = 5,
    locks_not_supported = 6,
    system_resources = 7,
    out_of_memory = 8,
    unexpected = 9,
    closing = 10,
};

pub const CreateResult = extern struct {
    ptr: ?*FileLock,
    status: i32,
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

pub fn createResult(allocator: Allocator, path: []const u8, create_if_missing: bool, create_parent_path: bool) CreateResult {
    const lock = FileLock.create(allocator, path, create_if_missing, create_parent_path) catch |err| {
        return .{
            .ptr = null,
            .status = @intFromEnum(statusFromError(err)),
        };
    };

    return .{
        .ptr = lock,
        .status = @intFromEnum(Status.ok),
    };
}

pub fn createAndTryAcquireResult(allocator: Allocator, path: []const u8, create_if_missing: bool, create_parent_path: bool) CreateResult {
    const lock = FileLock.createAndTryAcquire(allocator, path, create_if_missing, create_parent_path) catch |err| {
        return .{
            .ptr = null,
            .status = @intFromEnum(statusFromError(err)),
        };
    };

    return .{
        .ptr = lock,
        .status = @intFromEnum(if (lock == null) Status.busy else Status.ok),
    };
}

pub fn destroy(lock: ?*FileLock) Status {
    const file_lock = lock orelse return .invalid_handle;
    file_lock.destroy();
    return .ok;
}

pub fn tryAcquire(lock: ?*FileLock) Status {
    const file_lock = lock orelse return .invalid_handle;

    const acquired = file_lock.tryAcquire() catch |err| {
        return statusFromError(err);
    };

    return if (acquired) .ok else .busy;
}

pub fn release(lock: ?*FileLock) Status {
    const file_lock = lock orelse return .invalid_handle;
    file_lock.release();
    return .ok;
}

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
