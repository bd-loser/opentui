const std = @import("std");
const testing = std.testing;
const raw = @import("../file-lock.zig");

test "FileLock acquires, releases, and re-acquires an exclusive lock" {
    const tmpdir = std.testing.tmpDir(.{});
    var tmp = tmpdir;
    defer tmp.cleanup();

    const dir_path = try tmp.dir.realpathAlloc(testing.allocator, ".");
    defer testing.allocator.free(dir_path);

    const file_path = try std.fs.path.join(testing.allocator, &[_][]const u8{ dir_path, "shared.lock" });
    defer testing.allocator.free(file_path);

    const lock = try raw.FileLock.create(testing.allocator, file_path);
    defer lock.destroy();

    try lock.acquire();
    lock.release();

    try testing.expect(try lock.tryAcquire());
}
