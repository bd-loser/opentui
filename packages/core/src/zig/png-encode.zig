const std = @import("std");

const Allocator = std.mem.Allocator;

extern fn ot_png_deflate_bound(input_len: usize) usize;
extern fn ot_png_deflate_chunk(
    input: [*]const u8,
    input_len: usize,
    level: u32,
    last: u32,
    output: [*]u8,
    output_cap: usize,
    output_len: *usize,
) c_int;
extern fn ot_png_adler32(adler: u32, data: [*]const u8, len: usize) u32;
extern fn ot_png_adler32_combine(first: u32, second: u32, second_len: usize) u32;

pub const Options = struct {
    // zlib compression level 0-9.
    level: u32 = 1,
    // PNG filter: 0 none, 1 sub, 2 up, 3 average, 4 paeth, 5 per-row heuristic.
    predictor: u32 = 2,
    // 1 = RGB888, 2..8 = bit-crushed RGB variants, 4 = 3-3-2 palette.
    color_mode: u32 = 1,
};

const png_signature = [_]u8{ 137, 80, 78, 71, 13, 10, 26, 10 };

fn quantizeChannel(value: u8, comptime bits: u3) u8 {
    const shift: u3 = @intCast(8 - @as(u4, bits));
    const levels: u32 = (@as(u32, 1) << bits) - 1;
    return @intCast(((@as(u32, value >> shift) * 255) + levels / 2) / levels);
}

fn quantizeRow(row: []const u8, output: []u8, width: u32, color_mode: u32) void {
    var x: usize = 0;
    while (x < width) : (x += 1) {
        const r = row[x * 4];
        const g = row[x * 4 + 1];
        const b = row[x * 4 + 2];
        if (color_mode == 4) {
            output[x] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6);
            continue;
        }
        const out = output[x * 3 ..][0..3];
        switch (color_mode) {
            1 => {
                out[0] = r;
                out[1] = g;
                out[2] = b;
            },
            5 => {
                out[0] = quantizeChannel(r, 6);
                out[1] = quantizeChannel(g, 6);
                out[2] = quantizeChannel(b, 6);
            },
            6 => {
                out[0] = quantizeChannel(r, 7);
                out[1] = quantizeChannel(g, 7);
                out[2] = quantizeChannel(b, 7);
            },
            7 => {
                out[0] = quantizeChannel(r, 5);
                out[1] = quantizeChannel(g, 5);
                out[2] = quantizeChannel(b, 5);
            },
            8 => {
                out[0] = quantizeChannel(r, 4);
                out[1] = quantizeChannel(g, 5);
                out[2] = quantizeChannel(b, 4);
            },
            2 => {
                out[0] = quantizeChannel(r, 4);
                out[1] = quantizeChannel(g, 4);
                out[2] = quantizeChannel(b, 4);
            },
            3 => {
                out[0] = quantizeChannel(r, 3);
                out[1] = quantizeChannel(g, 3);
                out[2] = quantizeChannel(b, 2);
            },
            else => {
                out[0] = quantizeChannel(r, 3);
                out[1] = @intCast(@as(u32, g >> 4) * 17);
                out[2] = quantizeChannel(b, 3);
            },
        }
    }
}

