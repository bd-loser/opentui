const std = @import("std");
const audio = @import("../audio.zig");
const bench_utils = @import("../bench-utils.zig");
const video = @import("../video.zig");

pub const benchName = "Video Audio";
const asset = "../../../examples/src/assets/dragon.mp4";

fn appendResult(
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    name: []const u8,
    stats: bench_utils.BenchStats,
    mem_stats: ?[]const bench_utils.MemStat,
) !void {
    try results.append(allocator, .{
        .name = name,
        .min_ns = stats.min_ns,
        .avg_ns = stats.avg(),
        .max_ns = stats.max_ns,
        .total_ns = stats.total_ns,
        .iterations = stats.count,
        .mem_stats = mem_stats,
    });
}

pub fn run(allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .{};

    if (bench_utils.matchesBenchFilter("Open native video with owned audio", bench_filter)) {
        var stats: bench_utils.BenchStats = .{};
        for (0..10) |_| {
            var timer = try std.time.Timer.start();
            const value = try video.Video.open(allocator, asset);
            stats.record(timer.read());
            value.deinit();
        }
        try appendResult(allocator, &results, "Open native video with owned audio", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Create owned native audio engine", bench_filter)) {
        var stats: bench_utils.BenchStats = .{};
        for (0..100) |_| {
            var timer = try std.time.Timer.start();
            const engine = audio.create(allocator, &.{}) orelse return error.OutOfMemory;
            try std.testing.expectEqual(audio.Status.ok, audio.enablePcmStream(engine, true, 24_000, 2));
            stats.record(timer.read());
            audio.destroy(engine);
        }
        try appendResult(allocator, &results, "Create owned native audio engine", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Native AAC refill 4096 frames", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        try std.testing.expectEqual(audio.Status.ok, audio.startMixer(value.audio_engine.?));
        var stats: bench_utils.BenchStats = .{};
        var output: [8192]f32 = undefined;
        for (0..48) |_| {
            var timer = try std.time.Timer.start();
            const frames = try value.refillAudio(4096);
            stats.record(timer.read());
            if (frames == 0) break;
            try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, frames, 2));
        }
        try appendResult(allocator, &results, "Native AAC refill 4096 frames", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Incremental startup update", bench_filter)) {
        var stats: bench_utils.BenchStats = .{};
        var queued: usize = 0;
        for (0..10) |_| {
            const value = try video.Video.open(allocator, asset);
            defer value.deinit();
            value.setAudioOffline(true);
            value.play();
            for (0..3) |index| {
                var timer = try std.time.Timer.start();
                _ = try value.update(@intCast(index * 33_333));
                stats.record(timer.read());
            }
            queued = value.getState().audio_queued_frames;
        }
        const mem_stats = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Queued PCM", .bytes = queued * 2 * @sizeOf(f32) };
            break :blk values;
        } else null;
        try appendResult(allocator, &results, "Incremental startup update", stats, mem_stats);
    }

    if (bench_utils.matchesBenchFilter("Steady native audio video update", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        value.setAudioOffline(true);
        value.play();
        for (0..3) |index| _ = try value.update(@intCast(index * 33_333));
        var output: [3200]f32 = undefined;
        var stats: bench_utils.BenchStats = .{};
        for (3..48) |index| {
            try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, 1600, 2));
            var timer = try std.time.Timer.start();
            _ = try value.update(@intCast(index * 33_333));
            stats.record(timer.read());
        }
        try appendResult(allocator, &results, "Steady native audio video update", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Steady prepared video frame", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        var stats: bench_utils.BenchStats = .{};
        for (1..48) |index| {
            var timer = try std.time.Timer.start();
            _ = try value.prepare(@intCast(index * 33_333));
            stats.record(timer.read());
        }
        try appendResult(allocator, &results, "Steady prepared video frame", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Seek and incremental audio restart", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        value.setAudioOffline(true);
        value.play();
        for (0..3) |index| _ = try value.update(@intCast(index * 33_333));
        var stats: bench_utils.BenchStats = .{};
        for ([_]i64{ 125_000, 1_375_000, 3_250_000, 5_125_000 }) |target| {
            var timer = try std.time.Timer.start();
            try value.seek(target);
            for (0..3) |_| _ = try value.update(target);
            stats.record(timer.read());
        }
        try appendResult(allocator, &results, "Seek and incremental audio restart", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Native seek command only", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        var stats: bench_utils.BenchStats = .{};
        for ([_]i64{ 125_000, 1_375_000, 3_250_000, 5_125_000 }) |target| {
            var timer = try std.time.Timer.start();
            try value.seek(target);
            stats.record(timer.read());
        }
        try appendResult(allocator, &results, "Native seek command only", stats, null);
    }

    if (bench_utils.matchesBenchFilter("Underrun recovery updates", bench_filter)) {
        const value = try video.Video.open(allocator, asset);
        defer value.deinit();
        value.setAudioOffline(true);
        value.play();
        for (0..3) |index| _ = try value.update(@intCast(index * 33_333));
        const queued = value.getState().audio_queued_frames;
        const output = try allocator.alloc(f32, @as(usize, queued + 1600) * 2);
        defer allocator.free(output);
        try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, output.ptr, queued + 1600, 2));
        var stats: bench_utils.BenchStats = .{};
        for (0..3) |index| {
            var timer = try std.time.Timer.start();
            _ = try value.update(@intCast(1_000_000 + index * 33_333));
            stats.record(timer.read());
        }
        try appendResult(allocator, &results, "Underrun recovery updates", stats, null);
    }

    return results.toOwnedSlice(allocator);
}
