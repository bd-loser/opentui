const std = @import("std");
const testing = std.testing;
const raw = @import("../file-lock.zig");
const ffi = @import("../lib.zig");

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

test "lib createFileLock rejects relative paths with invalid_path" {
    var result: ffi.ExternalFileLockCreateResult = undefined;
    ffi.createFileLock("shared.lock".ptr, "shared.lock".len, true, true, &result);

    try testing.expectEqual(@as(?*ffi.FileLock, null), result.ptr);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.invalid_path)), result.status);
}

test "lib destroyFileLock releases the lock for a new pointer" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    var first: ffi.ExternalFileLockCreateResult = undefined;
    ffi.createFileLockAndTryAcquire(file_path.ptr, file_path.len, true, true, &first);

    try testing.expect(first.ptr != null);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), first.status);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), ffi.destroyFileLock(first.ptr.?));

    var second: ffi.ExternalFileLockCreateResult = undefined;
    ffi.createFileLockAndTryAcquire(file_path.ptr, file_path.len, true, true, &second);
    defer if (second.ptr) |lock| lock.destroy();

    try testing.expect(second.ptr != null);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), second.status);
}

test "lib createFileLockAndTryAcquire returns busy without leaking a pointer" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    var first: ffi.ExternalFileLockCreateResult = undefined;
    ffi.createFileLockAndTryAcquire(file_path.ptr, file_path.len, true, true, &first);
    defer if (first.ptr) |lock| lock.destroy();

    try testing.expect(first.ptr != null);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), first.status);

    var second: ffi.ExternalFileLockCreateResult = undefined;
    ffi.createFileLockAndTryAcquire(file_path.ptr, file_path.len, true, true, &second);

    try testing.expectEqual(@as(?*ffi.FileLock, null), second.ptr);
    try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.busy)), second.status);
}

test "lib file lock wrappers complete repeated create tryAcquire release destroy cycles cleanly" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    for (0..32) |_| {
        var result: ffi.ExternalFileLockCreateResult = undefined;
        ffi.createFileLock(file_path.ptr, file_path.len, true, true, &result);

        try testing.expect(result.ptr != null);
        try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), result.status);
        try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), ffi.fileLockTryAcquire(result.ptr.?));
        try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), ffi.fileLockRelease(result.ptr.?));
        try testing.expectEqual(@as(i32, @intFromEnum(raw.Status.ok)), ffi.destroyFileLock(result.ptr.?));
    }
}
