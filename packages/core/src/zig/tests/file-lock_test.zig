const std = @import("std");
const testing = std.testing;
const raw = @import("../file-lock.zig");

fn lockPath(tmp: *std.testing.TmpDir) ![]u8 {
    const dir_path = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(dir_path);

    return std.fs.path.join(testing.allocator, &[_][]const u8{ dir_path, "shared.lock" });
}

test "FileLock tryAcquire acquires, releases, and re-acquires an exclusive lock" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const lock = try raw.FileLock.create(testing.allocator, file_path);
    defer lock.destroy();

    try testing.expect(try lock.tryAcquire());
    lock.release();

    try testing.expect(try lock.tryAcquire());
}

test "Registry rejects relative paths with an explicit status" {
    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    const result = registry.create("shared.lock");

    try testing.expectEqual(@as(u64, 0), result.id);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.invalid_path)), result.status);
}

test "Registry returns invalid_handle for unknown handles" {
    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    try testing.expectEqual(raw.Status.invalid_handle, registry.tryAcquire(999));
    try testing.expectEqual(raw.Status.invalid_handle, registry.release(999));
    try testing.expectEqual(raw.Status.invalid_handle, registry.destroy(999));
}

test "Registry destroy removes the handle" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const result = registry.create(file_path);

    try testing.expect(result.id != 0);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), result.status);
    try testing.expectEqual(raw.Status.ok, registry.destroy(result.id));
    try testing.expectEqual(raw.Status.invalid_handle, registry.tryAcquire(result.id));
}

test "Registry createAndTryAcquire returns busy without leaking a handle" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const first = registry.createAndTryAcquire(file_path);
    try testing.expect(first.id != 0);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), first.status);

    const second = registry.createAndTryAcquire(file_path);
    try testing.expectEqual(@as(u64, 0), second.id);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.busy)), second.status);

    try testing.expectEqual(raw.Status.ok, registry.destroy(first.id));

    const third = registry.createAndTryAcquire(file_path);
    try testing.expect(third.id != 0);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), third.status);
    try testing.expectEqual(raw.Status.ok, registry.destroy(third.id));
}

test "Registry repeated create tryAcquire release destroy cycles complete cleanly" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    for (0..32) |_| {
        const result = registry.create(file_path);

        try testing.expect(result.id != 0);
        try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), result.status);
        try testing.expectEqual(raw.Status.ok, registry.tryAcquire(result.id));
        try testing.expectEqual(raw.Status.ok, registry.release(result.id));
        try testing.expectEqual(raw.Status.ok, registry.destroy(result.id));
    }
}
