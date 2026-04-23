const std = @import("std");
const ansi = @import("ansi.zig");
const buf = @import("buffer.zig");
const gp = @import("grapheme.zig");
const link = @import("link.zig");

const Allocator = std.mem.Allocator;

pub const RowSlice = struct {
    cells: []const buf.Cell,
};

pub const Coverage = struct {
    render_offset: u32,
    covered_rows: u32,
    uncovered_rows: u32,
    fully_covered: bool,
    partial_coverage: bool,
};

const RowMetrics = struct {
    wrapped_rows: u32,
    tail_column: u32,
    has_content: bool,
};

fn safeWidth(width: u32) u32 {
    return @max(width, @as(u32, 1));
}

fn cellLinkId(cell: buf.Cell) u32 {
    return ansi.TextAttributes.getLinkId(cell.attributes);
}

fn trackCellAdd(grapheme_tracker: *gp.GraphemeTracker, link_tracker: *link.LinkTracker, cell: buf.Cell) void {
    if (gp.isClusterChar(cell.char)) {
        grapheme_tracker.add(gp.graphemeIdFromChar(cell.char));
    }

    const link_id = cellLinkId(cell);
    if (link_id != 0) {
        link_tracker.addCellRef(link_id);
    }
}

fn trackCellRemove(grapheme_tracker: *gp.GraphemeTracker, link_tracker: *link.LinkTracker, cell: buf.Cell) void {
    if (gp.isClusterChar(cell.char)) {
        grapheme_tracker.remove(gp.graphemeIdFromChar(cell.char));
    }

    const link_id = cellLinkId(cell);
    if (link_id != 0) {
        link_tracker.removeCellRef(link_id);
    }
}

fn snapshotRowEnd(snapshot: *const buf.OptimizedBuffer, row: u32, limit: u32) u32 {
    var x = limit;
    while (x > 0) {
        const cell = snapshot.get(x - 1, row) orelse {
            x -= 1;
            continue;
        };

        if (cell.char == 0 or gp.isContinuationChar(cell.char)) {
            x -= 1;
            continue;
        }

        return x;
    }

    return 0;
}

