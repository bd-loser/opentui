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
    id: u64,
    status: i32,
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

    pub fn create(self: *Registry, path: []const u8) CreateResult {
        const lock = FileLock.create(self.allocator, path) catch |err| {
            return .{
                .id = 0,
                .status = @intFromEnum(statusFromError(err)),
            };
        };
        errdefer lock.destroy();

        const entry = Entry.create(self.allocator, lock) catch |err| {
            return .{
                .id = 0,
                .status = @intFromEnum(statusFromError(err)),
            };
        };
        errdefer entry.destroy();

        self.mutex.lock();
        defer self.mutex.unlock();

        const id = self.nextHandle();
        self.map.put(id, entry) catch |err| {
            return .{
                .id = 0,
                .status = @intFromEnum(statusFromError(err)),
            };
        };

        return .{
            .id = id,
            .status = @intFromEnum(Status.ok),
        };
    }

    pub fn acquire(self: *Registry, id: u64) Status {
        const entry = switch (self.retain(id)) {
            .entry => |entry| entry,
            .status => |status| return status,
        };
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        entry.lock.acquire() catch |err| {
            return statusFromError(err);
        };

        return .ok;
    }

    pub fn tryAcquire(self: *Registry, id: u64) Status {
        const entry = switch (self.retain(id)) {
            .entry => |entry| entry,
            .status => |status| return status,
        };
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        const acquired = entry.lock.tryAcquire() catch |err| {
            return statusFromError(err);
        };

        if (!acquired) return .busy;
        return .ok;
    }

    pub fn release(self: *Registry, id: u64) Status {
        const entry = switch (self.retain(id)) {
            .entry => |entry| entry,
            .status => |status| return status,
        };
        defer self.releaseEntry(entry);

        entry.op.lock();
        defer entry.op.unlock();

        entry.lock.release();
        return .ok;
    }

    pub fn destroy(self: *Registry, id: u64) Status {
        self.mutex.lock();
        const item = self.map.fetchRemove(id);
        self.mutex.unlock();

        const entry = item orelse return .invalid_handle;

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

    fn retain(self: *Registry, id: u64) union(enum) { entry: *Entry, status: Status } {
        self.mutex.lock();
        defer self.mutex.unlock();

        const entry = self.map.get(id) orelse return .{ .status = .invalid_handle };

        entry.state.lock();
        defer entry.state.unlock();

        if (entry.closing) {
            return .{ .status = .closing };
        }

        entry.refs += 1;
        return .{ .entry = entry };
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

fn open(path: []const u8) !std.fs.File {
    if (path.len == 0) return error.EmptyPath;
    if (!std.fs.path.isAbsolute(path)) return error.RelativePath;

    return std.fs.openFileAbsolute(path, .{ .mode = .read_write }) catch |err| switch (err) {
        error.FileNotFound => std.fs.createFileAbsolute(path, .{ .read = true, .truncate = false }),
        else => err,
    };
}
