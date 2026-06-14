const std = @import("std");
const audio = @import("audio.zig");
const image = @import("image.zig");

const Allocator = std.mem.Allocator;

const Decoder = opaque {};
const audio_capacity_frames: u32 = 24_000;
const audio_decode_frames: u32 = 4096;
const audio_start_frames: u32 = 12_000;

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
    playing: u32 = 0,
    buffering: u32 = 0,
    audio_active: u32 = 0,
    audio_ended: u32 = 0,
    audio_failed: u32 = 0,
    audio_queued_frames: u32 = 0,
    audio_refill_time_us: u32 = 0,
    audio_consumed_frames: u64 = 0,
    audio_produced_frames: u64 = 0,
    audio_underruns: u64 = 0,
    audio_underrun_frames: u64 = 0,
};

extern fn ot_video_open(path: [*:0]const u8, out_decoder: *?*Decoder, out_info: *Info) c_int;
extern fn ot_video_close(decoder: *?*Decoder) void;
extern fn ot_video_seek(decoder: *Decoder, target_us: i64) c_int;
extern fn ot_video_seek_video(decoder: *Decoder, target_us: i64) c_int;
extern fn ot_video_set_output_size(decoder: *Decoder, width: u32, height: u32, cover: u32) c_int;
extern fn ot_video_set_png_options(decoder: *Decoder, compression_level: u32, predictor: u32, color_mode: u32) c_int;
extern fn ot_video_decode_frame(
    decoder: *Decoder,
    target_us: i64,
    out_rgba: *?[*]const u8,
    out_width: *u32,
    out_height: *u32,
    out_stride: *u32,
    out_pts_us: *i64,
    out_serial: *u64,
    out_png: *?[*]const u8,
    out_png_len: *u64,
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
    audio_engine: ?*audio.Engine = null,
    audio_buffer: ?[]f32 = null,
    audio_ended: bool = false,
    wants_playback: bool = false,
    audio_started: bool = false,
    audio_failed: bool = false,
    muted: bool = false,
    volume: f32 = 1,
    audio_base_us: i64 = 0,
    audio_consumed_origin: u64 = 0,
    last_audio_underruns: u64 = 0,
    audio_offline: bool = false,
    audio_start_thread: ?std.Thread = null,
    audio_device_status: std.atomic.Value(i32) = std.atomic.Value(i32).init(0),
    audio_produced_frames: u64 = 0,
    audio_gain_dirty: bool = true,

    pub fn open(allocator: Allocator, path: []const u8) !*Video {
        if (path.len == 0 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidArgument;
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);
        var decoder: ?*Decoder = null;
        var info = Info{};
        if (ot_video_open(path_z.ptr, &decoder, &info) != 0 or decoder == null) return error.OpenFailed;
        errdefer ot_video_close(&decoder);
        const video = try allocator.create(Video);
        errdefer allocator.destroy(video);
        video.* = .{
            .allocator = allocator,
            .decoder = decoder.?,
            .info = info,
            .output_width = info.width,
            .output_height = info.height,
        };
        if (info.has_audio != 0) {
            const engine = audio.create(allocator, &.{ .sample_rate = 48_000, .playback_channels = 2 }) orelse return error.OutOfMemory;
            errdefer audio.destroy(engine);
            if (audio.enablePcmStream(engine, true, audio_capacity_frames, 2) != audio.Status.ok) return error.OutOfMemory;
            video.audio_engine = engine;
            video.audio_buffer = try allocator.alloc(f32, audio_decode_frames * 2);
        }
        return video;
    }

    pub fn deinit(self: *Video) void {
        if (self.audio_start_thread) |thread| thread.join();
        if (self.audio_engine) |engine| audio.destroy(engine);
        if (self.audio_buffer) |buffer| self.allocator.free(buffer);
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
        if (ot_video_seek_video(self.decoder, self.state.current_time_us) != 0) return error.SeekFailed;
        if (self.current_image) |value| value.deinit();
        self.current_image = null;
        self.state.frame_serial = 0;
        self.state.frame_pts_us = -1;
        self.state.has_frame = 0;
    }

    pub fn configurePng(self: *Video, compression_level: u32, predictor: u32, color_mode: u32) !void {
        if (ot_video_set_png_options(self.decoder, compression_level, predictor, color_mode) != 0) return error.InvalidArgument;
        self.state.frame_serial = 0;
        self.state.frame_pts_us = -1;
        self.state.has_frame = 0;
        if (self.current_image) |value| value.deinit();
        self.current_image = null;
    }

    pub fn seek(self: *Video, target_us: i64) !void {
        if (target_us < 0) return error.InvalidArgument;
        const was_started = self.audio_started;
        if (was_started) audio.suspendMixer(self.audio_engine.?);
        if (ot_video_seek(self.decoder, target_us) != 0) {
            if (was_started) audio.resumeMixer(self.audio_engine.?);
            return error.SeekFailed;
        }
        if (self.audio_engine) |engine| {
            if (audio.enablePcmStream(engine, true, audio_capacity_frames, 2) != audio.Status.ok) return error.DecodeFailed;
        }
        self.audio_ended = false;
        self.audio_started = false;
        self.audio_failed = false;
        self.audio_base_us = target_us;
        self.audio_consumed_origin = 0;
        self.last_audio_underruns = 0;
        self.audio_produced_frames = 0;
        self.state.audio_refill_time_us = 0;
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
        const effective_target = try self.updateAudio(target_us);
        var pixels: ?[*]const u8 = null;
        var width: u32 = 0;
        var height: u32 = 0;
        var stride: u32 = 0;
        var pts_us: i64 = -1;
        var serial: u64 = 0;
        var png: ?[*]const u8 = null;
        var png_len: u64 = 0;
        const result = ot_video_decode_frame(
            self.decoder,
            effective_target,
            &pixels,
            &width,
            &height,
            &stride,
            &pts_us,
            &serial,
            &png,
            &png_len,
        );
        self.state.current_time_us = effective_target;
        if (result == 1) {
            self.state.ended = 1;
            return false;
        }
        if (result != 0 or pixels == null) return error.DecodeFailed;
        self.state.ended = 0;
        if (serial == self.state.frame_serial and self.current_image != null) return false;
        const required = @as(usize, stride) * height;
        const next = try image.createFromRgba(self.allocator, pixels.?[0..required], width, height, stride);
        errdefer next.deinit();
        if (png != null and png_len <= std.math.maxInt(usize)) {
            next.encoded_png = try self.allocator.dupe(u8, png.?[0..@intCast(png_len)]);
        }
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

    pub fn getState(self: *Video) State {
        if (self.audio_started) self.state.current_time_us = self.audioTimeUs();
        self.refreshAudioState(self.wants_playback and self.audio_engine != null and !self.audio_started and !self.audio_failed and !self.audio_ended);
        return self.state;
    }

    fn decodeAudio(self: *Video, samples: []f32, capacity_frames: u32) !u32 {
        if (self.info.has_audio == 0) return 0;
        const required = @as(usize, capacity_frames) * self.info.audio_channels;
        if (samples.len < required) return error.InvalidArgument;
        var frames: u32 = 0;
        if (ot_video_read_audio(self.decoder, if (samples.len == 0) null else samples.ptr, capacity_frames, &frames) < 0) {
            return error.DecodeFailed;
        }
        return frames;
    }

    pub fn readAudio(self: *Video, samples: []f32, capacity_frames: u32) !u32 {
        if (self.audio_engine != null) return error.InvalidArgument;
        return self.decodeAudio(samples, capacity_frames);
    }

    pub fn refillAudio(self: *Video, max_frames: u32) !u32 {
        const engine = self.audio_engine orelse return 0;
        const buffer = self.audio_buffer orelse return 0;
        if (self.audio_ended or max_frames == 0) return 0;
        const queued = audio.getPcmQueuedFrames(engine);
        const writable = audio_capacity_frames -| queued;
        const requested = @min(max_frames, @min(writable, audio_decode_frames));
        if (requested == 0) return 0;
        const decoded = try self.decodeAudio(buffer, requested);
        if (decoded == 0) {
            self.audio_ended = true;
            return 0;
        }
        var written: u32 = 0;
        if (audio.writePcm(engine, buffer.ptr, decoded, &written) != audio.Status.ok or written != decoded) {
            return error.DecodeFailed;
        }
        return written;
    }

    fn audioTimeUs(self: *Video) i64 {
        const engine = self.audio_engine orelse return self.audio_base_us;
        const consumed = audio.getPcmConsumedFrames(engine);
        return self.audio_base_us + @as(i64, @intCast((consumed -| self.audio_consumed_origin) * 1_000_000 / 48_000));
    }

    fn refreshAudioState(self: *Video, buffering: bool) void {
        const engine = self.audio_engine orelse {
            self.state.playing = @intFromBool(self.wants_playback);
            self.state.buffering = 0;
            self.state.audio_active = 0;
            self.state.audio_ended = @intFromBool(self.audio_ended);
            self.state.audio_failed = 0;
            self.state.audio_queued_frames = 0;
            self.state.audio_refill_time_us = 0;
            self.state.audio_consumed_frames = 0;
            self.state.audio_produced_frames = 0;
            self.state.audio_underruns = 0;
            self.state.audio_underrun_frames = 0;
            return;
        };
        self.state.playing = @intFromBool(self.wants_playback);
        self.state.buffering = @intFromBool(buffering);
        self.state.audio_active = @intFromBool(self.audio_started);
        self.state.audio_ended = @intFromBool(self.audio_ended);
        self.state.audio_failed = @intFromBool(self.audio_failed);
        self.state.audio_queued_frames = audio.getPcmQueuedFrames(engine);
        self.state.audio_consumed_frames = audio.getPcmConsumedFrames(engine);
        self.state.audio_produced_frames = self.audio_produced_frames;
        self.state.audio_underruns = audio.getPcmUnderrunEvents(engine);
        self.state.audio_underrun_frames = audio.getPcmUnderrunFrames(engine);
    }

    fn updateAudio(self: *Video, fallback_time_us: i64) !i64 {
        const engine = self.audio_engine orelse {
            self.refreshAudioState(false);
            return fallback_time_us;
        };
        const device_status = self.audio_device_status.load(.acquire);
        if (device_status != 0 and self.audio_start_thread != null) {
            self.audio_start_thread.?.join();
            self.audio_start_thread = null;
        }
        if (device_status < 0) self.audio_failed = true;
        if ((self.audio_offline or device_status > 0) and self.audio_gain_dirty) {
            if (audio.setMasterVolume(engine, if (self.muted) 0 else self.volume) != audio.Status.ok) self.audio_failed = true;
            self.audio_gain_dirty = false;
        }
        if (!self.wants_playback or self.audio_failed) {
            self.refreshAudioState(false);
            return fallback_time_us;
        }

        const underruns = audio.getPcmUnderrunEvents(engine);
        if (self.audio_started and underruns > self.last_audio_underruns) {
            self.audio_base_us = self.audioTimeUs();
            self.audio_consumed_origin = audio.getPcmConsumedFrames(engine);
            audio.suspendMixer(engine);
            self.audio_started = false;
        }
        self.last_audio_underruns = underruns;

        const refill_started = std.time.microTimestamp();
        const produced = try self.refillAudio(audio_decode_frames);
        self.audio_produced_frames += produced;
        self.state.audio_refill_time_us = @intCast(@min(std.time.microTimestamp() - refill_started, std.math.maxInt(u32)));
        const queued = audio.getPcmQueuedFrames(engine);
        const can_start = queued >= audio_start_frames or (self.audio_ended and queued > 0);
        if (!self.audio_started and can_start) {
            self.audio_consumed_origin = audio.getPcmConsumedFrames(engine);
            if (self.audio_offline) {
                if (audio.startMixer(engine) != audio.Status.ok) return error.DecodeFailed;
                self.audio_started = true;
            } else if (device_status > 0) {
                audio.resumeMixer(engine);
                self.audio_started = true;
            }
        }

        if (self.audio_started and self.audio_ended and audio.getPcmQueuedFrames(engine) == 0) {
            self.audio_base_us = self.audioTimeUs();
            self.audio_consumed_origin = audio.getPcmConsumedFrames(engine);
            audio.suspendMixer(engine);
            self.audio_started = false;
        }
        self.refreshAudioState(!self.audio_started and !self.audio_failed and !(self.audio_ended and queued == 0));
        return if (self.audio_started) self.audioTimeUs() else if (self.audio_failed or (self.audio_ended and queued == 0)) fallback_time_us else self.audio_base_us;
    }

    pub fn play(self: *Video) void {
        self.wants_playback = true;
        self.state.ended = 0;
        if (self.audio_engine != null and !self.audio_offline and !self.audio_failed and
            self.audio_device_status.load(.acquire) == 0 and self.audio_start_thread == null)
        {
            self.audio_start_thread = std.Thread.spawn(.{}, startAudioDevice, .{self}) catch null;
            if (self.audio_start_thread == null) self.audio_device_status.store(-1, .release);
        }
        if (self.audio_engine == null) self.state.playing = 1;
    }

    fn startAudioDevice(self: *Video) void {
        const status = audio.startSuspended(self.audio_engine.?, null);
        self.audio_device_status.store(if (status == audio.Status.ok) 1 else -1, .release);
    }

    pub fn pause(self: *Video) void {
        if (self.audio_started) {
            self.audio_base_us = self.audioTimeUs();
            self.audio_consumed_origin = audio.getPcmConsumedFrames(self.audio_engine.?);
            audio.suspendMixer(self.audio_engine.?);
            self.audio_started = false;
        } else {
            self.audio_base_us = self.state.current_time_us;
        }
        self.wants_playback = false;
        self.refreshAudioState(false);
    }

    pub fn setMuted(self: *Video, muted: bool) !void {
        self.muted = muted;
        self.audio_gain_dirty = true;
        if (self.audio_offline or self.audio_device_status.load(.acquire) > 0) if (self.audio_engine) |engine| {
            if (audio.setMasterVolume(engine, if (muted) 0 else self.volume) != audio.Status.ok) return error.DecodeFailed;
            self.audio_gain_dirty = false;
        };
    }

    pub fn setVolume(self: *Video, volume: f32) !void {
        if (!std.math.isFinite(volume) or volume < 0) return error.InvalidArgument;
        self.volume = volume;
        self.audio_gain_dirty = true;
        if (!self.muted) {
            if (self.audio_offline or self.audio_device_status.load(.acquire) > 0) if (self.audio_engine) |engine| {
                if (audio.setMasterVolume(engine, volume) != audio.Status.ok) return error.DecodeFailed;
                self.audio_gain_dirty = false;
            };
        }
    }

    pub fn setAudioOffline(self: *Video, offline: bool) void {
        self.audio_offline = offline;
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