pub const StoredRow = struct {
    cells: std.ArrayListUnmanaged(buf.Cell) = .{},

    pub fn deinit(
        self: *StoredRow,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) void {
        for (self.cells.items) |cell| {
            trackCellRemove(grapheme_tracker, link_tracker, cell);
        }

        self.cells.deinit(allocator);
        self.* = .{};
    }

    pub fn isEmpty(self: *const StoredRow) bool {
        return self.cells.items.len == 0;
    }

    pub fn appendCell(
        self: *StoredRow,
        allocator: Allocator,
        cell: buf.Cell,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) !void {
        try self.cells.append(allocator, cell);
        trackCellAdd(grapheme_tracker, link_tracker, cell);
    }

    pub fn appendClonedRow(
        self: *StoredRow,
        allocator: Allocator,
        source: *const StoredRow,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) !void {
        for (source.cells.items) |cell| {
            try self.appendCell(allocator, cell, grapheme_tracker, link_tracker);
        }
    }

    pub fn cloneFromSnapshotRow(
        self: *StoredRow,
        allocator: Allocator,
        snapshot: *const buf.OptimizedBuffer,
        row: u32,
        row_end: u32,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) !void {
        var x: u32 = 0;
        while (x < row_end) : (x += 1) {
            const cell = snapshot.get(x, row) orelse buf.Cell{
                .char = 0,
                .fg = .{ 0.0, 0.0, 0.0, 0.0 },
                .bg = .{ 0.0, 0.0, 0.0, 0.0 },
                .attributes = 0,
            };
            try self.appendCell(allocator, cell, grapheme_tracker, link_tracker);
        }
    }

    pub fn metrics(self: *const StoredRow, width: u32) RowMetrics {
        const normalized_width = safeWidth(width);
        if (self.cells.items.len == 0) {
            return .{ .wrapped_rows = 1, .tail_column = 0, .has_content = false };
        }

        var wrapped_rows: u32 = 1;
        var tail_column: u32 = 0;
        var has_content = false;

        var index: usize = 0;
        while (index < self.cells.items.len) {
            const cell = self.cells.items[index];
            if (gp.isContinuationChar(cell.char)) {
                index += 1;
                continue;
            }

            const item_width = @min(gp.encodedCharWidth(cell.char), normalized_width);
            if (has_content and tail_column + item_width > normalized_width) {
                wrapped_rows += 1;
                tail_column = 0;
            }

            tail_column += item_width;
            has_content = true;

            index += 1;
            while (index < self.cells.items.len and gp.isContinuationChar(self.cells.items[index].char)) : (index += 1) {}
        }

        if (!has_content) {
            return .{ .wrapped_rows = 1, .tail_column = 0, .has_content = false };
        }

        return .{
            .wrapped_rows = wrapped_rows,
            .tail_column = tail_column,
            .has_content = true,
        };
    }

    pub fn appendWrappedSlices(
        self: *const StoredRow,
        allocator: Allocator,
        width: u32,
        slices: *std.ArrayListUnmanaged(RowSlice),
    ) !void {
        const normalized_width = safeWidth(width);
        if (self.cells.items.len == 0) {
            try slices.append(allocator, .{ .cells = self.cells.items[0..0] });
            return;
        }

        var segment_start: usize = 0;
        var segment_columns: u32 = 0;
        var segment_has_content = false;

        var item_start: usize = 0;
        while (item_start < self.cells.items.len) {
            const cell = self.cells.items[item_start];
            if (gp.isContinuationChar(cell.char)) {
                item_start += 1;
                continue;
            }

            var item_end = item_start + 1;
            while (item_end < self.cells.items.len and gp.isContinuationChar(self.cells.items[item_end].char)) : (item_end += 1) {}

            const item_width = @min(gp.encodedCharWidth(cell.char), normalized_width);
            if (segment_has_content and segment_columns + item_width > normalized_width) {
                try slices.append(allocator, .{ .cells = self.cells.items[segment_start..item_start] });
                segment_start = item_start;
                segment_columns = 0;
                segment_has_content = false;
            }

            segment_columns += item_width;
            segment_has_content = true;
            item_start = item_end;
        }

        if (segment_has_content) {
            try slices.append(allocator, .{ .cells = self.cells.items[segment_start..self.cells.items.len] });
        } else {
            try slices.append(allocator, .{ .cells = self.cells.items[0..0] });
        }
    }
};

