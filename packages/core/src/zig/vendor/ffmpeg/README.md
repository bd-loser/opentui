# FFmpeg

OpenTUI statically links a minimal decode-only FFmpeg 8.1.1 build containing only MOV/MP4 demuxing, H.264 video decoding, AAC audio decoding, file I/O, libswscale, and libswresample.

- Source: https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz
- SHA-256: `b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3`
- License: LGPL-2.1-or-later
- zlib 1.3.1: https://zlib.net/fossils/zlib-1.3.1.tar.gz
- zlib SHA-256: `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23`
- GPL and nonfree components are disabled.

The exact reproducible build configuration is in `packages/core/scripts/build-ffmpeg.ts`. Run `bun packages/core/scripts/build-ffmpeg.ts --all` to build all native targets.

FFmpeg source and LGPL license are available from the pinned source URL above. OpenTUI modifications are limited to the external `video-shim.c` integration; the FFmpeg source is unmodified.

The prebuilt native package contains both MIT-licensed OpenTUI code and statically linked LGPL-2.1-or-later FFmpeg code. The OpenTUI source, exact build script, pinned FFmpeg source, and target-specific build instructions provide the materials needed to rebuild and relink `libopentui` with a modified FFmpeg build.
