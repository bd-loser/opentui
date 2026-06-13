#ifndef OPENTUI_VIDEO_SHIM_H
#define OPENTUI_VIDEO_SHIM_H

#include <stdint.h>

typedef struct ot_video_decoder ot_video_decoder;

typedef struct {
    int64_t duration_us;
    uint32_t width;
    uint32_t height;
    uint32_t fps_num;
    uint32_t fps_den;
    uint32_t has_audio;
    uint32_t audio_sample_rate;
    uint32_t audio_channels;
} ot_video_info;

enum {
    OT_VIDEO_OK = 0,
    OT_VIDEO_EOF = 1,
    OT_VIDEO_ERROR = -1,
};

int ot_video_open(const char *path, ot_video_decoder **out_decoder, ot_video_info *out_info);
void ot_video_close(ot_video_decoder **decoder);
int ot_video_seek(ot_video_decoder *decoder, int64_t target_us);
int ot_video_set_output_size(ot_video_decoder *decoder, uint32_t width, uint32_t height, uint32_t cover);
int ot_video_decode_frame(ot_video_decoder *decoder, int64_t target_us, const uint8_t **out_rgba,
                          uint32_t *out_width, uint32_t *out_height, uint32_t *out_stride,
                          int64_t *out_pts_us, uint64_t *out_serial,
                          const uint8_t **out_png, uint64_t *out_png_len);
int ot_video_read_audio(ot_video_decoder *decoder, float *out_samples, uint32_t capacity_frames,
                        uint32_t *out_frames);
const char *ot_video_last_error(const ot_video_decoder *decoder);

#endif