pub const LayoutState = struct {
    width: u32 = 1,
    unmanaged_seed_rows: u32 = 0,
    total_wrapped_rows: u32 = 0,
    replay_wrapped_rows: u32 = 0,
    open_row_wrapped_rows: u32 = 0,
    tail_column: u32 = 0,
    open_row_active: bool = false,
    open_row_replayable: bool = false,
    open_row_has_content: bool = false,

    pub fn reset(self: *LayoutState, width: u32, seed_rows: u32) void {
        self.* = .{
            .width = safeWidth(width),
            .unmanaged_seed_rows = seed_rows,
            .total_wrapped_rows = seed_rows,
            .open_row_wrapped_rows = if (seed_rows > 0) 1 else 0,
            .open_row_active = seed_rows > 0,
        };
    }

    pub fn renderOffset(self: *const LayoutState, pinned_render_offset: u32) u32 {
        if (pinned_render_offset == 0) {
            return 0;
        }

        return @min(self.total_wrapped_rows, pinned_render_offset);
    }

    pub fn coverage(self: *const LayoutState, pinned_render_offset: u32) Coverage {
        const render_offset = self.renderOffset(pinned_render_offset);
        const covered_rows = @min(self.replay_wrapped_rows, render_offset);
        const uncovered_rows = render_offset - covered_rows;

        return .{
            .render_offset = render_offset,
            .covered_rows = covered_rows,
            .uncovered_rows = uncovered_rows,
            .fully_covered = covered_rows == render_offset,
            .partial_coverage = uncovered_rows > 0,
        };
    }

    pub fn addCommittedRow(self: *LayoutState, row: *const StoredRow) void {
        const metrics = row.metrics(self.width);
        self.total_wrapped_rows += metrics.wrapped_rows;
        self.replay_wrapped_rows += metrics.wrapped_rows;
    }

    pub fn setOpenRow(self: *LayoutState, row: *const StoredRow) void {
        const metrics = row.metrics(self.width);
        self.total_wrapped_rows += metrics.wrapped_rows;
        self.replay_wrapped_rows += metrics.wrapped_rows;
        self.open_row_wrapped_rows = metrics.wrapped_rows;
        self.tail_column = metrics.tail_column;
        self.open_row_active = true;
        self.open_row_replayable = true;
        self.open_row_has_content = metrics.has_content;
    }

    fn ensureOpenRow(self: *LayoutState) void {
        if (self.open_row_active) return;

        self.total_wrapped_rows += 1;
        self.replay_wrapped_rows += 1;
        self.open_row_wrapped_rows = 1;
        self.tail_column = 0;
        self.open_row_active = true;
        self.open_row_replayable = true;
        self.open_row_has_content = false;
    }

    fn startNextEmptyRow(self: *LayoutState) void {
        if (!self.open_row_active) {
            self.ensureOpenRow();
            return;
        }

        self.total_wrapped_rows += 1;
        self.replay_wrapped_rows += 1;
        self.open_row_wrapped_rows = 1;
        self.tail_column = 0;
        self.open_row_replayable = true;
        self.open_row_has_content = false;
        self.open_row_active = true;
    }

    fn advanceOpenRowByWidth(self: *LayoutState, item_width: u32) void {
        self.ensureOpenRow();

        const normalized_width = safeWidth(self.width);
        const clamped_width = @min(@max(item_width, @as(u32, 1)), normalized_width);

        if (self.open_row_has_content and self.tail_column + clamped_width > normalized_width) {
            self.total_wrapped_rows += 1;
            if (self.open_row_replayable) {
                self.replay_wrapped_rows += 1;
            }
            self.open_row_wrapped_rows += 1;
            self.tail_column = 0;
        }

        self.tail_column += clamped_width;
        self.open_row_has_content = true;
    }

    fn appendRowToOpen(self: *LayoutState, row: *const StoredRow) void {
        self.ensureOpenRow();
        if (row.cells.items.len == 0) {
            return;
        }

        var index: usize = 0;
        while (index < row.cells.items.len) {
            const cell = row.cells.items[index];
            if (gp.isContinuationChar(cell.char)) {
                index += 1;
                continue;
            }

            self.advanceOpenRowByWidth(gp.encodedCharWidth(cell.char));

            index += 1;
            while (index < row.cells.items.len and gp.isContinuationChar(row.cells.items[index].char)) : (index += 1) {}
        }
    }

    pub fn applyPendingCommit(self: *LayoutState, commit: *const PendingCommit) void {
        if (commit.start_on_new_line and self.open_row_active and (self.open_row_has_content or !self.open_row_replayable)) {
            self.startNextEmptyRow();
        }

        var row_index: usize = 0;
        while (row_index < commit.rows.items.len) : (row_index += 1) {
            if (row_index > 0) {
                self.startNextEmptyRow();
            }

            self.appendRowToOpen(&commit.rows.items[row_index]);
        }

        if (commit.trailing_newline) {
            if (!self.open_row_active) {
                self.ensureOpenRow();
            }
            self.startNextEmptyRow();
        }
    }
};

