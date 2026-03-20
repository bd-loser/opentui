const std = @import("std");
const testing = std.testing;
const raw = @import("../file-lock.zig");

fn lockPath(tmp: *std.testing.TmpDir) ![]u8 {
    const dir_path = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(dir_path);

    return std.fs.path.join(testing.allocator, &[_][]const u8{ dir_path, "shared.lock" });
}

test "FileLock acquires, releases, and re-acquires an exclusive lock" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    const lock = try raw.FileLock.create(testing.allocator, file_path);
    defer lock.destroy();

    try lock.acquire();
    lock.release();

    try testing.expect(try lock.tryAcquire());
}

test "Registry rejects relative paths with an explicit status" {
    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    var msg: [128]u8 = undefined;
    const id = registry.create("shared.lock", msg[0..].ptr, msg.len);

    try testing.expectEqual(@as(u64, 0), id);
    try testing.expect(msg[0] != 0);
}

test "Registry returns invalid_handle for unknown handles" {
    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    var msg: [128]u8 = undefined;

    try testing.expectEqual(raw.Status.invalid_handle, registry.acquire(999, msg[0..].ptr, msg.len));
    try testing.expect(msg[0] != 0);

    try testing.expectEqual(raw.Status.invalid_handle, registry.tryAcquire(999, msg[0..].ptr, msg.len));
    try testing.expect(msg[0] != 0);

    try testing.expectEqual(raw.Status.invalid_handle, registry.release(999, msg[0..].ptr, msg.len));
    try testing.expect(msg[0] != 0);

    try testing.expectEqual(raw.Status.invalid_handle, registry.destroy(999, msg[0..].ptr, msg.len));
    try testing.expect(msg[0] != 0);
}

test "Registry destroy removes the handle" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    var registry = raw.Registry.init(testing.allocator);
    defer registry.deinit();

    const file_path = try lockPath(&tmp);
    defer testing.allocator.free(file_path);

    var msg: [128]u8 = undefined;
    const id = registry.create(file_path, msg[0..].ptr, msg.len);

    try testing.expect(id != 0);
    try testing.expectEqual(raw.Status.ok, registry.destroy(id, msg[0..].ptr, msg.len));
    try testing.expectEqual(raw.Status.invalid_handle, registry.acquire(id, msg[0..].ptr, msg.len));
}
