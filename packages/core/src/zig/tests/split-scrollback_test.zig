const std = @import("std");
const split_scrollback = @import("../split-scrollback.zig");
const buffer = @import("../buffer.zig");

fn makeAsciiRow(text: []const u8) !split_scrollback.StoredRow {
    var row = split_scrollback.StoredRow{};
    errdefer row.cells.deinit(std.testing.allocator);

    for (text) |byte| {
        try row.cells.append(std.testing.allocator, buffer.Cell{
            .char = byte,
            .fg = .{ 1.0, 1.0, 1.0, 1.0 },
            .bg = .{ 0.0, 0.0, 0.0, 0.0 },
            .attributes = 0,
        });
    }

    return row;
}

fn deinitRow(row: *split_scrollback.StoredRow) void {
    row.cells.deinit(std.testing.allocator);
    row.* = .{};
}

fn makeCommit(rows: []const []const u8, start_on_new_line: bool, trailing_newline: bool) !split_scrollback.PendingCommit {
    var commit = split_scrollback.PendingCommit{
        .start_on_new_line = start_on_new_line,
        .trailing_newline = trailing_newline,
    };
    errdefer deinitCommit(&commit);

    for (rows) |text| {
        try commit.rows.append(std.testing.allocator, try makeAsciiRow(text));
    }

    return commit;
}

fn deinitCommit(commit: *split_scrollback.PendingCommit) void {
    for (commit.rows.items) |*row| {
        deinitRow(row);
    }
    commit.rows.deinit(std.testing.allocator);
    commit.* = .{};
}

test "split scrollback layout starts empty" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(40, 0);

    try std.testing.expectEqual(@as(u32, 0), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.tail_column);
    try std.testing.expectEqual(@as(u32, 0), layout.renderOffset(6));
}

test "split scrollback reset seeds pinned rows" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(40, 6);

    try std.testing.expectEqual(@as(u32, 6), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.tail_column);
    try std.testing.expectEqual(@as(u32, 6), layout.renderOffset(6));

    var commit = try makeCommit(&.{"a"}, false, false);
    defer deinitCommit(&commit);

    layout.applyPendingCommit(&commit);
    try std.testing.expectEqual(@as(u32, 6), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 1), layout.tail_column);
    try std.testing.expectEqual(@as(u32, 6), layout.renderOffset(6));
}

test "split scrollback starts replay on the first app-owned row after a seeded newline" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(40, 1);

    var commit = try makeCommit(&.{"a"}, false, true);
    defer deinitCommit(&commit);

    layout.applyPendingCommit(&commit);

    try std.testing.expectEqual(@as(u32, 2), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 1), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.tail_column);

    const coverage = layout.coverage(6);
    try std.testing.expectEqual(@as(u32, 2), coverage.render_offset);
    try std.testing.expectEqual(@as(u32, 1), coverage.covered_rows);
    try std.testing.expectEqual(@as(u32, 1), coverage.uncovered_rows);
    try std.testing.expect(coverage.partial_coverage);
}

test "split scrollback snapshot rows start at line boundary" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(20, 0);

    var first = try makeCommit(&.{"1234"}, false, false);
    defer deinitCommit(&first);
    layout.applyPendingCommit(&first);

    try std.testing.expectEqual(@as(u32, 1), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 4), layout.tail_column);

    var second = try makeCommit(&.{ "abcdefgh", "ijklmnop" }, true, true);
    defer deinitCommit(&second);
    layout.applyPendingCommit(&second);

    try std.testing.expectEqual(@as(u32, 4), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 4), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.tail_column);
}

test "split scrollback snapshot rows wrap visible columns against terminal width" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(4, 0);

    var commit = try makeCommit(&.{"123456"}, false, true);
    defer deinitCommit(&commit);

    layout.applyPendingCommit(&commit);

    try std.testing.expectEqual(@as(u32, 3), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 3), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 0), layout.tail_column);
}

test "split scrollback snapshot rows can omit trailing newline" {
    var layout = split_scrollback.LayoutState{};
    layout.reset(4, 0);

    var commit = try makeCommit(&.{"123456"}, false, false);
    defer deinitCommit(&commit);

    layout.applyPendingCommit(&commit);

    try std.testing.expectEqual(@as(u32, 2), layout.total_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 2), layout.replay_wrapped_rows);
    try std.testing.expectEqual(@as(u32, 2), layout.tail_column);
}