pub const PendingCommit = struct {
    rows: std.ArrayListUnmanaged(StoredRow) = .{},
    start_on_new_line: bool = false,
    trailing_newline: bool = false,

    pub fn deinit(
        self: *PendingCommit,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) void {
        for (self.rows.items) |*row| {
            row.deinit(allocator, grapheme_tracker, link_tracker);
        }

        self.rows.deinit(allocator);
        self.* = .{};
    }

    pub fn initFromSnapshot(
        allocator: Allocator,
        snapshot: *const buf.OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) !PendingCommit {
        var commit = PendingCommit{
            .start_on_new_line = start_on_new_line,
            .trailing_newline = trailing_newline,
        };
        errdefer commit.deinit(allocator, grapheme_tracker, link_tracker);

        const normalized_row_columns = @min(row_columns, snapshot.width);
        var row_index: u32 = 0;
        while (row_index < snapshot.height) : (row_index += 1) {
            var row = StoredRow{};
            errdefer row.deinit(allocator, grapheme_tracker, link_tracker);

            const row_end = snapshotRowEnd(snapshot, row_index, normalized_row_columns);
            try row.cloneFromSnapshotRow(
                allocator,
                snapshot,
                row_index,
                row_end,
                grapheme_tracker,
                link_tracker,
            );

            try commit.rows.append(allocator, row);
        }

        return commit;
    }
};

const Transcript = struct {
    committed_rows: std.ArrayListUnmanaged(StoredRow) = .{},
    open_row: StoredRow = .{},
    has_open_row: bool = false,
    has_unmanaged_seed_tail: bool = false,
    layout: LayoutState = .{},

    pub fn deinit(
        self: *Transcript,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) void {
        self.clear(allocator, grapheme_tracker, link_tracker);
        self.committed_rows.deinit(allocator);
    }

    fn clear(
        self: *Transcript,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) void {
        for (self.committed_rows.items) |*row| {
            row.deinit(allocator, grapheme_tracker, link_tracker);
        }
        self.committed_rows.items.len = 0;

        if (self.has_open_row) {
            self.open_row.deinit(allocator, grapheme_tracker, link_tracker);
            self.has_open_row = false;
        }

        self.has_unmanaged_seed_tail = false;
        self.open_row = .{};
    }

    pub fn reset(
        self: *Transcript,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
        width: u32,
        seed_rows: u32,
    ) void {
        self.clear(allocator, grapheme_tracker, link_tracker);
        self.has_unmanaged_seed_tail = seed_rows > 0;
        self.layout.reset(width, seed_rows);
    }

    pub fn syncLayout(self: *Transcript, width: u32, seed_rows: u32) void {
        self.layout.reset(width, seed_rows);
        for (self.committed_rows.items) |*row| {
            self.layout.addCommittedRow(row);
        }

        if (self.has_open_row) {
            self.layout.setOpenRow(&self.open_row);
        }
    }

    fn ensureOpenRow(self: *Transcript) void {
        if (self.has_open_row) return;
        self.open_row = .{};
        self.has_open_row = true;
    }

    fn closeOpenRowAndStartNewEmpty(self: *Transcript, allocator: Allocator) !void {
        self.ensureOpenRow();
        try self.committed_rows.append(allocator, self.open_row);
        self.open_row = .{};
        self.has_open_row = true;
    }

    fn appendStoredRowToOpen(
        self: *Transcript,
        allocator: Allocator,
        row: *const StoredRow,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
    ) !void {
        self.ensureOpenRow();
        try self.open_row.appendClonedRow(allocator, row, grapheme_tracker, link_tracker);
    }

    fn advanceToNextReplayableRow(self: *Transcript, allocator: Allocator) !void {
        if (self.has_unmanaged_seed_tail) {
            self.has_unmanaged_seed_tail = false;
            self.open_row = .{};
            self.has_open_row = true;
            return;
        }

        self.ensureOpenRow();
        try self.closeOpenRowAndStartNewEmpty(allocator);
    }

    pub fn applyPendingCommit(
        self: *Transcript,
        allocator: Allocator,
        grapheme_tracker: *gp.GraphemeTracker,
        link_tracker: *link.LinkTracker,
        commit: *const PendingCommit,
    ) !void {
        if (commit.start_on_new_line) {
            if (self.has_unmanaged_seed_tail or (self.has_open_row and !self.open_row.isEmpty())) {
                try self.advanceToNextReplayableRow(allocator);
            }
        }

        var row_index: usize = 0;
        if (self.has_unmanaged_seed_tail and !commit.start_on_new_line and commit.rows.items.len > 0) {
            row_index = 1;
            if (row_index < commit.rows.items.len) {
                try self.advanceToNextReplayableRow(allocator);
            }
        }

        while (row_index < commit.rows.items.len) : (row_index += 1) {
            if (row_index > 0 and !(self.has_open_row and self.open_row.isEmpty())) {
                try self.advanceToNextReplayableRow(allocator);
            }

            try self.appendStoredRowToOpen(allocator, &commit.rows.items[row_index], grapheme_tracker, link_tracker);
        }

        if (commit.trailing_newline) {
            try self.advanceToNextReplayableRow(allocator);
        }

        self.layout.applyPendingCommit(commit);
    }
};

