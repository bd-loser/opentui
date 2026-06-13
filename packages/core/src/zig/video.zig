const std = @import("std");
const image = @import("image.zig");

const Allocator = std.mem.Allocator;

const Decoder = opaque {};

pub const Status = enum(u32) {
    ok = 0,
    invalid_handle = 1,
    invalid_argument = 2,
    open_failed = 3,
    decode_failed = 4,
    seek_failed = 5,
    out_of_memory = 6,
    no_frame = 7,
};

pub const Info = extern struct {
    duration_us: i64 = 0,
    width: u32 = 0,
    height: u32 = 0,
    fps_num: u32 = 0,
    fps_den: u32 = 1,
    has_audio: u32 = 0,
    audio_sample_rate: u32 = 0,
    audio_channels: u32 = 0,
};

pub const State = extern struct {
    current_time_us: i64 = 0,
    frame_pts_us: i64 = -1,
    frame_serial: u64 = 0,
    has_frame: u32 = 0,
    ended: u32 = 0,
};

extern fn ot_video_open(path: [*:0]const u8, out_decoder: *?*Decoder, out_info: *Info) c_int;
extern fn ot_video_close(decoder: *?*Decoder) void;
extern fn ot_video_seek(decoder: *Decoder, target_us: i64) c_int;
extern fn ot_video_set_output_size(decoder: *Decoder, width: u32, height: u32, cover: u32) c_int;
extern fn ot_video_decode_frame(
    decoder: *Decoder,
    target_us: i64,
    out_rgba: *?[*]const u8,
    out_width: *u32,
    out_height: *u32,
    out_stride: *u32,
    out_pts_us: *i64,
    out_serial: *u64,
) c_int;
extern fn ot_video_read_audio(decoder: *Decoder, out_samples: ?[*]f32, capacity_frames: u32, out_frames: *u32) c_int;
extern fn ot_video_last_error(decoder: *const Decoder) [*:0]const u8;

pub const Video = struct {
    allocator: Allocator,
    decoder: *Decoder,
    info: Info,
    state: State = .{},
    current_image: ?*image.Image = null,
    output_width: u32,
    output_height: u32,
    output_cover: bool = false,

    pub fn open(allocator: Allocator, path: []const u8) !*Video {
        if (path.len == 0 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidArgument;
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);
        var decoder: ?*Decoder = null;
        var info = Info{};
        if (ot_video_open(path_z.ptr, &decoder, &info) != 0 or decoder == null) return error.OpenFailed;
        errdefer ot_video_close(&decoder);
        const video = try allocator.create(Video);
        video.* = .{
            .allocator = allocator,
            .decoder = decoder.?,
            .info = info,
            .output_width = info.width,
            .output_height = info.height,
        };
        return video;
    }

    pub fn deinit(self: *Video) void {
        if (self.current_image) |value| value.deinit();
        var decoder: ?*Decoder = self.decoder;
        ot_video_close(&decoder);
        self.allocator.destroy(self);
    }

    pub fn configureOutput(self: *Video, width: u32, height: u32, cover: bool) !void {
        if (width == 0 or height == 0) return error.InvalidArgument;
        if (width == self.output_width and height == self.output_height and cover == self.output_cover) return;
        if (ot_video_set_output_size(self.decoder, width, height, @intFromBool(cover)) != 0) return error.DecodeFailed;
        self.output_width = width;
        self.output_height = height;
        self.output_cover = cover;
        if (ot_video_seek(self.decoder, self.state.current_time_us) != 0) return error.SeekFailed;
        if (self.current_image) |value| value.deinit();
        self.current_image = null;
        self.state.frame_serial = 0;
        self.state.frame_pts_us = -1;
        self.state.has_frame = 0;
    }

    pub fn seek(self: *Video, target_us: i64) !void {
        if (target_us < 0) return error.InvalidArgument;
        if (ot_video_seek(self.decoder, target_us) != 0) return error.SeekFailed;
        self.state.current_time_us = target_us;
        self.state.frame_pts_us = -1;
        self.state.ended = 0;
        self.state.frame_serial = 0;
        self.state.has_frame = 0;
        if (self.current_image) |value| value.deinit();
        self.current_image = null;
    }

    pub fn update(self: *Video, target_us: i64) !bool {
        if (target_us < 0) return error.InvalidArgument;
        var pixels: ?[*]const u8 = null;
        var width: u32 = 0;
        var height: u32 = 0;
        var stride: u32 = 0;
        var pts_us: i64 = -1;
        var serial: u64 = 0;
        const result = ot_video_decode_frame(self.decoder, target_us, &pixels, &width, &height, &stride, &pts_us, &serial);
        self.state.current_time_us = target_us;
        if (result == 1) {
            self.state.ended = 1;
            return false;
        }
        if (result != 0 or pixels == null) return error.DecodeFailed;
        self.state.ended = 0;
        if (serial == self.state.frame_serial and self.current_image != null) return false;
        const required = @as(usize, stride) * height;
        const next = try image.createFromRgba(self.allocator, pixels.?[0..required], width, height, stride);
        if (self.current_image) |previous| previous.deinit();
        self.current_image = next;
        self.state.frame_pts_us = pts_us;
        self.state.frame_serial = serial;
        self.state.has_frame = 1;
        return true;
    }

    pub fn getFrame(self: *Video) ?*image.Image {
        const value = self.current_image orelse return null;
        value.retain();
        return value;
    }

    pub fn readAudio(self: *Video, samples: []f32, capacity_frames: u32) !u32 {
        if (self.info.has_audio == 0) return 0;
        const required = @as(usize, capacity_frames) * self.info.audio_channels;
        if (samples.len < required) return error.InvalidArgument;
        var frames: u32 = 0;
        if (ot_video_read_audio(self.decoder, if (samples.len == 0) null else samples.ptr, capacity_frames, &frames) < 0) {
            return error.DecodeFailed;
        }
        return frames;
    }

    pub fn lastError(self: *const Video) []const u8 {
        return std.mem.span(ot_video_last_error(self.decoder));
    }
};

pub fn statusFromError(err: anyerror) Status {
    return switch (err) {
        error.InvalidArgument => .invalid_argument,
        error.OpenFailed => .open_failed,
        error.SeekFailed => .seek_failed,
        error.OutOfMemory => .out_of_memory,
        else => .decode_failed,
    };
}
