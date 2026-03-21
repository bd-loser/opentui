const std = @import("std");
const testing = std.testing;
const raw = @import("../file-lock.zig");

fn lockPath(tmp: *std.testing.TmpDir) ![]u8 {
    const dir_path = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(dir_path);

    return std.fs.path.join(testing.allocator, &[_][]const u8{ dir_path, "shared.lock" });
}

test "FileLock create, tryAcquire, release, and re-acquire work" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const lock = try raw.FileLock.create(testing.allocator, file_path, true, true);
    defer lock.destroy();

    try testing.expect(try lock.tryAcquire());
    lock.release();
    try testing.expect(try lock.tryAcquire());
}

test "FileLock createResult rejects relative paths with invalid_path" {
    const result = raw.createResult(testing.allocator, "shared.lock", true, true);

    try testing.expectEqual(@as(?*raw.FileLock, null), result.ptr);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.invalid_path)), result.status);
}

test "FileLock null pointer returns invalid_handle" {
    try testing.expectEqual(raw.Status.invalid_handle, raw.tryAcquire(null));
    try testing.expectEqual(raw.Status.invalid_handle, raw.release(null));
    try testing.expectEqual(raw.Status.invalid_handle, raw.destroy(null));
}

test "FileLock destroy releases the lock for a new pointer" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const first = try raw.FileLock.createAndTryAcquire(testing.allocator, file_path, true, true);

    try testing.expect(first != null);
    try testing.expectEqual(raw.Status.ok, raw.destroy(first));

    const second = try raw.FileLock.createAndTryAcquire(testing.allocator, file_path, true, true);
    defer if (second) |lock| lock.destroy();

    try testing.expect(second != null);
}

test "FileLock createAndTryAcquire returns busy without leaking a pointer" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const first = raw.createAndTryAcquireResult(testing.allocator, file_path, true, true);
    defer if (first.ptr) |lock| lock.destroy();

    try testing.expect(first.ptr != null);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), first.status);

    const second = raw.createAndTryAcquireResult(testing.allocator, file_path, true, true);

    try testing.expectEqual(@as(?*raw.FileLock, null), second.ptr);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.busy)), second.status);
}

test "FileLock repeated create tryAcquire release destroy cycles complete cleanly" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    for (0..32) |_| {
        const lock = try raw.FileLock.create(testing.allocator, file_path, true, true);

        try testing.expectEqual(raw.Status.ok, raw.tryAcquire(lock));
        try testing.expectEqual(raw.Status.ok, raw.release(lock));
        try testing.expectEqual(raw.Status.ok, raw.destroy(lock));
    }
}
