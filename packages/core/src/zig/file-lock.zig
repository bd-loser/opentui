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
};

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

pub const Registry = struct {
    allocator: Allocator,
    map: std.AutoHashMap(u64, *Entry),
    mutex: std.Thread.Mutex = .{},
    next: u64 = 1,

    pub fn init(allocator: Allocator) Registry {
        return .{
            .allocator = allocator,
            .map = std.AutoHashMap(u64, *Entry).init(allocator),
        };
    }

    pub fn deinit(self: *Registry) void {
        self.mutex.lock();
        defer self.mutex.unlock();

        var values = self.map.valueIterator();
        while (values.next()) |entry| {
            entry.*.destroy();
        }
        self.map.deinit();
    }

    pub fn create(self: *Registry, path: []const u8, outPtr: [*]u8, outLen: usize) u64 {
        clearMessage(outPtr, outLen);

        const lock = FileLock.create(self.allocator, path) catch |err| {
            _ = writeStatus(outPtr, outLen, "create file lock", err);
            return 0;
        };
        errdefer lock.destroy();

        const entry = Entry.create(self.allocator, lock) catch |err| {
            _ = writeStatus(outPtr, outLen, "allocate file lock entry", err);
            return 0;
        };
        errdefer entry.destroy();

        self.mutex.lock();
        defer self.mutex.unlock();

        const id = self.nextHandle();
        self.map.put(id, entry) catch |err| {
            _ = writeStatus(outPtr, outLen, "register file lock", err);
            return 0;
        };

        return id;
    }

    pub fn acquire(self: *Registry, id: u64, outPtr: [*]u8, outLen: usize) Status {
        clearMessage(outPtr, outLen);

        const entry = self.retain(id, outPtr, outLen) orelse return .invalid_handle;
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        entry.lock.acquire() catch |err| {
            return writeStatus(outPtr, outLen, "acquire file lock", err);
        };

        return .ok;
    }

    pub fn tryAcquire(self: *Registry, id: u64, outPtr: [*]u8, outLen: usize) Status {
        clearMessage(outPtr, outLen);

        const entry = self.retain(id, outPtr, outLen) orelse return .invalid_handle;
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        const acquired = entry.lock.tryAcquire() catch |err| {
            return writeStatus(outPtr, outLen, "try-acquire file lock", err);
        };

        if (!acquired) return .busy;
        return .ok;
    }

    pub fn release(self: *Registry, id: u64, outPtr: [*]u8, outLen: usize) Status {
        clearMessage(outPtr, outLen);

        const entry = self.retain(id, outPtr, outLen) orelse return .invalid_handle;
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        entry.lock.release();
        return .ok;
    }

    pub fn destroy(self: *Registry, id: u64, outPtr: [*]u8, outLen: usize) Status {
        clearMessage(outPtr, outLen);

        self.mutex.lock();
        const item = self.map.fetchRemove(id);
        self.mutex.unlock();

        const entry = item orelse {
            writeMessage(outPtr, outLen, "unknown file lock handle");
            return .invalid_handle;
        };

        entry.value.state.lock();
        entry.value.closing = true;
        while (entry.value.refs != 0) {
            entry.value.ready.wait(&entry.value.state);
        }
        entry.value.state.unlock();

        entry.value.destroy();
        return .ok;
    }

    fn nextHandle(self: *Registry) u64 {
        while (self.next == 0 or self.map.contains(self.next)) {
            self.next +%= 1;
            if (self.next == 0) self.next = 1;
        }

        const id = self.next;
        self.next +%= 1;
        if (self.next == 0) self.next = 1;
        return id;
    }

    fn retain(self: *Registry, id: u64, outPtr: [*]u8, outLen: usize) ?*Entry {
        self.mutex.lock();
        defer self.mutex.unlock();

        const entry = self.map.get(id) orelse {
            writeMessage(outPtr, outLen, "unknown file lock handle");
            return null;
        };

        entry.state.lock();
        defer entry.state.unlock();

        if (entry.closing) {
            writeMessage(outPtr, outLen, "file lock is closing");
            return null;
        }

        entry.refs += 1;
        return entry;
    }

    fn releaseEntry(_: *Registry, entry: *Entry) void {
        entry.state.lock();
        defer entry.state.unlock();

        std.debug.assert(entry.refs > 0);
        entry.refs -= 1;
        if (entry.closing and entry.refs == 0) {
            entry.ready.signal();
        }
    }
};

const Entry = struct {
    allocator: Allocator,
    lock: *FileLock,
    refs: usize = 0,
    closing: bool = false,
    state: std.Thread.Mutex = .{},
    ready: std.Thread.Condition = .{},
    op: std.Thread.Mutex = .{},

    fn create(allocator: Allocator, lock: *FileLock) !*Entry {
        const self = try allocator.create(Entry);
        self.* = .{
            .allocator = allocator,
            .lock = lock,
        };
        return self;
    }

    fn destroy(self: *Entry) void {
        self.lock.destroy();
        self.allocator.destroy(self);
    }
};

pub fn clearMessage(outPtr: [*]u8, outLen: usize) void {
    if (outLen == 0) return;
    @memset(outPtr[0..outLen], 0);
}

pub fn writeMessage(outPtr: [*]u8, outLen: usize, msg: []const u8) void {
    if (outLen == 0) return;

    const buf = outPtr[0..outLen];
    @memset(buf, 0);

    if (buf.len == 1) return;

    const len = @min(buf.len - 1, msg.len);
    @memcpy(buf[0..len], msg[0..len]);
}

pub fn statusFromError(err: anyerror) Status {
    return switch (err) {
        error.AccessDenied,
        error.PermissionDenied,
        => .access_denied,
        error.EmptyPath,
        error.RelativePath,
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

pub fn writeStatus(outPtr: [*]u8, outLen: usize, action: []const u8, err: anyerror) Status {
    const status = statusFromError(err);
    writeError(outPtr, outLen, action, err);
    return status;
}

pub fn writeError(outPtr: [*]u8, outLen: usize, action: []const u8, err: anyerror) void {
    if (outLen == 0) return;

    const buf = outPtr[0..outLen];
    @memset(buf, 0);

    if (buf.len == 1) return;

    _ = std.fmt.bufPrint(buf[0 .. buf.len - 1], "{s} failed: {s}", .{ action, @errorName(err) }) catch {};
}

fn open(path: []const u8) !std.fs.File {
    if (path.len == 0) return error.EmptyPath;
    if (!std.fs.path.isAbsolute(path)) return error.RelativePath;

    return std.fs.openFileAbsolute(path, .{ .mode = .read_write }) catch |err| switch (err) {
        error.FileNotFound => std.fs.createFileAbsolute(path, .{ .read = true, .truncate = false }),
        else => err,
    };
}
