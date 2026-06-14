const std = @import("std");
const audio = @import("../audio.zig");
const image = @import("../image.zig");
const video = @import("../video.zig");

const asset = "../../../examples/src/assets/dragon.mp4";

fn openVideo() !*video.Video {
    std.fs.cwd().access(asset, .{}) catch return error.SkipZigTest;
    return video.Video.open(std.testing.allocator, asset);
}

fn quantize6(value: u8) u8 {
    return @intCast(((@as(u32, value >> 2) * 255) + 31) / 63);
}

test "video PNG defaults to lossless RGB888 and supports RGB666" {
    const value = try openVideo();
    defer value.deinit();
    try value.configureOutput(16, 16, false);
    _ = try value.update(0);

    const lossless = try image.decode(std.testing.allocator, value.current_image.?.encoded_png.?, .{});
    defer lossless.deinit();
    try std.testing.expectEqualSlices(u8, value.current_image.?.pixels, lossless.pixels);

    try value.configurePng(1, 4, 5);
    _ = try value.update(0);
    const rgb666 = try image.decode(std.testing.allocator, value.current_image.?.encoded_png.?, .{});
    defer rgb666.deinit();
    for (value.current_image.?.pixels, rgb666.pixels, 0..) |source, encoded, index| {
        if (index % 4 == 3)
            try std.testing.expectEqual(@as(u8, 255), encoded)
        else
            try std.testing.expectEqual(quantize6(source), encoded);
    }
}

test "video audio decodes real AAC into its native PCM ring" {
    const value = try openVideo();
    defer value.deinit();
    try std.testing.expect(value.info.has_audio != 0);
    try std.testing.expect(value.audio_engine != null);

    const produced = try value.refillAudio(4096);
    try std.testing.expect(produced > 0);
    try std.testing.expectEqual(produced, audio.getPcmQueuedFrames(value.audio_engine.?));

    try std.testing.expectEqual(audio.Status.ok, audio.startMixer(value.audio_engine.?));
    const output = try std.testing.allocator.alloc(f32, @as(usize, produced) * 2);
    defer std.testing.allocator.free(output);
    try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, output.ptr, produced, 2));
    try std.testing.expectEqual(@as(u64, produced), audio.getPcmConsumedFrames(value.audio_engine.?));
    var has_signal = false;
    for (output) |sample| has_signal = has_signal or @abs(sample) > 0.0001;
    try std.testing.expect(has_signal);
}

test "video audio refill is bounded and preserves pending samples" {
    const value = try openVideo();
    defer value.deinit();

    try std.testing.expectEqual(@as(u32, 1024), try value.refillAudio(1024));
    try std.testing.expectEqual(@as(u32, 1024), audio.getPcmQueuedFrames(value.audio_engine.?));
    try std.testing.expectEqual(@as(u32, 1024), try value.refillAudio(1024));
    try std.testing.expectEqual(@as(u32, 2048), audio.getPcmQueuedFrames(value.audio_engine.?));
}

test "video audio seek clears old PCM and refills from target" {
    const value = try openVideo();
    defer value.deinit();
    _ = try value.refillAudio(4096);
    try std.testing.expect(audio.getPcmQueuedFrames(value.audio_engine.?) > 0);

    try value.seek(1_375_000);
    try std.testing.expectEqual(@as(u32, 0), audio.getPcmQueuedFrames(value.audio_engine.?));
    try std.testing.expect((try value.refillAudio(4096)) > 0);
}

test "video audio reaches EOF and drains resampler output" {
    const value = try openVideo();
    defer value.deinit();
    try value.seek(5_900_000);

    var total: u64 = 0;
    while (!value.audio_ended) {
        const produced = try value.refillAudio(4096);
        total += produced;
        if (produced == 0 and !value.audio_ended) return error.TestUnexpectedResult;
        if (audio.getPcmQueuedFrames(value.audio_engine.?) > 16_000) {
            try std.testing.expectEqual(audio.Status.ok, audio.startMixer(value.audio_engine.?));
            var output: [8192]f32 = undefined;
            try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, 4096, 2));
        }
    }
    try std.testing.expect(total > 0);
}

