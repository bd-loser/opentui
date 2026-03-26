const std = @import("std");
const split_scrollback = @import("../split-scrollback.zig");
const utf8 = @import("../utf8.zig");

test "split scrollback starts empty" {
    var scrollback = split_scrollback.SplitScrollback{};

    try std.testing.expectEqual(@as(u32, 0), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
    try std.testing.expectEqual(@as(u32, 0), scrollback.renderOffset(6));
}

test "split scrollback text bridge tracks newline commits" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("a\n", 40, .unicode);

    try std.testing.expectEqual(@as(u32, 2), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
    try std.testing.expectEqual(@as(u32, 2), scrollback.renderOffset(6));
}

test "split scrollback text bridge carries exact wraps across commits" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("abcd", 4, .unicode);
    try std.testing.expectEqual(@as(u32, 1), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 4), scrollback.tail_column);

    scrollback.publishTextBridge("e", 4, .unicode);
    try std.testing.expectEqual(@as(u32, 2), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 1), scrollback.tail_column);
}

test "split scrollback reset seeds pinned rows" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.reset(6);
    try std.testing.expectEqual(@as(u32, 6), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
    try std.testing.expectEqual(@as(u32, 6), scrollback.renderOffset(6));

    scrollback.publishTextBridge("x", 40, utf8.WidthMethod.unicode);
    try std.testing.expectEqual(@as(u32, 6), scrollback.renderOffset(6));
    try std.testing.expectEqual(@as(u32, 1), scrollback.tail_column);
}

test "split scrollback text bridge ignores ANSI SGR bytes for width accounting" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("\x1b[38;2;255;0;0mred\x1b[0m", 10, .unicode);

    try std.testing.expectEqual(@as(u32, 1), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 3), scrollback.tail_column);
}

test "split scrollback text bridge wraps by visible columns with ANSI SGR content" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("\x1b[31mabcd\x1b[0m", 3, .unicode);

    try std.testing.expectEqual(@as(u32, 2), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 1), scrollback.tail_column);
}

test "split scrollback text bridge ignores ANSI OSC bytes for width accounting" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("\x1b]8;;https://example.com\x07link\x1b]8;;\x07", 10, .unicode);

    try std.testing.expectEqual(@as(u32, 1), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 4), scrollback.tail_column);
}

test "split scrollback snapshot rows start at line boundary" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishTextBridge("tail", 20, .unicode);
    try std.testing.expectEqual(@as(u32, 1), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 4), scrollback.tail_column);

    scrollback.noteNewline();
    scrollback.publishSnapshotRows(2, 8, 20);

    try std.testing.expectEqual(@as(u32, 4), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
}

test "split scrollback snapshot rows wrap visible columns against terminal width" {
    var scrollback = split_scrollback.SplitScrollback{};

    scrollback.publishSnapshotRows(1, 6, 4);

    try std.testing.expectEqual(@as(u32, 3), scrollback.published_rows);
    try std.testing.expectEqual(@as(u32, 0), scrollback.tail_column);
}
