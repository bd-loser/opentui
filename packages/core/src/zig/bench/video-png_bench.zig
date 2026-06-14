const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const video = @import("../video.zig");

pub const benchName = "Video PNG";

const Scenario = struct {
    name: []const u8,
    level: u32,
    predictor: u32,
    color_mode: u32,
    bits: ?[3]u3,
};

const scenarios = [_]Scenario{
    .{ .name = "RGB888 level 1 up", .level = 1, .predictor = 2, .color_mode = 1, .bits = null },
    .{ .name = "RGB888 level 1 paeth", .level = 1, .predictor = 4, .color_mode = 1, .bits = null },
    .{ .name = "RGB888 level 1 mixed", .level = 1, .predictor = 5, .color_mode = 1, .bits = null },
    .{ .name = "RGB888 level 2 up", .level = 2, .predictor = 2, .color_mode = 1, .bits = null },
    .{ .name = "RGB777 level 1 up", .level = 1, .predictor = 2, .color_mode = 6, .bits = .{ 7, 7, 7 } },
    .{ .name = "RGB777 level 1 paeth", .level = 1, .predictor = 4, .color_mode = 6, .bits = .{ 7, 7, 7 } },
    .{ .name = "RGB666 level 1 up", .level = 1, .predictor = 2, .color_mode = 5, .bits = .{ 6, 6, 6 } },
    .{ .name = "RGB666 level 1 paeth", .level = 1, .predictor = 4, .color_mode = 5, .bits = .{ 6, 6, 6 } },
    .{ .name = "RGB666 level 1 mixed", .level = 1, .predictor = 5, .color_mode = 5, .bits = .{ 6, 6, 6 } },
    .{ .name = "RGB666 level 2 up", .level = 2, .predictor = 2, .color_mode = 5, .bits = .{ 6, 6, 6 } },
    .{ .name = "RGB444 level 2 up", .level = 2, .predictor = 2, .color_mode = 2, .bits = .{ 4, 4, 4 } },
    .{ .name = "RGB444 level 1 up", .level = 1, .predictor = 2, .color_mode = 2, .bits = .{ 4, 4, 4 } },
    .{ .name = "RGB343 level 2 none", .level = 2, .predictor = 0, .color_mode = 0, .bits = .{ 3, 4, 3 } },
    .{ .name = "PAL332 level 1 paeth", .level = 1, .predictor = 4, .color_mode = 4, .bits = .{ 3, 3, 2 } },
};

fn quantize(value: u8, bits: u3) u8 {
    const shift: u3 = @intCast(8 - @as(u4, bits));
    const levels = (@as(u32, 1) << bits) - 1;
    return @intCast(((@as(u32, value >> shift) * 255) + levels / 2) / levels);
}

pub fn run(allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .{};
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const decoder = try video.Video.open(allocator, "../../../examples/src/assets/dragon.mp4");
        defer decoder.deinit();
        try decoder.configureOutput(765, 1168, false);
        try decoder.configurePng(scenario.level, scenario.predictor, scenario.color_mode);
        try decoder.seek(0);

        var stats: bench_utils.BenchStats = .{};
        var png_total: usize = 0;
        var png_min: usize = std.math.maxInt(usize);
        var png_max: usize = 0;
        var squared_error: u64 = 0;
        var sample_count: u64 = 0;
        const frame_count = 24;
        for (0..frame_count) |index| {
            var timer = try std.time.Timer.start();
            _ = try decoder.update(@intCast(index * 1_000_000 / 24));
            stats.record(timer.read());
            const png_len = decoder.current_image.?.encoded_png.?.len;
            png_total += png_len;
            png_min = @min(png_min, png_len);
            png_max = @max(png_max, png_len);
            if (scenario.bits) |bits| {
                const pixels = decoder.current_image.?.pixels;
                var pixel: usize = 0;
                while (pixel < pixels.len) : (pixel += 4) {
                    inline for (0..3) |channel| {
                        const delta = @as(i32, pixels[pixel + channel]) - quantize(pixels[pixel + channel], bits[channel]);
                        squared_error += @intCast(delta * delta);
                        sample_count += 1;
                    }
                }
            }
        }
        const mem_stats = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 3);
            values[0] = .{ .name = "PNG avg", .bytes = png_total / frame_count };
            values[1] = .{ .name = "PNG min", .bytes = png_min };
            values[2] = .{ .name = "PNG max", .bytes = png_max };
            break :blk values;
        } else null;
        const result_name = if (sample_count == 0)
            try std.fmt.allocPrint(allocator, "{s} lossless", .{scenario.name})
        else blk: {
            const mse = @as(f64, @floatFromInt(squared_error)) / @as(f64, @floatFromInt(sample_count));
            const psnr = 10.0 * @log10(65025.0 / mse);
            break :blk try std.fmt.allocPrint(allocator, "{s} PSNR {d:.2} dB", .{ scenario.name, psnr });
        };
        try results.append(allocator, .{
            .name = result_name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = stats.count,
            .mem_stats = mem_stats,
        });
    }
    return results.toOwnedSlice(allocator);
}
