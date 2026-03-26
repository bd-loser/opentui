const utf8 = @import("utf8.zig");

const TEXT_BRIDGE_TAB_WIDTH: u8 = 4;

fn findTextRunEnd(output: []const u8, start: usize) usize {
    var end = start;

    while (end < output.len) : (end += 1) {
        const byte = output[end];
        if (byte == '\r' or byte == '\n' or byte == 0x1b) {
            break;
        }
    }

    return end;
}

fn skipAnsiEscape(output: []const u8, start: usize) usize {
    if (start + 1 >= output.len) {
        return output.len;
    }

    const introducer = output[start + 1];

    // CSI escape sequence, e.g. \x1b[38;2;255;0;0m
    if (introducer == '[') {
        var pos = start + 2;
        while (pos < output.len) : (pos += 1) {
            const byte = output[pos];
            if (byte >= 0x40 and byte <= 0x7e) {
                return pos + 1;
            }
        }

        return output.len;
    }

    // OSC escape sequence, e.g. \x1b]8;;url\x07text\x1b]8;;\x07
    if (introducer == ']') {
        var pos = start + 2;
        while (pos < output.len) : (pos += 1) {
            const byte = output[pos];
            if (byte == 0x07) {
                return pos + 1;
            }

            if (byte == 0x1b and pos + 1 < output.len and output[pos + 1] == '\\') {
                return pos + 2;
            }
        }

        return output.len;
    }

    // DCS/SOS/PM/APC style escape sequences terminated by ST.
    if (introducer == 'P' or introducer == '_' or introducer == '^' or introducer == 'X') {
        var pos = start + 2;
        while (pos < output.len) : (pos += 1) {
            if (output[pos] == 0x1b and pos + 1 < output.len and output[pos + 1] == '\\') {
                return pos + 2;
            }
        }

        return output.len;
    }

    // Other short escape forms are typically ESC + one byte.
    return @min(start + 2, output.len);
}

pub const SplitScrollback = struct {
    published_rows: u32 = 0,
    tail_column: u32 = 0,

    pub fn reset(self: *SplitScrollback, seed_rows: u32) void {
        self.published_rows = seed_rows;
        self.tail_column = 0;
    }

    pub fn renderOffset(self: *const SplitScrollback, pinned_render_offset: u32) u32 {
        if (pinned_render_offset == 0) {
            return 0;
        }

        return @min(self.published_rows, pinned_render_offset);
    }

    pub fn noteNewline(self: *SplitScrollback) void {
        if (self.published_rows == 0) {
            self.published_rows = 1;
        }

        self.published_rows += 1;
        self.tail_column = 0;
    }

    pub fn publishSnapshotRows(self: *SplitScrollback, row_count: u32, row_columns: u32, terminal_width: u32) void {
        if (row_count == 0) {
            return;
        }

        var row: u32 = 0;
        while (row < row_count) : (row += 1) {
            self.publishColumns(row_columns, terminal_width);
            self.noteNewline();
        }
    }

    pub fn publishTextBridge(self: *SplitScrollback, output: []const u8, width: u32, width_method: utf8.WidthMethod) void {
        const safe_width = @max(width, @as(u32, 1));
        var pos: usize = 0;

        while (pos < output.len) {
            const byte = output[pos];
            switch (byte) {
                '\n' => {
                    self.noteNewline();
                    pos += 1;
                },
                '\r' => {
                    if (self.published_rows > 0) {
                        self.tail_column = 0;
                    }
                    pos += 1;
                },
                0x1b => {
                    pos = skipAnsiEscape(output, pos);
                },
                else => {
                    const run_end = findTextRunEnd(output, pos);
                    self.publishPrintableRun(output[pos..run_end], safe_width, width_method);
                    pos = run_end;
                },
            }
        }
    }

    fn publishPrintableRun(self: *SplitScrollback, run: []const u8, width: u32, width_method: utf8.WidthMethod) void {
        if (run.len == 0) {
            return;
        }

        var remaining = run;

        while (remaining.len > 0) {
            if (self.published_rows == 0) {
                self.published_rows = 1;
            }

            if (self.tail_column >= width) {
                self.published_rows += 1;
                self.tail_column = 0;
            }

            const is_ascii_only = utf8.isAsciiOnly(remaining);
            const available_width = width - self.tail_column;
            const wrap = utf8.findWrapPosByWidth(
                remaining,
                available_width,
                TEXT_BRIDGE_TAB_WIDTH,
                is_ascii_only,
                width_method,
            );

            if (wrap.byte_offset == remaining.len) {
                self.tail_column += wrap.columns_used;
                return;
            }

            if (wrap.byte_offset == 0) {
                if (self.tail_column > 0) {
                    self.published_rows += 1;
                    self.tail_column = 0;
                    continue;
                }

                const first = utf8.findPosByWidth(
                    remaining,
                    1,
                    TEXT_BRIDGE_TAB_WIDTH,
                    is_ascii_only,
                    true,
                    width_method,
                );

                if (first.byte_offset == 0) {
                    remaining = remaining[1..];
                    self.tail_column = @min(width, @as(u32, 1));
                } else {
                    remaining = remaining[first.byte_offset..];
                    self.tail_column = @min(width, @max(first.columns_used, @as(u32, 1)));
                }

                continue;
            }

            remaining = remaining[wrap.byte_offset..];
            self.tail_column += wrap.columns_used;

            if (remaining.len > 0) {
                self.published_rows += 1;
                self.tail_column = 0;
            }
        }
    }

    fn publishColumns(self: *SplitScrollback, columns: u32, width: u32) void {
        if (columns == 0) {
            return;
        }

        const safe_width = @max(width, @as(u32, 1));
        var remaining = columns;

        while (remaining > 0) {
            if (self.published_rows == 0) {
                self.published_rows = 1;
            }

            if (self.tail_column >= safe_width) {
                self.published_rows += 1;
                self.tail_column = 0;
            }

            const available_width = safe_width - self.tail_column;
            const step = @min(remaining, available_width);

            self.tail_column += step;
            remaining -= step;

            if (remaining > 0 and self.tail_column >= safe_width) {
                self.published_rows += 1;
                self.tail_column = 0;
            }
        }
    }
};