pub const SplitScrollback = struct {
    base: Transcript = .{},
    predicted_layout: LayoutState = .{},
    pending: std.ArrayListUnmanaged(PendingCommit) = .{},
    grapheme_tracker: gp.GraphemeTracker,
    link_tracker: link.LinkTracker,
    width: u32 = 1,
    unmanaged_seed_rows: u32 = 0,
    replay_dirty: bool = false,

    pub fn init(allocator: Allocator, pool: *gp.GraphemePool, link_pool: *link.LinkPool) SplitScrollback {
        return .{
            .grapheme_tracker = gp.GraphemeTracker.init(allocator, pool),
            .link_tracker = link.LinkTracker.init(allocator, link_pool),
        };
    }

    pub fn deinit(self: *SplitScrollback, allocator: Allocator) void {
        self.clearPending(allocator);
        self.pending.deinit(allocator);
        self.base.deinit(allocator, &self.grapheme_tracker, &self.link_tracker);
        self.grapheme_tracker.deinit();
        self.link_tracker.deinit();
    }

    fn clearPending(self: *SplitScrollback, allocator: Allocator) void {
        for (self.pending.items) |*commit| {
            commit.deinit(allocator, &self.grapheme_tracker, &self.link_tracker);
        }
        self.pending.items.len = 0;
    }

    fn rebuildPredictedLayout(self: *SplitScrollback) void {
        self.predicted_layout = self.base.layout;
        for (self.pending.items) |*commit| {
            self.predicted_layout.applyPendingCommit(commit);
        }
    }

    pub fn reset(self: *SplitScrollback, allocator: Allocator, seed_rows: u32, width: u32) void {
        self.width = safeWidth(width);
        self.unmanaged_seed_rows = seed_rows;
        self.clearPending(allocator);
        self.base.reset(allocator, &self.grapheme_tracker, &self.link_tracker, self.width, seed_rows);
        self.predicted_layout = self.base.layout;
        self.replay_dirty = false;
    }

    pub fn reseed(self: *SplitScrollback, seed_rows: u32, width: u32) void {
        self.width = safeWidth(width);
        self.unmanaged_seed_rows = seed_rows;
        self.base.syncLayout(self.width, seed_rows);
        self.rebuildPredictedLayout();
        self.replay_dirty = true;
    }

    pub fn syncLayout(self: *SplitScrollback, width: u32) void {
        self.width = safeWidth(width);
        self.base.syncLayout(self.width, self.unmanaged_seed_rows);
        self.rebuildPredictedLayout();
        self.replay_dirty = true;
    }

    pub fn markReplayDirty(self: *SplitScrollback) void {
        self.replay_dirty = true;
    }

    pub fn clearReplayDirty(self: *SplitScrollback) void {
        self.replay_dirty = false;
    }

    pub fn tailColumn(self: *const SplitScrollback) u32 {
        return self.predicted_layout.tail_column;
    }

    pub fn renderOffset(self: *const SplitScrollback, pinned_render_offset: u32) u32 {
        return self.base.layout.renderOffset(pinned_render_offset);
    }

    pub fn predictedRenderOffset(self: *const SplitScrollback, pinned_render_offset: u32) u32 {
        return self.predicted_layout.renderOffset(pinned_render_offset);
    }

    pub fn coverage(self: *const SplitScrollback, pinned_render_offset: u32) Coverage {
        return self.base.layout.coverage(pinned_render_offset);
    }

    pub fn pendingCount(self: *const SplitScrollback) u32 {
        return @intCast(self.pending.items.len);
    }

    pub fn enqueueSnapshot(
        self: *SplitScrollback,
        allocator: Allocator,
        snapshot: *const buf.OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
    ) !void {
        var commit = try PendingCommit.initFromSnapshot(
            allocator,
            snapshot,
            row_columns,
            start_on_new_line,
            trailing_newline,
            &self.grapheme_tracker,
            &self.link_tracker,
        );
        errdefer commit.deinit(allocator, &self.grapheme_tracker, &self.link_tracker);

        try self.pending.append(allocator, commit);
        self.predicted_layout.applyPendingCommit(&self.pending.items[self.pending.items.len - 1]);
    }

    pub fn applyPendingPrefixToBase(self: *SplitScrollback, allocator: Allocator, count: usize) !void {
        const actual = @min(count, self.pending.items.len);
        var index: usize = 0;
        while (index < actual) : (index += 1) {
            try self.base.applyPendingCommit(
                allocator,
                &self.grapheme_tracker,
                &self.link_tracker,
                &self.pending.items[index],
            );
        }
    }

    pub fn removePendingPrefix(self: *SplitScrollback, allocator: Allocator, count: usize) void {
        const actual = @min(count, self.pending.items.len);
        if (actual == 0) return;

        for (self.pending.items[0..actual]) |*commit| {
            commit.deinit(allocator, &self.grapheme_tracker, &self.link_tracker);
        }

        if (actual < self.pending.items.len) {
            std.mem.copyForwards(
                PendingCommit,
                self.pending.items[0 .. self.pending.items.len - actual],
                self.pending.items[actual..],
            );
        }

        self.pending.items.len -= actual;
    }

    fn appendLastWrappedSlicesFromRow(
        self: *const SplitScrollback,
        allocator: Allocator,
        reversed_slices: *std.ArrayListUnmanaged(RowSlice),
        row: *const StoredRow,
        remaining_rows: u32,
    ) !u32 {
        var row_slices: std.ArrayListUnmanaged(RowSlice) = .{};
        defer row_slices.deinit(allocator);

        try row.appendWrappedSlices(allocator, self.width, &row_slices);
        if (row_slices.items.len == 0) {
            return 0;
        }

        const take = @min(remaining_rows, @as(u32, @intCast(row_slices.items.len)));
        var offset: usize = 0;
        while (offset < @as(usize, @intCast(take))) : (offset += 1) {
            const slice_index = row_slices.items.len - 1 - offset;
            try reversed_slices.append(allocator, row_slices.items[slice_index]);
        }

        return take;
    }

    pub fn collectBaseVisibleTailSlices(
        self: *const SplitScrollback,
        allocator: Allocator,
        visible_rows: u32,
    ) !std.ArrayListUnmanaged(RowSlice) {
        var reversed_slices: std.ArrayListUnmanaged(RowSlice) = .{};
        errdefer reversed_slices.deinit(allocator);

        var remaining_rows = visible_rows;

        if (remaining_rows > 0 and self.base.has_open_row) {
            const taken = try self.appendLastWrappedSlicesFromRow(
                allocator,
                &reversed_slices,
                &self.base.open_row,
                remaining_rows,
            );
            remaining_rows -= taken;
        }

        var row_index = self.base.committed_rows.items.len;
        while (remaining_rows > 0 and row_index > 0) {
            row_index -= 1;
            const taken = try self.appendLastWrappedSlicesFromRow(
                allocator,
                &reversed_slices,
                &self.base.committed_rows.items[row_index],
                remaining_rows,
            );
            remaining_rows -= taken;
        }

        var left: usize = 0;
        var right: usize = reversed_slices.items.len;
        while (left < right) {
            right -= 1;
            if (left >= right) break;

            const tmp = reversed_slices.items[left];
            reversed_slices.items[left] = reversed_slices.items[right];
            reversed_slices.items[right] = tmp;
            left += 1;
        }

        return reversed_slices;
    }
};