test "video playback incrementally prebuffers through production updates" {
    const value = try openVideo();
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();

    _ = try value.update(0);
    var state = value.getState();
    try std.testing.expectEqual(@as(u32, 4096), state.audio_queued_frames);
    try std.testing.expectEqual(@as(u32, 1), state.buffering);
    try std.testing.expectEqual(@as(u32, 0), state.audio_active);

    _ = try value.update(33_333);
    state = value.getState();
    try std.testing.expectEqual(@as(u32, 8192), state.audio_queued_frames);
    try std.testing.expectEqual(@as(u32, 1), state.buffering);

    _ = try value.update(66_666);
    state = value.getState();
    try std.testing.expect(state.audio_queued_frames >= 12_000);
    try std.testing.expectEqual(@as(u32, 0), state.buffering);
    try std.testing.expectEqual(@as(u32, 1), state.audio_active);
}

test "video pause and resume preserve queued PCM and native clock" {
    const value = try openVideo();
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    for (0..3) |index| _ = try value.update(@intCast(index * 33_333));

    var output: [3200]f32 = undefined;
    try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, 1600, 2));
    const before_pause = value.getState();
    try std.testing.expect(before_pause.current_time_us >= 33_000);
    const queued = before_pause.audio_queued_frames;

    value.pause();
    try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, 1600, 2));
    const paused = value.getState();
    try std.testing.expectEqual(before_pause.audio_consumed_frames, paused.audio_consumed_frames);
    try std.testing.expectEqual(queued, paused.audio_queued_frames);

    value.play();
    _ = try value.update(paused.current_time_us);
    try std.testing.expectEqual(@as(u32, 1), value.getState().audio_active);
}

test "video mute outputs silence while native media clock advances" {
    const value = try openVideo();
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    for (0..3) |index| _ = try value.update(@intCast(index * 33_333));
    try value.setMuted(true);

    var output: [3200]f32 = undefined;
    try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, &output, 1600, 2));
    for (output) |sample| try std.testing.expectEqual(@as(f32, 0), sample);
    try std.testing.expect(value.getState().current_time_us >= 33_000);
}

test "video underrun freezes media clock and recovers after watermark refill" {
    const value = try openVideo();
    defer value.deinit();
    value.setAudioOffline(true);
    value.play();
    for (0..3) |index| _ = try value.update(@intCast(index * 33_333));

    const queued = value.getState().audio_queued_frames;
    const output = try std.testing.allocator.alloc(f32, @as(usize, queued + 1600) * 2);
    defer std.testing.allocator.free(output);
    try std.testing.expectEqual(audio.Status.ok, audio.mixToBuffer(value.audio_engine.?, output.ptr, queued + 1600, 2));
    const stalled_time = value.getState().current_time_us;
    _ = try value.update(1_000_000);
    var state = value.getState();
    try std.testing.expectEqual(@as(u32, 1), state.buffering);
    try std.testing.expectEqual(stalled_time, state.current_time_us);
    try std.testing.expect(state.audio_underruns > 0);

    _ = try value.update(1_033_333);
    _ = try value.update(1_066_666);
    state = value.getState();
    try std.testing.expectEqual(@as(u32, 1), state.audio_active);
    try std.testing.expectEqual(@as(u32, 0), state.buffering);
}

test "video output geometry changes preserve native audio queue" {
    const value = try openVideo();
    defer value.deinit();
    _ = try value.refillAudio(4096);
    const queued = audio.getPcmQueuedFrames(value.audio_engine.?);
    try value.configureOutput(320, 480, false);
    try std.testing.expectEqual(queued, audio.getPcmQueuedFrames(value.audio_engine.?));
}

test "video manual PCM reads are rejected while native playback owns audio" {
    const value = try openVideo();
    defer value.deinit();
    value.play();
    var samples: [512]f32 = undefined;
    try std.testing.expectError(error.InvalidArgument, value.readAudio(&samples, 256));
}
