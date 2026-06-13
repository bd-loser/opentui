#include "video-shim.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    AVFormatContext *format;
    AVCodecContext *codec;
    AVStream *stream;
    int stream_index;
    AVPacket *packet;
    AVFrame *frame;
    int packet_pending;
    int demux_eof;
    int drain_sent;
} ot_stream_decoder;

struct ot_video_decoder {
    ot_stream_decoder video;
    ot_stream_decoder audio;
    int has_audio;
    int64_t duration_us;
    int64_t origin_us;
    int64_t seek_us;
    uint32_t source_width;
    uint32_t source_height;
    uint32_t output_width;
    uint32_t output_height;
    int output_cover;
    struct SwsContext *sws;
    struct SwrContext *swr;
    uint8_t *rgba;
    size_t rgba_size;
    uint8_t *scaled_rgba;
    size_t scaled_rgba_size;
    AVFrame *video_lookahead;
    int64_t frame_pts_us;
    uint64_t frame_serial;
    float *audio_pending;
    uint32_t audio_pending_frames;
    uint32_t audio_pending_offset;
    char error[256];
};

static int fail(ot_video_decoder *decoder, int error, const char *operation) {
    char detail[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(error, detail, sizeof(detail));
    snprintf(decoder->error, sizeof(decoder->error), "%s: %s (%d)", operation, detail, error);
    return OT_VIDEO_ERROR;
}

static void close_stream(ot_stream_decoder *stream) {
    av_frame_free(&stream->frame);
    av_packet_free(&stream->packet);
    avcodec_free_context(&stream->codec);
    avformat_close_input(&stream->format);
    memset(stream, 0, sizeof(*stream));
    stream->stream_index = -1;
}

static int open_stream(ot_video_decoder *decoder, const char *path, enum AVMediaType type,
                       enum AVCodecID required_codec, ot_stream_decoder *out) {
    memset(out, 0, sizeof(*out));
    out->stream_index = -1;
    int result = avformat_open_input(&out->format, path, NULL, NULL);
    if (result < 0) return fail(decoder, result, "avformat_open_input");
    result = avformat_find_stream_info(out->format, NULL);
    if (result < 0) return fail(decoder, result, "avformat_find_stream_info");
    const AVCodec *codec = NULL;
    result = av_find_best_stream(out->format, type, -1, -1, &codec, 0);
    if (result == AVERROR_STREAM_NOT_FOUND && type == AVMEDIA_TYPE_AUDIO) {
        close_stream(out);
        return OT_VIDEO_EOF;
    }
    if (result < 0) return fail(decoder, result, "av_find_best_stream");
    out->stream_index = result;
    out->stream = out->format->streams[out->stream_index];
    if (out->stream->codecpar->codec_id != required_codec) {
        snprintf(decoder->error, sizeof(decoder->error), "unsupported %s codec: %s",
                 type == AVMEDIA_TYPE_VIDEO ? "video" : "audio",
                 avcodec_get_name(out->stream->codecpar->codec_id));
        return OT_VIDEO_ERROR;
    }
    codec = avcodec_find_decoder(required_codec);
    if (!codec) return fail(decoder, AVERROR_DECODER_NOT_FOUND, "avcodec_find_decoder");
    out->codec = avcodec_alloc_context3(codec);
    if (!out->codec) return fail(decoder, AVERROR(ENOMEM), "avcodec_alloc_context3");
    result = avcodec_parameters_to_context(out->codec, out->stream->codecpar);
    if (result < 0) return fail(decoder, result, "avcodec_parameters_to_context");
    out->codec->pkt_timebase = out->stream->time_base;
    out->codec->thread_count = 0;
    result = avcodec_open2(out->codec, codec, NULL);
    if (result < 0) return fail(decoder, result, "avcodec_open2");
    out->packet = av_packet_alloc();
    out->frame = av_frame_alloc();
    if (!out->packet || !out->frame) return fail(decoder, AVERROR(ENOMEM), "allocate packet/frame");
    return OT_VIDEO_OK;
}

static int64_t stream_pts_us(const ot_video_decoder *decoder, const ot_stream_decoder *stream,
                             const AVFrame *frame) {
    int64_t timestamp = frame->best_effort_timestamp;
    if (timestamp == AV_NOPTS_VALUE) timestamp = frame->pts;
    if (timestamp == AV_NOPTS_VALUE) return AV_NOPTS_VALUE;
    return av_rescale_q(timestamp, stream->stream->time_base, AV_TIME_BASE_Q) - decoder->origin_us;
}

static int receive_or_read(ot_video_decoder *decoder, ot_stream_decoder *stream) {
    for (;;) {
        av_frame_unref(stream->frame);
        int result = avcodec_receive_frame(stream->codec, stream->frame);
        if (result == 0) return OT_VIDEO_OK;
        if (result == AVERROR_EOF) return OT_VIDEO_EOF;
        if (result != AVERROR(EAGAIN)) return fail(decoder, result, "avcodec_receive_frame");

        if (stream->demux_eof) {
            if (!stream->drain_sent) {
                result = avcodec_send_packet(stream->codec, NULL);
                if (result == AVERROR(EAGAIN)) continue;
                if (result < 0 && result != AVERROR_EOF) return fail(decoder, result, "decoder drain");
                stream->drain_sent = 1;
                continue;
            }
            return OT_VIDEO_EOF;
        }

        if (!stream->packet_pending) {
            do {
                av_packet_unref(stream->packet);
                result = av_read_frame(stream->format, stream->packet);
                if (result == AVERROR_EOF) {
                    stream->demux_eof = 1;
                    break;
                }
                if (result < 0) return fail(decoder, result, "av_read_frame");
            } while (stream->packet->stream_index != stream->stream_index);
            if (stream->demux_eof) continue;
            stream->packet_pending = 1;
        }

        result = avcodec_send_packet(stream->codec, stream->packet);
        if (result == AVERROR(EAGAIN)) continue;
        av_packet_unref(stream->packet);
        stream->packet_pending = 0;
        if (result < 0) return fail(decoder, result, "avcodec_send_packet");
    }
}

static int configure_swr(ot_video_decoder *decoder, const AVFrame *frame) {
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    swr_free(&decoder->swr);
    int result = swr_alloc_set_opts2(&decoder->swr, &stereo, AV_SAMPLE_FMT_FLT, 48000,
                                     &frame->ch_layout, (enum AVSampleFormat)frame->format,
                                     frame->sample_rate, 0, NULL);
    if (result < 0) return fail(decoder, result, "swr_alloc_set_opts2");
    result = swr_init(decoder->swr);
    if (result < 0) return fail(decoder, result, "swr_init");
    return OT_VIDEO_OK;
}

int ot_video_open(const char *path, ot_video_decoder **out_decoder, ot_video_info *out_info) {
    if (!path || !out_decoder || !out_info) return OT_VIDEO_ERROR;
    *out_decoder = NULL;
    av_log_set_level(AV_LOG_ERROR);
    memset(out_info, 0, sizeof(*out_info));
    ot_video_decoder *decoder = calloc(1, sizeof(*decoder));
    if (!decoder) return OT_VIDEO_ERROR;
    decoder->video.stream_index = -1;
    decoder->audio.stream_index = -1;
    decoder->frame_pts_us = AV_NOPTS_VALUE;

    if (open_stream(decoder, path, AVMEDIA_TYPE_VIDEO, AV_CODEC_ID_H264, &decoder->video) != OT_VIDEO_OK) {
        ot_video_close(&decoder);
        return OT_VIDEO_ERROR;
    }
    int audio_result = open_stream(decoder, path, AVMEDIA_TYPE_AUDIO, AV_CODEC_ID_AAC, &decoder->audio);
    if (audio_result == OT_VIDEO_ERROR) {
        close_stream(&decoder->audio);
        decoder->error[0] = 0;
        audio_result = OT_VIDEO_EOF;
    }
    decoder->has_audio = audio_result == OT_VIDEO_OK;
    decoder->origin_us = decoder->video.format->start_time == AV_NOPTS_VALUE ? 0 : decoder->video.format->start_time;
    decoder->duration_us = decoder->video.format->duration == AV_NOPTS_VALUE ? 0 : decoder->video.format->duration;
    decoder->source_width = decoder->video.stream->codecpar->width;
    decoder->source_height = decoder->video.stream->codecpar->height;
    decoder->output_width = decoder->source_width;
    decoder->output_height = decoder->source_height;
    decoder->video_lookahead = av_frame_alloc();
    if (!decoder->video_lookahead) {
        ot_video_close(&decoder);
        return OT_VIDEO_ERROR;
    }

    AVRational fps = decoder->video.stream->avg_frame_rate;
    out_info->duration_us = decoder->duration_us;
    out_info->width = decoder->source_width;
    out_info->height = decoder->source_height;
    out_info->fps_num = fps.num > 0 ? (uint32_t)fps.num : 0;
    out_info->fps_den = fps.den > 0 ? (uint32_t)fps.den : 1;
    out_info->has_audio = decoder->has_audio;
    out_info->audio_sample_rate = decoder->has_audio ? 48000 : 0;
    out_info->audio_channels = decoder->has_audio ? 2 : 0;
    *out_decoder = decoder;
    return OT_VIDEO_OK;
}

void ot_video_close(ot_video_decoder **decoder_ptr) {
    if (!decoder_ptr || !*decoder_ptr) return;
    ot_video_decoder *decoder = *decoder_ptr;
    free(decoder->audio_pending);
    av_frame_free(&decoder->video_lookahead);
    free(decoder->scaled_rgba);
    free(decoder->rgba);
    swr_free(&decoder->swr);
    sws_freeContext(decoder->sws);
    close_stream(&decoder->audio);
    close_stream(&decoder->video);
    free(decoder);
    *decoder_ptr = NULL;
}

int ot_video_set_output_size(ot_video_decoder *decoder, uint32_t width, uint32_t height, uint32_t cover) {
    if (!decoder || width == 0 || height == 0) return OT_VIDEO_ERROR;
    decoder->output_width = width;
    decoder->output_height = height;
    decoder->output_cover = cover != 0;
    sws_freeContext(decoder->sws);
    decoder->sws = NULL;
    free(decoder->rgba);
    decoder->rgba = NULL;
    decoder->rgba_size = 0;
    decoder->frame_pts_us = AV_NOPTS_VALUE;
    av_frame_unref(decoder->video_lookahead);
    return OT_VIDEO_OK;
}

static int seek_stream(ot_video_decoder *decoder, ot_stream_decoder *stream, int64_t target_us) {
    if (!stream->format || !stream->stream || !stream->codec || stream->stream_index < 0) return OT_VIDEO_OK;
    int64_t absolute_us = target_us + decoder->origin_us;
    int64_t timestamp = av_rescale_q(absolute_us, AV_TIME_BASE_Q, stream->stream->time_base);
    int result = avformat_seek_file(stream->format, stream->stream_index, INT64_MIN, timestamp, timestamp, AVSEEK_FLAG_BACKWARD);
    if (result < 0) result = av_seek_frame(stream->format, stream->stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (result < 0) return fail(decoder, result, "avformat_seek_file");
    avcodec_flush_buffers(stream->codec);
    av_packet_unref(stream->packet);
    stream->packet_pending = 0;
    av_frame_unref(stream->frame);
    stream->demux_eof = 0;
    stream->drain_sent = 0;
    return OT_VIDEO_OK;
}

int ot_video_seek(ot_video_decoder *decoder, int64_t target_us) {
    if (!decoder) return OT_VIDEO_ERROR;
    if (target_us < 0) target_us = 0;
    if (decoder->duration_us > 0 && target_us > decoder->duration_us) target_us = decoder->duration_us;
    if (seek_stream(decoder, &decoder->video, target_us) != OT_VIDEO_OK) return OT_VIDEO_ERROR;
    if (seek_stream(decoder, &decoder->audio, target_us) != OT_VIDEO_OK) return OT_VIDEO_ERROR;
    decoder->seek_us = target_us;
    decoder->frame_pts_us = AV_NOPTS_VALUE;
    decoder->audio_pending_frames = 0;
    decoder->audio_pending_offset = 0;
    av_frame_unref(decoder->video_lookahead);
    swr_free(&decoder->swr);
    return OT_VIDEO_OK;
}

static int convert_video_frame(ot_video_decoder *decoder, const AVFrame *frame, int64_t pts) {
    uint32_t scaled_width = decoder->output_width;
    uint32_t scaled_height = decoder->output_height;
    if (decoder->output_cover) {
        const double source_aspect = (double)frame->width / frame->height;
        const double target_aspect = (double)decoder->output_width / decoder->output_height;
        if (source_aspect > target_aspect)
            scaled_width = (uint32_t)(source_aspect * decoder->output_height + 0.999999);
        else
            scaled_height = (uint32_t)(decoder->output_width / source_aspect + 0.999999);
    }
    decoder->sws = sws_getCachedContext(decoder->sws, frame->width, frame->height,
                                        (enum AVPixelFormat)frame->format, scaled_width, scaled_height,
                                        AV_PIX_FMT_RGBA, SWS_BILINEAR, NULL, NULL, NULL);
    if (!decoder->sws) return fail(decoder, AVERROR(ENOMEM), "sws_getCachedContext");
    const size_t required = (size_t)decoder->output_width * decoder->output_height * 4;
    if (required != decoder->rgba_size) {
        uint8_t *next = realloc(decoder->rgba, required);
        if (!next) return fail(decoder, AVERROR(ENOMEM), "RGBA allocation");
        decoder->rgba = next;
        decoder->rgba_size = required;
    }
    const size_t scaled_size = (size_t)scaled_width * scaled_height * 4;
    uint8_t *scale_target = decoder->rgba;
    if (decoder->output_cover && (scaled_width != decoder->output_width || scaled_height != decoder->output_height)) {
        if (scaled_size != decoder->scaled_rgba_size) {
            uint8_t *next = realloc(decoder->scaled_rgba, scaled_size);
            if (!next) return fail(decoder, AVERROR(ENOMEM), "cover allocation");
            decoder->scaled_rgba = next;
            decoder->scaled_rgba_size = scaled_size;
        }
        scale_target = decoder->scaled_rgba;
    }
    uint8_t *dest[4] = {scale_target, NULL, NULL, NULL};
    int dest_linesize[4] = {(int)scaled_width * 4, 0, 0, 0};
    int scaled = sws_scale(decoder->sws, (const uint8_t *const *)frame->data, frame->linesize,
                           0, frame->height, dest, dest_linesize);
    if (scaled != (int)scaled_height) return fail(decoder, AVERROR_INVALIDDATA, "sws_scale");
    if (scale_target != decoder->rgba) {
        const uint32_t crop_x = (scaled_width - decoder->output_width) / 2;
        const uint32_t crop_y = (scaled_height - decoder->output_height) / 2;
        const size_t output_row = (size_t)decoder->output_width * 4;
        for (uint32_t y = 0; y < decoder->output_height; y++)
            memcpy(decoder->rgba + (size_t)y * output_row,
                   decoder->scaled_rgba + ((size_t)(crop_y + y) * scaled_width + crop_x) * 4,
                   output_row);
    }
    decoder->frame_pts_us = pts;
    decoder->frame_serial++;
    return OT_VIDEO_OK;
}

int ot_video_decode_frame(ot_video_decoder *decoder, int64_t target_us, const uint8_t **out_rgba,
                          uint32_t *out_width, uint32_t *out_height, uint32_t *out_stride,
                          int64_t *out_pts_us, uint64_t *out_serial) {
    if (!decoder || !out_rgba || !out_width || !out_height || !out_stride || !out_pts_us || !out_serial) return OT_VIDEO_ERROR;
    int reached_eof = 0;
    for (;;) {
        AVFrame *candidate = decoder->video_lookahead;
        if (!candidate->buf[0]) {
            int result = receive_or_read(decoder, &decoder->video);
            if (result == OT_VIDEO_EOF) {
                reached_eof = 1;
                break;
            }
            if (result != OT_VIDEO_OK) return result;
            candidate = decoder->video.frame;
        }
        int64_t pts = stream_pts_us(decoder, &decoder->video, candidate);
        if (pts == AV_NOPTS_VALUE) pts = decoder->frame_pts_us == AV_NOPTS_VALUE ? 0 : decoder->frame_pts_us;
        if (decoder->rgba && pts > target_us) {
            if (candidate != decoder->video_lookahead) {
                av_frame_unref(decoder->video_lookahead);
                if (av_frame_ref(decoder->video_lookahead, candidate) < 0)
                    return fail(decoder, AVERROR(ENOMEM), "av_frame_ref");
            }
            break;
        }
        if (convert_video_frame(decoder, candidate, pts) != OT_VIDEO_OK) return OT_VIDEO_ERROR;
        if (candidate == decoder->video_lookahead) av_frame_unref(decoder->video_lookahead);
        if (pts >= target_us) break;
    }
    if (reached_eof && decoder->duration_us > 0 && target_us >= decoder->duration_us) return OT_VIDEO_EOF;
    if (!decoder->rgba) return OT_VIDEO_EOF;
    *out_rgba = decoder->rgba;
    *out_width = decoder->output_width;
    *out_height = decoder->output_height;
    *out_stride = decoder->output_width * 4;
    *out_pts_us = decoder->frame_pts_us;
    *out_serial = decoder->frame_serial;
    return OT_VIDEO_OK;
}

int ot_video_read_audio(ot_video_decoder *decoder, float *out_samples, uint32_t capacity_frames,
                        uint32_t *out_frames) {
    if (!decoder || !out_frames || (capacity_frames > 0 && !out_samples)) return OT_VIDEO_ERROR;
    *out_frames = 0;
    if (!decoder->has_audio || capacity_frames == 0) return OT_VIDEO_OK;
    while (*out_frames < capacity_frames) {
        if (decoder->audio_pending_offset < decoder->audio_pending_frames) {
            uint32_t available = decoder->audio_pending_frames - decoder->audio_pending_offset;
            uint32_t count = available < capacity_frames - *out_frames ? available : capacity_frames - *out_frames;
            memcpy(out_samples + (size_t)*out_frames * 2,
                   decoder->audio_pending + (size_t)decoder->audio_pending_offset * 2,
                   (size_t)count * 2 * sizeof(float));
            decoder->audio_pending_offset += count;
            *out_frames += count;
            continue;
        }
        decoder->audio_pending_frames = 0;
        decoder->audio_pending_offset = 0;
        int result = receive_or_read(decoder, &decoder->audio);
        if (result == OT_VIDEO_EOF) break;
        if (result != OT_VIDEO_OK) return result;
        int64_t pts = stream_pts_us(decoder, &decoder->audio, decoder->audio.frame);
        int64_t end_us = pts == AV_NOPTS_VALUE ? decoder->seek_us : pts + av_rescale_q(decoder->audio.frame->nb_samples,
                                                                                       (AVRational){1, decoder->audio.frame->sample_rate},
                                                                                       AV_TIME_BASE_Q);
        if (end_us <= decoder->seek_us) continue;
        if (!decoder->swr && configure_swr(decoder, decoder->audio.frame) != OT_VIDEO_OK) return OT_VIDEO_ERROR;
        int capacity = swr_get_out_samples(decoder->swr, decoder->audio.frame->nb_samples);
        if (capacity < 0) return fail(decoder, capacity, "swr_get_out_samples");
        float *next = realloc(decoder->audio_pending, (size_t)capacity * 2 * sizeof(float));
        if (!next) return fail(decoder, AVERROR(ENOMEM), "audio allocation");
        decoder->audio_pending = next;
        uint8_t *output[1] = {(uint8_t *)decoder->audio_pending};
        int produced = swr_convert(decoder->swr, output, capacity,
                                   (const uint8_t *const *)decoder->audio.frame->extended_data,
                                   decoder->audio.frame->nb_samples);
        if (produced < 0) return fail(decoder, produced, "swr_convert");
        if (pts != AV_NOPTS_VALUE && pts < decoder->seek_us && produced > 0) {
            int64_t trim = av_rescale_rnd(decoder->seek_us - pts, 48000, AV_TIME_BASE, AV_ROUND_UP);
            if (trim > produced) trim = produced;
            if (trim > 0) {
                memmove(decoder->audio_pending, decoder->audio_pending + trim * 2,
                        (size_t)(produced - trim) * 2 * sizeof(float));
                produced -= (int)trim;
            }
        }
        decoder->audio_pending_frames = (uint32_t)produced;
    }
    return OT_VIDEO_OK;
}

const char *ot_video_last_error(const ot_video_decoder *decoder) {
    return decoder ? decoder->error : "invalid video decoder";
}