fn paeth(a: u8, b: u8, c: u8) u8 {
    const p = @as(i32, a) + @as(i32, b) - @as(i32, c);
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    if (pa <= pb and pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

fn applyFilter(filter: u8, current: []const u8, previous: ?[]const u8, bpp: usize, output: []u8) void {
    switch (filter) {
        0 => @memcpy(output, current),
        1 => for (current, 0..) |value, index| {
            const left = if (index >= bpp) current[index - bpp] else 0;
            output[index] = value -% left;
        },
        2 => for (current, 0..) |value, index| {
            const above = if (previous) |row| row[index] else 0;
            output[index] = value -% above;
        },
        3 => for (current, 0..) |value, index| {
            const left: u32 = if (index >= bpp) current[index - bpp] else 0;
            const above: u32 = if (previous) |row| row[index] else 0;
            output[index] = value -% @as(u8, @intCast((left + above) / 2));
        },
        else => for (current, 0..) |value, index| {
            const left = if (index >= bpp) current[index - bpp] else 0;
            const above = if (previous) |row| row[index] else 0;
            const diagonal = if (previous != null and index >= bpp) previous.?[index - bpp] else 0;
            output[index] = value -% paeth(left, above, diagonal);
        },
    }
}

fn filteredSum(bytes: []const u8) u64 {
    var sum: u64 = 0;
    for (bytes) |value| {
        const signed: i16 = if (value < 128) value else @as(i16, value) - 256;
        sum += @abs(signed);
    }
    return sum;
}

const ChunkTask = struct {
    raw: []u8,
    row_start: u32,
    row_count: u32,
    row_bytes: usize,
    bpp: usize,
    width: u32,
    color_mode: u32,
    predictor: u32,
    level: u32,
    last: bool,
    rgba: []const u8,
    rgba_stride: usize,
    scratch: []u8,
    deflated: []u8,
    deflated_len: usize = 0,
    adler: u32 = 1,
    failed: bool = false,

    fn run(self: *ChunkTask) void {
        const filter_scratch = self.scratch[0..self.row_bytes];
        const current_row = self.scratch[self.row_bytes .. self.row_bytes * 2];
        const previous_row = self.scratch[self.row_bytes * 2 .. self.row_bytes * 3];

        // The first row of a chunk references the previous chunk's last raw
        // row; requantizing it is cheap and keeps chunks independent.
        var have_previous = false;
        if (self.row_start > 0) {
            const source = self.rgba[(self.row_start - 1) * self.rgba_stride ..][0..self.rgba_stride];
            quantizeRow(source, previous_row, self.width, self.color_mode);
            have_previous = true;
        }

        var row: u32 = 0;
        while (row < self.row_count) : (row += 1) {
            const absolute = self.row_start + row;
            const source = self.rgba[absolute * self.rgba_stride ..][0..self.rgba_stride];
            quantizeRow(source, current_row, self.width, self.color_mode);
            const destination = self.raw[row * (self.row_bytes + 1) ..][0 .. self.row_bytes + 1];
            const previous: ?[]const u8 = if (have_previous) previous_row else null;
            if (self.predictor <= 4) {
                destination[0] = @intCast(self.predictor);
                applyFilter(@intCast(self.predictor), current_row, previous, self.bpp, destination[1..]);
            } else {
                // Heuristic: pick the filter with the smallest absolute sum.
                var best_filter: u8 = 0;
                var best_sum: u64 = std.math.maxInt(u64);
                var filter: u8 = 0;
                while (filter <= 4) : (filter += 1) {
                    applyFilter(filter, current_row, previous, self.bpp, filter_scratch);
                    const sum = filteredSum(filter_scratch);
                    if (sum < best_sum) {
                        best_sum = sum;
                        best_filter = filter;
                    }
                }
                destination[0] = best_filter;
                applyFilter(best_filter, current_row, previous, self.bpp, destination[1..]);
            }
            @memcpy(previous_row, current_row);
            have_previous = true;
        }

        const raw_len = self.row_count * (self.row_bytes + 1);
        self.adler = ot_png_adler32(1, self.raw.ptr, raw_len);
        var produced: usize = 0;
        if (ot_png_deflate_chunk(
            self.raw.ptr,
            raw_len,
            self.level,
            @intFromBool(self.last),
            self.deflated.ptr,
            self.deflated.len,
            &produced,
        ) != 0) {
            self.failed = true;
            return;
        }
        self.deflated_len = produced;
    }
};

fn writeChunk(list: *std.ArrayList(u8), allocator: Allocator, kind: *const [4]u8, payload: []const u8) !void {
    var header: [8]u8 = undefined;
    std.mem.writeInt(u32, header[0..4], @intCast(payload.len), .big);
    @memcpy(header[4..8], kind);
    try list.appendSlice(allocator, &header);
    try list.appendSlice(allocator, payload);
    var crc = std.hash.Crc32.init();
    crc.update(kind);
    crc.update(payload);
    var trailer: [4]u8 = undefined;
    std.mem.writeInt(u32, &trailer, crc.final(), .big);
    try list.appendSlice(allocator, &trailer);
}

// Encodes RGBA pixels as a PNG, parallelizing quantization, filtering, and
// deflate across the pool. Chunked raw-deflate segments concatenate into one
// valid zlib stream, so the output is an ordinary PNG at the configured
// compression level; only the block layout differs from a serial encoder.
pub fn encode(
    allocator: Allocator,
    pool: *std.Thread.Pool,
    rgba: []const u8,
    width: u32,
    height: u32,
    options: Options,
) ![]u8 {
    if (width == 0 or height == 0 or options.level > 9 or options.predictor > 5 or options.color_mode > 8) {
        return error.InvalidArgument;
    }
    const rgba_stride = @as(usize, width) * 4;
    if (rgba.len < rgba_stride * height) return error.InvalidArgument;
    const palette = options.color_mode == 4;
    const bpp: usize = if (palette) 1 else 3;
    const row_bytes = @as(usize, width) * bpp;

    const job_limit: u32 = @intCast(@min(pool.threads.len + 1, 16));
    const chunk_count: u32 = @max(1, @min(job_limit, height));
    const rows_per_chunk = (height + chunk_count - 1) / chunk_count;

    const tasks = try allocator.alloc(ChunkTask, chunk_count);
    defer allocator.free(tasks);
    var allocated: usize = 0;
    defer for (tasks[0..allocated]) |task| {
        allocator.free(task.raw);
        allocator.free(task.scratch);
        allocator.free(task.deflated);
    };

    var row_start: u32 = 0;
    for (tasks, 0..) |*task, index| {
        const row_count = @min(rows_per_chunk, height - row_start);
        const raw_len = @as(usize, row_count) * (row_bytes + 1);
        task.* = .{
            .raw = try allocator.alloc(u8, raw_len),
            .row_start = row_start,
            .row_count = row_count,
            .row_bytes = row_bytes,
            .bpp = bpp,
            .width = width,
            .color_mode = options.color_mode,
            .predictor = options.predictor,
            .level = options.level,
            .last = index == chunk_count - 1,
            .rgba = rgba,
            .rgba_stride = rgba_stride,
            .scratch = undefined,
            .deflated = undefined,
        };
        errdefer allocator.free(task.raw);
        task.scratch = try allocator.alloc(u8, row_bytes * 3);
        errdefer allocator.free(task.scratch);
        task.deflated = try allocator.alloc(u8, ot_png_deflate_bound(raw_len));
        allocated = index + 1;
        row_start += row_count;
    }

    var wait_group: std.Thread.WaitGroup = .{};
    for (tasks) |*task| pool.spawnWg(&wait_group, ChunkTask.run, .{task});
    pool.waitAndWork(&wait_group);

    var deflated_total: usize = 0;
    for (tasks) |*task| {
        if (task.failed) return error.EncodeFailed;
        deflated_total += task.deflated_len;
    }

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try output.ensureTotalCapacity(allocator, deflated_total + 1024);
    try output.appendSlice(allocator, &png_signature);

    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], width, .big);
    std.mem.writeInt(u32, ihdr[4..8], height, .big);
    ihdr[8] = 8;
    ihdr[9] = if (palette) 3 else 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    try writeChunk(&output, allocator, "IHDR", &ihdr);

    if (palette) {
        var plte: [256 * 3]u8 = undefined;
        for (0..256) |index| {
            const r: u32 = @intCast((index >> 5) & 7);
            const g: u32 = @intCast((index >> 2) & 7);
            const b: u32 = @intCast(index & 3);
            plte[index * 3] = @intCast((r * 255 + 3) / 7);
            plte[index * 3 + 1] = @intCast((g * 255 + 3) / 7);
            plte[index * 3 + 2] = @intCast((b * 255 + 1) / 3);
        }
        try writeChunk(&output, allocator, "PLTE", &plte);
    }

    // First IDAT carries the zlib header; the last carries the combined
    // Adler-32 of all raw bytes.
    var adler: u32 = 1;
    for (tasks, 0..) |*task, index| {
        adler = ot_png_adler32_combine(adler, task.adler, @as(usize, task.row_count) * (row_bytes + 1));
        const zlib_header: []const u8 = if (index == 0) &[_]u8{ 0x78, 0x01 } else &[_]u8{};
        var trailer: [4]u8 = undefined;
        const with_trailer = index == tasks.len - 1;
        if (with_trailer) std.mem.writeInt(u32, &trailer, adler, .big);
        const payload_len = zlib_header.len + task.deflated_len + @as(usize, if (with_trailer) 4 else 0);

        var header: [8]u8 = undefined;
        std.mem.writeInt(u32, header[0..4], @intCast(payload_len), .big);
        @memcpy(header[4..8], "IDAT");
        try output.appendSlice(allocator, &header);
        var crc = std.hash.Crc32.init();
        crc.update("IDAT");
        try output.appendSlice(allocator, zlib_header);
        crc.update(zlib_header);
        try output.appendSlice(allocator, task.deflated[0..task.deflated_len]);
        crc.update(task.deflated[0..task.deflated_len]);
        if (with_trailer) {
            try output.appendSlice(allocator, &trailer);
            crc.update(&trailer);
        }
        var crc_bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &crc_bytes, crc.final(), .big);
        try output.appendSlice(allocator, &crc_bytes);
    }

    try writeChunk(&output, allocator, "IEND", &[_]u8{});
    return output.toOwnedSlice(allocator);
}
