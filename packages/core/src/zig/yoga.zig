const std = @import("std");

const root_module = @import("root");
const allocator = if (@hasDecl(root_module, "globalAllocator")) root_module.globalAllocator else std.testing.allocator;
const nan = std.math.nan(f32);

pub const YogaEnumKind = enum(u32) {
    direction = 0,
    flex_direction = 1,
    justify_content = 2,
    align_content = 3,
    align_items = 4,
    align_self = 5,
    position_type = 6,
    flex_wrap = 7,
    overflow = 8,
    display = 9,
    box_sizing = 10,
};

pub const YogaFloatKind = enum(u32) {
    flex = 0,
    flex_grow = 1,
    flex_shrink = 2,
    aspect_ratio = 3,
};

pub const YogaValueKind = enum(u32) {
    width = 0,
    height = 1,
    min_width = 2,
    min_height = 3,
    max_width = 4,
    max_height = 5,
    flex_basis = 6,
    margin = 7,
    padding = 8,
    position = 9,
    gap = 10,
};

pub const YogaEdgeLayoutKind = enum(u32) {
    margin = 0,
    padding = 1,
    border = 2,
};

pub const Direction = enum(u32) {
    inherit = 0,
    ltr = 1,
    rtl = 2,
};

pub const FlexDirection = enum(u32) {
    column = 0,
    column_reverse = 1,
    row = 2,
    row_reverse = 3,
};

pub const Justify = enum(u32) {
    flex_start = 0,
    center = 1,
    flex_end = 2,
    space_between = 3,
    space_around = 4,
    space_evenly = 5,
};

pub const Align = enum(u32) {
    auto = 0,
    flex_start = 1,
    center = 2,
    flex_end = 3,
    stretch = 4,
    baseline = 5,
    space_between = 6,
    space_around = 7,
    space_evenly = 8,
};

pub const PositionType = enum(u32) {
    static = 0,
    relative = 1,
    absolute = 2,
};

pub const Wrap = enum(u32) {
    no_wrap = 0,
    wrap = 1,
    wrap_reverse = 2,
};

pub const Overflow = enum(u32) {
    visible = 0,
    hidden = 1,
    scroll = 2,
};

pub const Display = enum(u32) {
    flex = 0,
    none = 1,
    contents = 2,
};

pub const BoxSizing = enum(u32) {
    border_box = 0,
    content_box = 1,
};

pub const Unit = enum(u32) {
    undefined = 0,
    point = 1,
    percent = 2,
    auto = 3,
};

pub const Edge = enum(u32) {
    left = 0,
    top = 1,
    right = 2,
    bottom = 3,
    start = 4,
    end = 5,
    horizontal = 6,
    vertical = 7,
    all = 8,
};

pub const Gutter = enum(u32) {
    column = 0,
    row = 1,
    all = 2,
};

pub const MeasureMode = enum(u32) {
    undefined = 0,
    exactly = 1,
    at_most = 2,
};

pub const ExternalYogaLayout = extern struct {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    width: f32,
    height: f32,
};

const Size = struct {
    width: f32 = 0,
    height: f32 = 0,
};

const Rect = struct {
    left: f32 = 0,
    top: f32 = 0,
    right: f32 = 0,
    bottom: f32 = 0,
};

const StyleValue = extern struct {
    value: f32,
    unit: Unit,

    fn undef() StyleValue {
        return .{ .value = nan, .unit = .undefined };
    }

    fn auto() StyleValue {
        return .{ .value = nan, .unit = .auto };
    }

    fn point(value: f32) StyleValue {
        return .{ .value = value, .unit = .point };
    }

    fn percent(value: f32) StyleValue {
        return .{ .value = value, .unit = .percent };
    }

    fn eql(self: StyleValue, other: StyleValue) bool {
        if (self.unit != other.unit) return false;
        if (std.math.isNan(self.value) and std.math.isNan(other.value)) return true;
        return self.value == other.value;
    }
};

const Style = struct {
    direction: Direction = .inherit,
    flex_direction: FlexDirection = .column,
    justify_content: Justify = .flex_start,
    align_content: Align = .flex_start,
    align_items: Align = .stretch,
    align_self: Align = .auto,
    position_type: PositionType = .relative,
    flex_wrap: Wrap = .no_wrap,
    overflow: Overflow = .visible,
    display: Display = .flex,
    box_sizing: BoxSizing = .border_box,

    flex: f32 = nan,
    flex_grow: f32 = 0,
    flex_shrink: f32 = 0,
    aspect_ratio: f32 = nan,

    width: StyleValue = StyleValue.auto(),
    height: StyleValue = StyleValue.auto(),
    min_width: StyleValue = StyleValue.undef(),
    min_height: StyleValue = StyleValue.undef(),
    max_width: StyleValue = StyleValue.undef(),
    max_height: StyleValue = StyleValue.undef(),
    flex_basis: StyleValue = StyleValue.auto(),
    margin: [9]StyleValue = [_]StyleValue{StyleValue.undef()} ** 9,
    padding: [9]StyleValue = [_]StyleValue{StyleValue.undef()} ** 9,
    position: [9]StyleValue = [_]StyleValue{StyleValue.undef()} ** 9,
    border: [9]f32 = [_]f32{nan} ** 9,
    gap: [3]StyleValue = [_]StyleValue{StyleValue.undef()} ** 3,

    has_min_max_values: bool = false,
    has_margin_values: bool = false,
    has_padding_values: bool = false,
    has_position_values: bool = false,
    has_border_values: bool = false,
    has_gap_values: bool = false,
};

const Layout = struct {
    left: f32 = 0,
    top: f32 = 0,
    right: f32 = 0,
    bottom: f32 = 0,
    width: f32 = 0,
    height: f32 = 0,
    margin: Rect = .{},
    padding: Rect = .{},
    border: Rect = .{},
};

const Config = struct {
    use_web_defaults: bool = false,
    point_scale_factor: f32 = 1,
    errata: u32 = 0,
    experimental_features: u32 = 0,
};

const JsMeasureCallback = *const fn (?*anyopaque, f32, u32, f32, u32) callconv(.c) void;
const JsDirtiedCallback = *const fn () callconv(.c) void;

threadlocal var current_layout_generation: u64 = 0;
threadlocal var current_root_direction: Direction = .ltr;

const Node = struct {
    config: ?*const Config = null,
    parent: ?*Node = null,
    children: std.ArrayListUnmanaged(*Node) = .{},
    style: Style = .{},
    layout: Layout = .{},
    dirty: bool = true,
    self_dirty: bool = true,
    style_dirty: bool = true,
    dirty_child_count: u32 = 0,
    dirty_child: ?*Node = null,
    has_new_layout: bool = true,
    is_reference_baseline: bool = false,
    always_forms_containing_block: bool = false,
    measure_callback: ?*const anyopaque = null,
    dirtied_callback: ?*const anyopaque = null,
    dirtied_notified: bool = false,
    has_measure_subtree: bool = false,
    has_absolute_subtree: bool = false,
    needs_round: bool = true,
    has_round_subtree: bool = false,
    has_cached_layout: bool = false,
    has_cached_base_size: bool = false,
    cached_assigned_width: f32 = nan,
    cached_assigned_height: f32 = nan,
    cached_owner_width: f32 = nan,
    cached_owner_height: f32 = nan,
    cached_direction: Direction = .ltr,
    cached_generation: u64 = 0,
    cached_base_owner_width: f32 = nan,
    cached_base_owner_height: f32 = nan,
    cached_base_direction: Direction = .ltr,
    cached_base_width: f32 = 0,
    cached_base_height: f32 = 0,
    containing_width: f32 = 0,
    containing_height: f32 = 0,

    fn deinit(self: *Node) void {
        self.children.deinit(allocator);
    }
};

const LineItem = struct {
    node: *Node,
    base_width: f32,
    base_height: f32,
    flex_base_main: f32,
    target_width: f32,
    target_height: f32,
    margin: Rect,
    margin_left_auto: bool,
    margin_right_auto: bool,
    margin_top_auto: bool,
    margin_bottom_auto: bool,
    outer_main: f32,
    outer_cross: f32,
    flex_grow: f32,
    flex_shrink: f32,
    has_explicit_width: bool,
    has_explicit_height: bool,
    frozen: bool = false,
    violation: f32 = 0,
};

const FlexLine = struct {
    start: usize,
    end: usize,
    main: f32,
    cross: f32,
    grow: f32,
    shrink: f32,
};

const JustifyLayout = struct {
    offset: f32,
    gap: f32,
};

const STACK_FLEX_ITEMS = 128;
const TLS_FLEX_ITEMS = 512;
const F32x4 = @Vector(4, f32);

threadlocal var tls_flex_items: [TLS_FLEX_ITEMS]LineItem = undefined;
threadlocal var tls_flex_lines: [TLS_FLEX_ITEMS]FlexLine = undefined;
threadlocal var tls_measure_width: f32 = 0;
threadlocal var tls_measure_height: f32 = 0;

fn enumValue(value: anytype) u32 {
    return @intFromEnum(value);
}

fn nonNan(value: f32, fallback: f32) f32 {
    return if (std.math.isNan(value)) fallback else value;
}

fn isDefined(value: StyleValue) bool {
    return value.unit != .undefined;
}

fn isConcrete(value: StyleValue) bool {
    return value.unit == .point or value.unit == .percent;
}

fn optionalSize(value: f32) ?f32 {
    return if (std.math.isNan(value)) null else value;
}

fn optionalToFloat(value: ?f32) f32 {
    return value orelse nan;
}

fn cachedFloatEqual(left: f32, right: f32) bool {
    if (std.math.isNan(left) and std.math.isNan(right)) return true;
    return left == right;
}

fn styleFloatEqual(left: f32, right: f32) bool {
    return cachedFloatEqual(left, right);
}

fn cachedConstraintsMatch(node: *const Node, assigned_width: f32, assigned_height: f32, owner_width: f32, owner_height: f32, direction: Direction) bool {
    return node.has_cached_layout and cachedConstraintValuesMatch(node, assigned_width, assigned_height, owner_width, owner_height, direction);
}

fn cachedConstraintValuesMatch(node: *const Node, assigned_width: f32, assigned_height: f32, owner_width: f32, owner_height: f32, direction: Direction) bool {
    return node.cached_generation != 0 and
        cachedFloatEqual(node.cached_assigned_width, assigned_width) and
        cachedFloatEqual(node.cached_assigned_height, assigned_height) and
        cachedFloatEqual(node.cached_owner_width, owner_width) and
        cachedFloatEqual(node.cached_owner_height, owner_height) and
        node.cached_direction == direction;
}

fn cachedColumnFlowInputsMatch(node: *const Node, assigned_width: f32, owner_width: f32, _: f32, direction: Direction) bool {
    const assigned_width_matches = std.math.isNan(assigned_width) or cachedFloatEqual(node.layout.width, assigned_width);
    return node.cached_generation != 0 and
        assigned_width_matches and
        cachedFloatEqual(node.cached_owner_width, owner_width) and
        node.cached_direction == direction;
}

fn cachedBaseSizeMatch(node: *const Node, owner_width: f32, owner_height: f32, direction: Direction) bool {
    return node.has_cached_base_size and cachedBaseSizeValuesMatch(node, owner_width, owner_height, direction);
}

fn cachedBaseSizeValuesMatch(node: *const Node, owner_width: f32, owner_height: f32, direction: Direction) bool {
    return node.cached_generation != 0 and
        cachedFloatEqual(node.cached_base_owner_width, owner_width) and
        cachedFloatEqual(node.cached_base_owner_height, owner_height) and
        node.cached_base_direction == direction;
}

fn cacheBaseSize(node: *Node, owner_width: f32, owner_height: f32, direction: Direction, size: Size) Size {
    node.cached_base_owner_width = owner_width;
    node.cached_base_owner_height = owner_height;
    node.cached_base_direction = direction;
    node.cached_base_width = size.width;
    node.cached_base_height = size.height;
    node.has_cached_base_size = true;
    return size;
}

fn optionalFromCached(value: f32) ?f32 {
    return if (std.math.isNan(value)) null else value;
}

fn resolveValue(value: StyleValue, owner_size: ?f32) ?f32 {
    return switch (value.unit) {
        .point => value.value,
        .percent => if (owner_size) |size| size * value.value / 100 else null,
        .auto, .undefined => null,
    };
}

fn resolveValueOrZero(value: StyleValue, owner_size: ?f32) f32 {
    return resolveValue(value, owner_size) orelse 0;
}

fn edgeIndex(edge: Edge) usize {
    return @intFromEnum(edge);
}

fn gutterIndex(gutter: Gutter) usize {
    return @intFromEnum(gutter);
}

fn edgeValue(values: *const [9]StyleValue, edge: Edge, direction: Direction) StyleValue {
    switch (edge) {
        .left => {
            const logical = values[edgeIndex(if (direction == .rtl) Edge.end else Edge.start)];
            if (isDefined(logical)) return logical;
            const specific = values[edgeIndex(edge)];
            if (isDefined(specific)) return specific;
            const horizontal = values[edgeIndex(.horizontal)];
            if (isDefined(horizontal)) return horizontal;
        },
        .right => {
            const logical = values[edgeIndex(if (direction == .rtl) Edge.start else Edge.end)];
            if (isDefined(logical)) return logical;
            const specific = values[edgeIndex(edge)];
            if (isDefined(specific)) return specific;
            const horizontal = values[edgeIndex(.horizontal)];
            if (isDefined(horizontal)) return horizontal;
        },
        .top, .bottom => {
            const specific = values[edgeIndex(edge)];
            if (isDefined(specific)) return specific;
            const vertical = values[edgeIndex(.vertical)];
            if (isDefined(vertical)) return vertical;
        },
        .start => {
            const physical = values[edgeIndex(if (direction == .rtl) Edge.right else Edge.left)];
            if (isDefined(physical)) return physical;
        },
        .end => {
            const physical = values[edgeIndex(if (direction == .rtl) Edge.left else Edge.right)];
            if (isDefined(physical)) return physical;
        },
        .horizontal, .vertical, .all => {},
    }

    const all = values[edgeIndex(.all)];
    if (isDefined(all)) return all;
    return StyleValue.undef();
}

fn edgeBorder(values: *const [9]f32, edge: Edge, direction: Direction) f32 {
    const specific = values[edgeIndex(edge)];
    if (!std.math.isNan(specific)) return specific;

    switch (edge) {
        .left => {
            const logical = values[edgeIndex(if (direction == .rtl) Edge.end else Edge.start)];
            if (!std.math.isNan(logical)) return logical;
            const horizontal = values[edgeIndex(.horizontal)];
            if (!std.math.isNan(horizontal)) return horizontal;
        },
        .right => {
            const logical = values[edgeIndex(if (direction == .rtl) Edge.start else Edge.end)];
            if (!std.math.isNan(logical)) return logical;
            const horizontal = values[edgeIndex(.horizontal)];
            if (!std.math.isNan(horizontal)) return horizontal;
        },
        .top, .bottom => {
            const vertical = values[edgeIndex(.vertical)];
            if (!std.math.isNan(vertical)) return vertical;
        },
        else => {},
    }

    const all = values[edgeIndex(.all)];
    return nonNan(all, 0);
}

fn styleValuesAllUndefined(values: *const [9]StyleValue) bool {
    inline for (0..9) |index| {
        if (values[index].unit != .undefined) return false;
    }
    return true;
}

fn borderValuesAllUndefined(values: *const [9]f32) bool {
    inline for (0..9) |index| {
        if (!std.math.isNan(values[index])) return false;
    }
    return true;
}

fn gapValuesAllUndefined(values: *const [3]StyleValue) bool {
    inline for (0..3) |index| {
        if (values[index].unit != .undefined) return false;
    }
    return true;
}

fn refreshStyleValueFlags(style: *Style, value_kind: YogaValueKind) void {
    switch (value_kind) {
        .min_width, .min_height, .max_width, .max_height => {
            style.has_min_max_values = isDefined(style.min_width) or
                isDefined(style.min_height) or
                isDefined(style.max_width) or
                isDefined(style.max_height);
        },
        .margin => style.has_margin_values = !styleValuesAllUndefined(&style.margin),
        .padding => style.has_padding_values = !styleValuesAllUndefined(&style.padding),
        .position => style.has_position_values = !styleValuesAllUndefined(&style.position),
        .gap => style.has_gap_values = !gapValuesAllUndefined(&style.gap),
        .width, .height, .flex_basis => {},
    }
}

fn resolveRect(values: *const [9]StyleValue, width_owner: ?f32, height_owner: ?f32, direction: Direction) Rect {
    if (styleValuesAllUndefined(values)) return .{};
    return .{
        .left = resolveValueOrZero(edgeValue(values, .left, direction), width_owner),
        .right = resolveValueOrZero(edgeValue(values, .right, direction), width_owner),
        .top = resolveValueOrZero(edgeValue(values, .top, direction), height_owner),
        .bottom = resolveValueOrZero(edgeValue(values, .bottom, direction), height_owner),
    };
}

fn resolveSpacingRect(values: *const [9]StyleValue, owner_width: ?f32, direction: Direction) Rect {
    if (styleValuesAllUndefined(values)) return .{};
    return .{
        .left = resolveValueOrZero(edgeValue(values, .left, direction), owner_width),
        .right = resolveValueOrZero(edgeValue(values, .right, direction), owner_width),
        .top = resolveValueOrZero(edgeValue(values, .top, direction), owner_width),
        .bottom = resolveValueOrZero(edgeValue(values, .bottom, direction), owner_width),
    };
}

fn resolveBorderRect(values: *const [9]f32, direction: Direction) Rect {
    if (borderValuesAllUndefined(values)) return .{};
    return .{
        .left = edgeBorder(values, .left, direction),
        .right = edgeBorder(values, .right, direction),
        .top = edgeBorder(values, .top, direction),
        .bottom = edgeBorder(values, .bottom, direction),
    };
}

fn rectHorizontal(rect: Rect) f32 {
    return rect.left + rect.right;
}

fn rectVertical(rect: Rect) f32 {
    return rect.top + rect.bottom;
}

fn rectEqual(left: Rect, right: Rect) bool {
    return left.left == right.left and left.top == right.top and left.right == right.right and left.bottom == right.bottom;
}

fn updateContainingBlock(node: *Node, width: f32, height: f32) void {
    if (node.style.position_type == .static) {
        if (node.parent) |parent| {
            node.containing_width = parent.containing_width;
            node.containing_height = parent.containing_height;
            return;
        }
    }

    node.containing_width = @max(0, width - rectHorizontal(node.layout.border));
    node.containing_height = @max(0, height - rectVertical(node.layout.border));
}

fn resolveGap(style: *const Style, gutter: Gutter, owner_size: ?f32) f32 {
    if (!style.has_gap_values) return 0;
    const specific = style.gap[gutterIndex(gutter)];
    if (isDefined(specific)) return resolveValueOrZero(specific, owner_size);
    const all = style.gap[gutterIndex(.all)];
    return resolveValueOrZero(all, owner_size);
}

fn gapIsOwnerIndependent(style: *const Style, gutter: Gutter) bool {
    if (!style.has_gap_values) return true;
    const specific = style.gap[gutterIndex(gutter)];
    if (isDefined(specific)) return specific.unit != .percent;
    return style.gap[gutterIndex(.all)].unit != .percent;
}

fn clampDimension(value: f32, min_value: StyleValue, max_value: StyleValue, owner_size: ?f32) f32 {
    var result = @max(0, nonNan(value, 0));
    if (resolveValue(min_value, owner_size)) |min_resolved| {
        result = @max(result, min_resolved);
    }
    if (resolveValue(max_value, owner_size)) |max_resolved| {
        result = @min(result, max_resolved);
    }
    return result;
}

fn styleMinMaxAllUndefined(style: *const Style) bool {
    return !style.has_min_max_values;
}

fn clampNodeSize(node: *const Node, size: Size, owner_width: ?f32, owner_height: ?f32, direction: Direction) Size {
    if (styleMinMaxAllUndefined(&node.style)) {
        return .{ .width = @max(0, nonNan(size.width, 0)), .height = @max(0, nonNan(size.height, 0)) };
    }

    const min_width = if (outerDimensionFromStyle(node, node.style.min_width, owner_width, owner_width, owner_height, direction, true)) |value| StyleValue.point(value) else StyleValue.undef();
    const min_height = if (outerDimensionFromStyle(node, node.style.min_height, owner_height, owner_width, owner_height, direction, false)) |value| StyleValue.point(value) else StyleValue.undef();
    const max_width = if (outerDimensionFromStyle(node, node.style.max_width, owner_width, owner_width, owner_height, direction, true)) |value| StyleValue.point(value) else StyleValue.undef();
    const max_height = if (outerDimensionFromStyle(node, node.style.max_height, owner_height, owner_width, owner_height, direction, false)) |value| StyleValue.point(value) else StyleValue.undef();
    return .{
        .width = clampDimension(size.width, min_width, max_width, null),
        .height = clampDimension(size.height, min_height, max_height, null),
    };
}

fn packValue(value: StyleValue) u64 {
    const unit_bits: u32 = @intFromEnum(value.unit);
    const value_bits: u32 = @bitCast(value.value);
    return (@as(u64, value_bits) << 32) | @as(u64, unit_bits);
}

fn markDirtyFromChild(node: *Node, child: *Node) void {
    node.dirty_child_count +|= 1;
    node.dirty_child = if (node.dirty_child_count == 1) child else null;

    const was_dirty = node.dirty;
    node.dirty = true;
    if (node.has_measure_subtree) node.has_cached_layout = false;
    node.has_cached_base_size = false;

    if (!node.dirtied_notified) {
        if (node.dirtied_callback) |callback| {
            const trampoline: JsDirtiedCallback = @ptrCast(@alignCast(callback));
            trampoline();
        }
        node.dirtied_notified = true;
    }

    if (!was_dirty) {
        if (node.parent) |parent| {
            markDirtyFromChild(parent, node);
        }
    }
}

fn markDirtyInternal(node: *Node, style_dirty: bool) void {
    const was_dirty = node.dirty;
    node.dirty = true;
    node.self_dirty = true;
    node.style_dirty = node.style_dirty or style_dirty;
    if (node.has_measure_subtree) node.has_cached_layout = false;
    node.has_cached_base_size = false;

    if (!node.dirtied_notified) {
        if (node.dirtied_callback) |callback| {
            const trampoline: JsDirtiedCallback = @ptrCast(@alignCast(callback));
            trampoline();
        }
        node.dirtied_notified = true;
    }

    if (!was_dirty) {
        if (node.parent) |parent| {
            markDirtyFromChild(parent, node);
        }
    }
}

fn markDirty(node: *Node) void {
    markDirtyInternal(node, true);
}

fn markMeasureDirty(node: *Node) void {
    markDirtyInternal(node, false);
}

fn markRoundDirty(node: *Node) void {
    node.needs_round = true;
    node.has_new_layout = true;
    var current = node.parent;
    while (current) |parent| {
        if (parent.has_round_subtree) return;
        parent.has_round_subtree = true;
        current = parent.parent;
    }
}

fn layoutValuesChanged(layout: Layout, left: f32, top: f32, right: f32, bottom: f32, width: f32, height: f32) bool {
    return layout.left != left or layout.top != top or layout.right != right or layout.bottom != bottom or layout.width != width or layout.height != height;
}

fn markDirtyWithoutCallback(node: *Node, style_dirty: bool) void {
    const was_dirty = node.dirty;
    node.dirty = true;
    node.self_dirty = true;
    node.style_dirty = node.style_dirty or style_dirty;
    if (node.has_measure_subtree) node.has_cached_layout = false;
    node.has_cached_base_size = false;
    if (!was_dirty) {
        if (node.parent) |parent| markDirtyFromChild(parent, node);
    }
}

fn markCleanRecursive(node: *Node) void {
    node.dirty = false;
    node.self_dirty = false;
    node.style_dirty = false;
    node.dirty_child_count = 0;
    node.dirty_child = null;
    node.dirtied_notified = false;
    node.has_new_layout = true;
    for (node.children.items) |child| {
        markCleanRecursive(child);
    }
}

fn markCleanDirtyRecursive(node: *Node) void {
    if (!node.dirty) return;
    node.dirty = false;
    node.self_dirty = false;
    node.style_dirty = false;
    node.dirty_child_count = 0;
    node.dirty_child = null;
    node.dirtied_notified = false;
    node.has_new_layout = true;
    for (node.children.items) |child| {
        markCleanDirtyRecursive(child);
    }
}

fn markDirtyRecursiveNoCallback(node: *Node) void {
    node.dirty = true;
    node.self_dirty = true;
    node.style_dirty = true;
    node.dirty_child_count = 0;
    node.dirty_child = null;
    if (node.has_measure_subtree) node.has_cached_layout = false;
    node.has_cached_base_size = false;
    for (node.children.items) |child| markDirtyRecursiveNoCallback(child);
}

fn zeroLayoutRecursive(node: *Node) void {
    if (layoutValuesChanged(node.layout, 0, 0, 0, 0, 0, 0)) markRoundDirty(node);
    node.layout = .{};
    for (node.children.items) |child| {
        zeroLayoutRecursive(child);
    }
}

fn freeRecursiveInternal(node: *Node) void {
    var index = node.children.items.len;
    while (index > 0) {
        index -= 1;
        freeRecursiveInternal(node.children.items[index]);
    }
    node.deinit();
    allocator.destroy(node);
}

fn refreshMeasureSubtreeUpwards(start: *Node) void {
    var current: ?*Node = start;
    while (current) |node| {
        var has_measure = node.measure_callback != null;
        for (node.children.items) |child| {
            has_measure = has_measure or child.has_measure_subtree;
        }
        if (node.has_measure_subtree == has_measure) {
            if (node.parent == null) return;
        }
        node.has_measure_subtree = has_measure;
        current = node.parent;
    }
}

fn refreshAbsoluteSubtreeUpwards(start: *Node) void {
    var current: ?*Node = start;
    while (current) |node| {
        var has_absolute = false;
        for (node.children.items) |child| {
            has_absolute = has_absolute or child.style.position_type == .absolute or child.has_absolute_subtree;
        }
        if (node.has_absolute_subtree == has_absolute) {
            if (node.parent == null) return;
        }
        node.has_absolute_subtree = has_absolute;
        current = node.parent;
    }
}

fn refreshAbsoluteFromNode(node: *Node) void {
    if (node.parent) |parent| {
        refreshAbsoluteSubtreeUpwards(parent);
    } else {
        refreshAbsoluteSubtreeUpwards(node);
    }
}

fn callMeasure(node: *const Node, width: f32, width_mode: MeasureMode, height: f32, height_mode: MeasureMode) Size {
    tls_measure_width = nan;
    tls_measure_height = nan;

    if (node.measure_callback) |callback| {
        const trampoline: JsMeasureCallback = @ptrCast(@alignCast(callback));
        trampoline(null, width, enumValue(width_mode), height, enumValue(height_mode));
    }

    return .{ .width = tls_measure_width, .height = tls_measure_height };
}

fn measureLeaf(node: *const Node, width: ?f32, height: ?f32, owner_width: ?f32, owner_height: ?f32) Size {
    const max_width = resolveValue(node.style.max_width, owner_width);
    const max_height = resolveValue(node.style.max_height, owner_height);
    const width_constraint = width orelse max_width orelse owner_width;
    const height_constraint = height orelse max_height orelse owner_height;
    const width_mode: MeasureMode = if (width) |_| .exactly else if (width_constraint) |_| .at_most else .undefined;
    const height_mode: MeasureMode = if (height) |_| .exactly else if (height_constraint) |_| .at_most else .undefined;
    const measure_width = width_constraint orelse nan;
    const measure_height = height_constraint orelse nan;
    const measured = callMeasure(node, measure_width, width_mode, measure_height, height_mode);

    var result = Size{
        .width = width orelse nonNan(measured.width, if (width_mode == .undefined) 0 else measure_width),
        .height = height orelse nonNan(measured.height, 0),
    };
    result = clampNodeSize(node, result, owner_width, owner_height, .ltr);
    return result;
}

fn hasStyleWidth(node: *const Node) bool {
    return isConcrete(node.style.width);
}

fn hasStyleHeight(node: *const Node) bool {
    return isConcrete(node.style.height);
}

fn outerDimensionFromStyle(node: *const Node, value: StyleValue, owner_size: ?f32, owner_width: ?f32, _: ?f32, direction: Direction, is_width: bool) ?f32 {
    const resolved = resolveValue(value, owner_size) orelse return null;
    if (!node.style.has_padding_values and !node.style.has_border_values) {
        return if (node.style.box_sizing == .content_box) resolved else @max(resolved, 0);
    }
    const padding = resolveSpacingRect(&node.style.padding, owner_width orelse resolved, direction);
    const border = resolveBorderRect(&node.style.border, direction);
    const chrome = if (is_width) rectHorizontal(padding) + rectHorizontal(border) else rectVertical(padding) + rectVertical(border);
    return if (node.style.box_sizing == .content_box) resolved + chrome else @max(resolved, chrome);
}

fn nodeOuterWidthFromStyle(node: *const Node, owner_width: ?f32, owner_height: ?f32, direction: Direction) ?f32 {
    return outerDimensionFromStyle(node, node.style.width, owner_width, owner_width, owner_height, direction, true);
}

fn nodeOuterHeightFromStyle(node: *const Node, owner_width: ?f32, owner_height: ?f32, direction: Direction) ?f32 {
    return outerDimensionFromStyle(node, node.style.height, owner_height, owner_width, owner_height, direction, false);
}

fn baseSize(node: *Node, owner_width: ?f32, owner_height: ?f32, direction: Direction) Size {
    if (node.style.display == .none) return .{};

    const owner_width_value = optionalToFloat(owner_width);
    const owner_height_value = optionalToFloat(owner_height);
    if (!node.dirty and cachedBaseSizeMatch(node, owner_width_value, owner_height_value, direction)) {
        return .{ .width = node.cached_base_width, .height = node.cached_base_height };
    }

    var width = nodeOuterWidthFromStyle(node, owner_width, owner_height, direction);
    var height = nodeOuterHeightFromStyle(node, owner_width, owner_height, direction);

    if (node.measure_callback != null) {
        if (nonNan(node.style.flex_grow, 0) > 0 and nonNan(node.style.flex_shrink, 0) > 0 and width == null and height == null) {
            return cacheBaseSize(node, owner_width_value, owner_height_value, direction, .{});
        }
        return cacheBaseSize(node, owner_width_value, owner_height_value, direction, measureLeaf(node, width, height, owner_width, owner_height));
    }

    if (width != null and height != null) {
        return cacheBaseSize(node, owner_width_value, owner_height_value, direction, clampNodeSize(node, .{ .width = width.?, .height = height.? }, owner_width, owner_height, direction));
    }

    if (node.children.items.len == 0) {
        const padding = if (node.style.has_padding_values) resolveSpacingRect(&node.style.padding, owner_width orelse width, direction) else Rect{};
        const border = if (node.style.has_border_values) resolveBorderRect(&node.style.border, direction) else Rect{};
        return cacheBaseSize(node, owner_width_value, owner_height_value, direction, clampNodeSize(node, .{
            .width = @max(width orelse 0, rectHorizontal(padding) + rectHorizontal(border)),
            .height = @max(height orelse 0, rectVertical(padding) + rectVertical(border)),
        }, owner_width, owner_height, direction));
    }

    const measured = layoutNode(node, width, height, owner_width, owner_height, direction);
    width = width orelse measured.width;
    height = height orelse measured.height;
    return cacheBaseSize(node, owner_width_value, owner_height_value, direction, clampNodeSize(node, .{ .width = width orelse 0, .height = height orelse 0 }, owner_width, owner_height, direction));
}

fn makeLineItem(node: *Node, container_width: ?f32, container_height: ?f32, is_row: bool, direction: Direction) LineItem {
    var basis = baseSize(node, container_width, container_height, direction);
    if (isConcrete(node.style.flex_basis)) {
        const owner_main = if (is_row) container_width else container_height;
        if (resolveValue(node.style.flex_basis, owner_main)) |resolved_basis| {
            const padding = if (node.style.has_padding_values) resolveSpacingRect(&node.style.padding, container_width, direction) else Rect{};
            const border = if (node.style.has_border_values) resolveBorderRect(&node.style.border, direction) else Rect{};
            const chrome_main = if (is_row) rectHorizontal(padding) + rectHorizontal(border) else rectVertical(padding) + rectVertical(border);
            const outer_basis = if (node.style.box_sizing == .content_box) resolved_basis + chrome_main else @max(resolved_basis, chrome_main);
            if (is_row) basis.width = outer_basis else basis.height = outer_basis;
        }
    }
    const flex_base_main = if (is_row) basis.width else basis.height;
    basis = clampNodeSize(node, basis, container_width, container_height, direction);
    const margin = if (node.style.has_margin_values) resolveSpacingRect(&node.style.margin, container_width, direction) else Rect{};
    const has_explicit_width = hasStyleWidth(node);
    const has_explicit_height = hasStyleHeight(node);

    const base_main = if (is_row) basis.width else basis.height;
    const base_cross = if (is_row) basis.height else basis.width;
    const margin_main = if (is_row) margin.left + margin.right else margin.top + margin.bottom;
    const margin_cross = if (is_row) margin.top + margin.bottom else margin.left + margin.right;

    return .{
        .node = node,
        .base_width = basis.width,
        .base_height = basis.height,
        .flex_base_main = flex_base_main,
        .target_width = basis.width,
        .target_height = basis.height,
        .margin = margin,
        .margin_left_auto = node.style.has_margin_values and edgeValue(&node.style.margin, .left, direction).unit == .auto,
        .margin_right_auto = node.style.has_margin_values and edgeValue(&node.style.margin, .right, direction).unit == .auto,
        .margin_top_auto = node.style.has_margin_values and edgeValue(&node.style.margin, .top, direction).unit == .auto,
        .margin_bottom_auto = node.style.has_margin_values and edgeValue(&node.style.margin, .bottom, direction).unit == .auto,
        .outer_main = base_main + margin_main,
        .outer_cross = base_cross + margin_cross,
        .flex_grow = nonNan(node.style.flex_grow, 0),
        .flex_shrink = nonNan(node.style.flex_shrink, 0),
        .has_explicit_width = has_explicit_width,
        .has_explicit_height = has_explicit_height,
    };
}

fn flowChildCount(node: *const Node) usize {
    var count: usize = 0;
    for (node.children.items) |child| {
        if (child.style.display == .none) continue;
        if (child.style.display == .contents) {
            count += flowChildCount(child);
            continue;
        }
        if (child.style.position_type != .absolute) count += 1;
    }
    return count;
}

fn collectFlexItems(node: *Node, items: []LineItem, container_width: ?f32, container_height: ?f32, is_row: bool, direction: Direction) usize {
    var count: usize = 0;
    for (node.children.items) |child| {
        if (child.style.display == .none) {
            zeroLayoutRecursive(child);
            continue;
        }
        if (child.style.display == .contents) {
            child.layout = .{};
            const added = collectFlexItems(child, items[count..], container_width, container_height, is_row, direction);
            count += added;
            continue;
        }
        if (child.style.position_type == .absolute) continue;
        items[count] = makeLineItem(child, container_width, container_height, is_row, direction);
        count += 1;
    }
    return count;
}

fn canUseFlatFlexScratch(node: *const Node) bool {
    for (node.children.items) |child| {
        if (child.style.display == .contents) return false;
        if (child.style.display == .none or child.style.position_type == .absolute) continue;
        if (child.children.items.len != 0) return false;
        if (child.measure_callback != null or child.has_measure_subtree) return false;
    }
    return true;
}

fn buildFlexLines(items: []LineItem, lines: []FlexLine, main_limit: ?f32, gap: f32, wrap: Wrap) usize {
    if (items.len == 0) return 0;

    var line_count: usize = 0;
    var start: usize = 0;
    var line_main: f32 = 0;
    var line_cross: f32 = 0;
    var line_grow: f32 = 0;
    var line_shrink: f32 = 0;

    for (items, 0..) |item, index| {
        const add_gap = if (index == start) 0 else gap;
        const next_main = line_main + add_gap + item.outer_main;
        if (wrap != .no_wrap and main_limit != null and index > start and next_main > main_limit.?) {
            lines[line_count] = .{ .start = start, .end = index, .main = line_main, .cross = line_cross, .grow = line_grow, .shrink = line_shrink };
            line_count += 1;
            start = index;
            line_main = item.outer_main;
            line_cross = item.outer_cross;
            line_grow = item.flex_grow;
            line_shrink = item.flex_shrink * @max(0, item.outer_main);
            continue;
        }

        line_main = next_main;
        line_cross = @max(line_cross, item.outer_cross);
        line_grow += item.flex_grow;
        line_shrink += item.flex_shrink * @max(0, item.outer_main);
    }

    lines[line_count] = .{ .start = start, .end = items.len, .main = line_main, .cross = line_cross, .grow = line_grow, .shrink = line_shrink };
    return line_count + 1;
}

fn clampFlexMainSize(node: *const Node, value: f32, is_row: bool, content_main: f32, direction: Direction) f32 {
    if (if (is_row)
        !isDefined(node.style.min_width) and !isDefined(node.style.max_width)
    else
        !isDefined(node.style.min_height) and !isDefined(node.style.max_height))
    {
        return @max(0, value);
    }

    const min_value = if (is_row)
        outerDimensionFromStyle(node, node.style.min_width, content_main, content_main, null, direction, true)
    else
        outerDimensionFromStyle(node, node.style.min_height, content_main, null, content_main, direction, false);
    const max_value = if (is_row)
        outerDimensionFromStyle(node, node.style.max_width, content_main, content_main, null, direction, true)
    else
        outerDimensionFromStyle(node, node.style.max_height, content_main, null, content_main, direction, false);

    var result = @max(0, value);
    if (min_value) |min_resolved| result = @max(result, min_resolved);
    if (max_value) |max_resolved| result = @min(result, max_resolved);
    return result;
}

fn applyFlexDistribution(items: []LineItem, line: FlexLine, is_row: bool, content_main: f32, gap: f32, direction: Direction) void {
    const item_count = line.end - line.start;
    const total_gap = if (item_count > 0) gap * @as(f32, @floatFromInt(item_count - 1)) else 0;
    var occupied = total_gap;

    for (items[line.start..line.end]) |item| {
        const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
        occupied += item.flex_base_main + margin_main;
    }

    var free = content_main - occupied;
    for (items[line.start..line.end]) |*item| {
        item.frozen = false;
    }

    if (free > 0 and line.grow > 0) {
        var remaining_grow = line.grow;
        while (remaining_grow > 0) {
            var used = total_gap;
            for (items[line.start..line.end]) |item| {
                const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
                const current_target = if (is_row) item.target_width else item.target_height;
                const main_base = item.flex_base_main;
                const main_size = if (item.frozen) current_target else main_base;
                used += main_size + margin_main;
            }

            free = content_main - used;
            const distributable_free = if (remaining_grow < 1) free * remaining_grow else free;
            var froze_any = false;
            var total_violation: f32 = 0;

            for (items[line.start..line.end]) |*item| {
                if (item.frozen or item.flex_grow <= 0) continue;
                const main_base = item.flex_base_main;
                var proposed = main_base + distributable_free * item.flex_grow / remaining_grow;
                proposed = @max(0, proposed);
                const clamped = clampFlexMainSize(item.node, proposed, is_row, content_main, direction);
                if (is_row) item.target_width = clamped else item.target_height = clamped;
                item.violation = clamped - proposed;
                total_violation += item.violation;
            }

            for (items[line.start..line.end]) |*item| {
                if (item.frozen or item.flex_grow <= 0) continue;
                const should_freeze = if (total_violation > 0)
                    item.violation > 0
                else if (total_violation < 0)
                    item.violation < 0
                else
                    false;
                if (should_freeze) {
                    item.frozen = true;
                    remaining_grow -= item.flex_grow;
                    froze_any = true;
                }
            }

            if (!froze_any) break;
        }

        var final_used = total_gap;
        var shrink_capacity: f32 = 0;
        for (items[line.start..line.end]) |item| {
            const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
            const target = if (is_row) item.target_width else item.target_height;
            const min_target = if (is_row)
                outerDimensionFromStyle(item.node, item.node.style.min_width, content_main, content_main, null, direction, true) orelse 0
            else
                outerDimensionFromStyle(item.node, item.node.style.min_height, content_main, null, content_main, direction, false) orelse 0;
            final_used += target + margin_main;
            shrink_capacity += @max(0, target - min_target);
        }
        const overflow = final_used - content_main;
        if (overflow > 0 and shrink_capacity > 0) {
            for (items[line.start..line.end]) |*item| {
                const target = if (is_row) item.target_width else item.target_height;
                const min_target = if (is_row)
                    outerDimensionFromStyle(item.node, item.node.style.min_width, content_main, content_main, null, direction, true) orelse 0
                else
                    outerDimensionFromStyle(item.node, item.node.style.min_height, content_main, null, content_main, direction, false) orelse 0;
                const capacity = @max(0, target - min_target);
                const reduced = target - overflow * capacity / shrink_capacity;
                if (is_row) item.target_width = @max(min_target, reduced) else item.target_height = @max(min_target, reduced);
            }
        }
        return;
    }

    if (free < 0 and line.shrink > 0) {
        var remaining_shrink = line.shrink;
        while (remaining_shrink > 0) {
            var used = total_gap;
            for (items[line.start..line.end]) |item| {
                const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
                const current_target = if (is_row) item.target_width else item.target_height;
                const main_base = item.flex_base_main;
                const main_size = if (item.frozen) current_target else main_base;
                used += main_size + margin_main;
            }

            free = content_main - used;
            var froze_any = false;
            var total_violation: f32 = 0;

            for (items[line.start..line.end]) |*item| {
                if (item.frozen or item.flex_shrink <= 0) continue;
                const main_base = item.flex_base_main;
                const scaled = item.flex_shrink * @max(0, main_base);
                var proposed = main_base + free * scaled / remaining_shrink;
                proposed = @max(0, proposed);
                const clamped = clampFlexMainSize(item.node, proposed, is_row, content_main, direction);
                if (is_row) item.target_width = clamped else item.target_height = clamped;
                item.violation = clamped - proposed;
                total_violation += item.violation;
            }

            for (items[line.start..line.end]) |*item| {
                if (item.frozen or item.flex_shrink <= 0) continue;
                const should_freeze = if (total_violation > 0)
                    item.violation > 0
                else if (total_violation < 0)
                    item.violation < 0
                else
                    false;
                if (should_freeze) {
                    item.frozen = true;
                    remaining_shrink -= item.flex_shrink * @max(0, item.flex_base_main);
                    froze_any = true;
                }
            }

            if (!froze_any) break;
        }
        return;
    }

    for (items[line.start..line.end]) |*item| {
        const main_base = item.flex_base_main;
        var main = main_base;
        main = @max(0, main);

        if (is_row) {
            item.target_width = clampFlexMainSize(item.node, main, true, content_main, direction);
        } else {
            item.target_height = clampFlexMainSize(item.node, main, false, content_main, direction);
        }
    }
}

fn justifyOffsetAndGap(justify: Justify, free: f32, item_count: usize, base_gap: f32) JustifyLayout {
    if (item_count == 0) return .{ .offset = 0, .gap = base_gap };
    if (free <= 0) {
        return switch (justify) {
            .center => .{ .offset = free / 2, .gap = base_gap },
            .flex_end => .{ .offset = free, .gap = base_gap },
            else => .{ .offset = 0, .gap = base_gap },
        };
    }

    return switch (justify) {
        .flex_start => .{ .offset = 0, .gap = base_gap },
        .center => .{ .offset = free / 2, .gap = base_gap },
        .flex_end => .{ .offset = free, .gap = base_gap },
        .space_between => if (item_count > 1)
            .{ .offset = 0, .gap = base_gap + free / @as(f32, @floatFromInt(item_count - 1)) }
        else
            .{ .offset = 0, .gap = base_gap },
        .space_around => .{ .offset = free / @as(f32, @floatFromInt(item_count)) / 2, .gap = base_gap + free / @as(f32, @floatFromInt(item_count)) },
        .space_evenly => .{ .offset = free / @as(f32, @floatFromInt(item_count + 1)), .gap = base_gap + free / @as(f32, @floatFromInt(item_count + 1)) },
    };
}

fn justifyStaticOffset(justify: Justify, available: f32, reversed: bool) f32 {
    return switch (justify) {
        .center => available / 2,
        .flex_end => if (reversed) 0 else available,
        .flex_start, .space_between, .space_around, .space_evenly => if (reversed) available else 0,
    };
}

fn alignStaticOffset(alignment: Align, available: f32, reversed: bool) f32 {
    return switch (alignment) {
        .center => available / 2,
        .flex_end => if (reversed) 0 else available,
        else => if (reversed) available else 0,
    };
}

fn nodeBaseline(node: *const Node) f32 {
    for (node.children.items) |child| {
        if (child.style.display == .none or child.style.position_type == .absolute) continue;
        if (child.is_reference_baseline) {
            return child.layout.top + nodeBaseline(child);
        }
    }
    for (node.children.items) |child| {
        if (child.style.display == .none or child.style.position_type == .absolute) continue;
        if (child.style.align_self == .baseline and child.layout.top == 0) {
            return child.layout.top + nodeBaseline(child);
        }
    }
    for (node.children.items) |child| {
        if (child.style.display == .none or child.style.position_type == .absolute) continue;
        return child.layout.top + nodeBaseline(child);
    }
    return node.layout.height;
}

fn subtreeHasMeasureFunc(node: *const Node) bool {
    return node.has_measure_subtree;
}

fn childAlign(parent: *const Node, child: *const Node) Align {
    if (child.style.align_self != .auto) return child.style.align_self;
    return parent.style.align_items;
}

fn applyRelativePosition(node: *const Node, x: *f32, y: *f32, owner_width: f32, owner_height: f32, direction: Direction) void {
    if (node.style.position_type == .static) return;
    if (!node.style.has_position_values) return;

    const left = resolveValue(edgeValue(&node.style.position, .left, direction), owner_width);
    const right = resolveValue(edgeValue(&node.style.position, .right, direction), owner_width);
    const top = resolveValue(edgeValue(&node.style.position, .top, direction), owner_height);
    const bottom = resolveValue(edgeValue(&node.style.position, .bottom, direction), owner_height);

    if (left) |value| x.* += value else if (right) |value| x.* -= value;
    if (top) |value| y.* += value else if (bottom) |value| y.* -= value;
}

fn setChildLayout(parent: *Node, child: *Node, x: f32, y: f32, width: f32, height: f32, content_width: f32, content_height: f32) void {
    const right = @max(0, content_width - x - width);
    const bottom = @max(0, content_height - y - height);
    if (layoutValuesChanged(child.layout, x, y, right, bottom, width, height)) markRoundDirty(child);
    child.layout.left = x;
    child.layout.top = y;
    child.layout.width = width;
    child.layout.height = height;
    child.layout.right = right;
    child.layout.bottom = bottom;
    _ = parent;
}

fn layoutAbsoluteChild(containing_node: *Node, parent: *Node, child: *Node, content_width: f32, content_height: f32, origin_x: f32, origin_y: f32, direction: Direction) void {
    const absolute_direction = current_root_direction;
    const containing_width = if (containing_node.containing_width > 0) containing_node.containing_width else content_width;
    const containing_height = if (containing_node.containing_height > 0) containing_node.containing_height else content_height;
    var size = baseSize(child, containing_width, containing_height, direction);
    const margin = if (child.style.has_margin_values) resolveSpacingRect(&child.style.margin, containing_width, absolute_direction) else Rect{};
    const position = if (child.style.has_position_values) resolveRect(&child.style.position, containing_width, containing_height, absolute_direction) else Rect{};
    const left_value = resolveValue(edgeValue(&child.style.position, .left, absolute_direction), containing_width);
    const right_value = resolveValue(edgeValue(&child.style.position, .right, absolute_direction), containing_width);
    const top_value = resolveValue(edgeValue(&child.style.position, .top, absolute_direction), containing_height);
    const bottom_value = resolveValue(edgeValue(&child.style.position, .bottom, absolute_direction), containing_height);
    const physical_left_value = resolveValue(child.style.position[edgeIndex(.left)], containing_width);
    const physical_right_value = resolveValue(child.style.position[edgeIndex(.right)], containing_width);

    if (left_value != null and right_value != null and !hasStyleWidth(child)) {
        size.width = @max(0, containing_width - left_value.? - right_value.? - margin.left - margin.right);
    }
    if (top_value != null and bottom_value != null and !hasStyleHeight(child)) {
        size.height = @max(0, containing_height - top_value.? - bottom_value.? - margin.top - margin.bottom);
    }

    var x = origin_x + margin.left + position.left;
    var y = origin_y + margin.top + position.top;
    const parent_is_row = parent.style.flex_direction == .row or parent.style.flex_direction == .row_reverse;
    var parent_main_reversed = parent.style.flex_direction == .row_reverse or parent.style.flex_direction == .column_reverse;
    if (parent_is_row and absolute_direction == .rtl) parent_main_reversed = !parent_main_reversed;
    const child_alignment = childAlign(parent, child);
    const static_origin_x = origin_x + parent.layout.padding.left;
    const static_origin_y = origin_y + parent.layout.padding.top;
    const cross_static_reversed = if (parent_is_row) parent.style.flex_wrap == .wrap_reverse else (absolute_direction == .rtl) != (parent.style.flex_wrap == .wrap_reverse);

    if (physical_left_value != null and physical_right_value != null and absolute_direction == .rtl) {
        x = origin_x + containing_width - size.width - margin.right - physical_right_value.?;
    } else if (left_value != null and right_value != null and direction == .rtl) {
        x = origin_x + containing_width - size.width - margin.right - right_value.?;
    } else if (left_value == null and right_value == null and parent.style.position_type == .static) {
        const parent_content_origin_x = parent.layout.border.left + parent.layout.padding.left;
        const parent_content_width = @max(0, parent.layout.width - rectHorizontal(parent.layout.border) - rectHorizontal(parent.layout.padding));
        const available = parent_content_width - size.width - margin.left - margin.right;
        if (parent_is_row) {
            x = parent_content_origin_x + margin.left + justifyStaticOffset(parent.style.justify_content, available, parent_main_reversed);
        } else {
            x = parent_content_origin_x + margin.left + alignStaticOffset(child_alignment, available, absolute_direction == .rtl);
        }
    } else if (left_value == null and right_value == null) {
        const available = content_width - size.width - margin.left - margin.right;
        if (parent_is_row) {
            x = static_origin_x + margin.left + justifyStaticOffset(parent.style.justify_content, available, parent_main_reversed);
        } else {
            x = static_origin_x + margin.left + alignStaticOffset(child_alignment, available, cross_static_reversed);
        }
    } else if (left_value == null and right_value != null) {
        x = origin_x + containing_width - size.width - margin.right - right_value.?;
    }
    if (top_value == null and bottom_value == null and parent.style.position_type == .static) {
        const parent_content_origin_y = parent.layout.border.top + parent.layout.padding.top;
        const parent_content_height = @max(0, parent.layout.height - rectVertical(parent.layout.border) - rectVertical(parent.layout.padding));
        const available = parent_content_height - size.height - margin.top - margin.bottom;
        if (parent_is_row) {
            y = parent_content_origin_y + margin.top + alignStaticOffset(child_alignment, available, false);
        } else {
            y = parent_content_origin_y + margin.top + justifyStaticOffset(parent.style.justify_content, available, parent_main_reversed);
        }
    } else if (top_value == null and bottom_value == null) {
        const available = content_height - size.height - margin.top - margin.bottom;
        if (parent_is_row) {
            y = static_origin_y + margin.top + alignStaticOffset(child_alignment, available, cross_static_reversed);
        } else {
            y = static_origin_y + margin.top + justifyStaticOffset(parent.style.justify_content, available, parent_main_reversed);
        }
    } else if (top_value == null and bottom_value != null) {
        y = origin_y + containing_height - size.height - margin.bottom - bottom_value.?;
    }

    _ = layoutNode(child, size.width, size.height, containing_width, containing_height, absolute_direction);
    setChildLayout(parent, child, x, y, child.layout.width, child.layout.height, containing_width, containing_height);
}

fn hasHorizontalInsets(node: *const Node, direction: Direction) bool {
    if (!node.style.has_position_values) return false;
    return isDefined(edgeValue(&node.style.position, .left, direction)) or isDefined(edgeValue(&node.style.position, .right, direction));
}

fn hasVerticalInsets(node: *const Node, direction: Direction) bool {
    if (!node.style.has_position_values) return false;
    return isDefined(edgeValue(&node.style.position, .top, direction)) or isDefined(edgeValue(&node.style.position, .bottom, direction));
}

fn layoutAbsoluteDescendants(containing_node: *Node, current_node: *Node, offset_x: f32, offset_y: f32, content_width: f32, content_height: f32, direction: Direction) void {
    const origin_x = containing_node.layout.border.left;
    const origin_y = containing_node.layout.border.top;

    for (current_node.children.items) |child| {
        if (child.style.display == .none) continue;
        if (child.style.display == .contents) {
            child.layout = .{};
            continue;
        }
        if (child.style.position_type == .absolute) {
            layoutAbsoluteChild(containing_node, current_node, child, content_width, content_height, origin_x, origin_y, direction);
            const raw_left = resolveValue(child.style.position[edgeIndex(.left)], content_width);
            const raw_right = resolveValue(child.style.position[edgeIndex(.right)], content_width);
            const handled_rtl_both_horizontal = current_root_direction == .rtl and raw_left != null and raw_right != null;
            if (handled_rtl_both_horizontal) {
                const containing_width = if (containing_node.containing_width > 0) containing_node.containing_width else content_width;
                child.layout.left = containing_node.layout.border.left + containing_width - child.layout.width - child.layout.margin.right - raw_right.? - offset_x;
            }
            if (!handled_rtl_both_horizontal and hasHorizontalInsets(child, current_root_direction)) child.layout.left -= offset_x;
            if (hasVerticalInsets(child, current_root_direction)) child.layout.top -= offset_y;
        } else if (child.style.position_type == .static and !child.always_forms_containing_block) {
            layoutAbsoluteDescendants(containing_node, child, offset_x + child.layout.left, offset_y + child.layout.top, content_width, content_height, direction);
        }
    }
}

fn canUseKnownSingleLineFastPath(node: *const Node, direction: Direction) bool {
    if (direction != .ltr) return false;
    if (node.style.flex_wrap != .no_wrap) return false;
    if (node.style.flex_direction == .row_reverse or node.style.flex_direction == .column_reverse) return false;
    if (node.style.align_items == .baseline) return false;
    if (node.has_absolute_subtree) return false;

    for (node.children.items) |child| {
        if (child.style.display != .flex) return false;
        if (child.style.position_type == .absolute) return false;
        if (child.measure_callback != null or child.has_measure_subtree) return false;
        if (childAlign(node, child) == .baseline) return false;
        if (isConcrete(child.style.flex_basis)) return false;
        if ((nonNan(child.style.flex_grow, 0) > 0 or nonNan(child.style.flex_shrink, 0) > 0) and
            (isDefined(child.style.min_width) or isDefined(child.style.min_height) or isDefined(child.style.max_width) or isDefined(child.style.max_height))) return false;
        if (child.style.has_margin_values) return false;
        if (child.style.has_position_values) return false;
    }

    return true;
}

fn canUseZeroGrowBase(parent: *const Node, child: *const Node, is_row: bool) bool {
    if (nonNan(child.style.flex_grow, 0) <= 0) return false;
    if (nonNan(child.style.flex_shrink, 0) <= 0) return false;
    if (isConcrete(child.style.flex_basis)) return false;
    const alignment = childAlign(parent, child);
    if (is_row) {
        if (!hasStyleHeight(child) and alignment != .stretch) return false;
        return !hasStyleWidth(child) and !isDefined(child.style.min_width) and !isDefined(child.style.max_width);
    }
    if (!hasStyleWidth(child) and alignment != .stretch) return false;
    return !hasStyleHeight(child) and !isDefined(child.style.min_height) and !isDefined(child.style.max_height);
}

fn zeroGrowBaseSize(child: *const Node, is_row: bool, content_width: f32, content_height: f32, direction: Direction) Size {
    if (is_row) {
        return .{ .width = 0, .height = nodeOuterHeightFromStyle(child, content_width, content_height, direction) orelse 0 };
    }
    return .{ .width = nodeOuterWidthFromStyle(child, content_width, content_height, direction) orelse 0, .height = 0 };
}

fn layoutKnownSingleLineFastPath(node: *Node, content_width: f32, content_height: f32, direction: Direction) bool {
    if (!canUseKnownSingleLineFastPath(node, direction)) return false;

    const is_row = node.style.flex_direction == .row;
    const content_main = if (is_row) content_width else content_height;
    const content_cross = if (is_row) content_height else content_width;
    const gap = resolveGap(&node.style, if (is_row) .column else .row, content_main);
    const child_count = node.children.items.len;
    if (child_count > STACK_FLEX_ITEMS) return false;

    const total_gap = if (child_count > 1) gap * @as(f32, @floatFromInt(child_count - 1)) else 0;

    var base_sizes: [STACK_FLEX_ITEMS]Size = undefined;
    var occupied = total_gap;
    var grow: f32 = 0;
    var shrink: f32 = 0;
    var grow_child_count: usize = 0;

    for (node.children.items) |child| {
        if (nonNan(child.style.flex_grow, 0) > 0) grow_child_count += 1;
    }

    for (node.children.items, 0..) |child, index| {
        const base = if (grow_child_count == 1 and canUseZeroGrowBase(node, child, is_row))
            zeroGrowBaseSize(child, is_row, content_width, content_height, direction)
        else
            baseSize(child, content_width, content_height, direction);
        base_sizes[index] = base;
        const base_main = if (is_row) base.width else base.height;
        occupied += base_main;
        grow += nonNan(child.style.flex_grow, 0);
        shrink += nonNan(child.style.flex_shrink, 0) * @max(0, base_main);
    }

    const free = content_main - occupied;
    if (grow > 0 and grow < 1) return false;
    if (free < 0 and shrink > 0) return false;
    const justify = if (free > 0 and grow > 0)
        JustifyLayout{ .offset = 0, .gap = gap }
    else
        justifyOffsetAndGap(node.style.justify_content, free, child_count, gap);

    var cursor = justify.offset;
    const origin_x = node.layout.border.left + node.layout.padding.left;
    const origin_y = node.layout.border.top + node.layout.padding.top;

    for (node.children.items, 0..) |child, index| {
        const base = base_sizes[index];
        const base_main = if (is_row) base.width else base.height;
        const base_cross = if (is_row) base.height else base.width;
        const child_grow = nonNan(child.style.flex_grow, 0);
        const child_shrink = nonNan(child.style.flex_shrink, 0);

        var child_main = base_main;
        if (free > 0 and grow > 0 and child_grow > 0) {
            child_main = base_main + free * child_grow / grow;
        } else if (free < 0 and shrink > 0 and child_shrink > 0) {
            child_main = @max(0, base_main + free * (child_shrink * @max(0, base_main)) / shrink);
        }
        child_main = clampFlexMainSize(child, child_main, is_row, content_main, direction);

        const alignment = childAlign(node, child);
        const has_cross_style = if (is_row) hasStyleHeight(child) else hasStyleWidth(child);
        var child_cross = base_cross;
        if (alignment == .stretch and !has_cross_style) {
            child_cross = content_cross;
        }

        var child_width = if (is_row) child_main else child_cross;
        var child_height = if (is_row) child_cross else child_main;
        const available_cross = content_cross - child_cross;
        var cross_offset: f32 = 0;
        if (alignment == .center) {
            cross_offset = available_cross / 2;
        } else if (alignment == .flex_end) {
            cross_offset = available_cross;
        } else if (direction == .rtl and !is_row) {
            cross_offset = available_cross;
        }

        if (!(child.has_cached_layout and
            (child.cached_generation == current_layout_generation or !child.dirty) and
            child.layout.width == child_width and
            child.layout.height == child_height))
        {
            _ = layoutNode(child, child_width, child_height, content_width, content_height, direction);
        }

        child_width = child.layout.width;
        child_height = child.layout.height;

        const x = if (is_row) origin_x + cursor else origin_x + cross_offset;
        const y = if (is_row) origin_y + cross_offset else origin_y + cursor;
        setChildLayout(node, child, x, y, child_width, child_height, content_width, content_height);
        cursor += (if (is_row) child_width else child_height) + justify.gap;
    }

    return true;
}

fn layoutFlexChildren(node: *Node, width: *f32, height: *f32, owner_width: ?f32, owner_height: ?f32, direction: Direction) void {
    const is_row = node.style.flex_direction == .row or node.style.flex_direction == .row_reverse;
    var main_reversed = node.style.flex_direction == .row_reverse or node.style.flex_direction == .column_reverse;
    if (is_row and direction == .rtl) main_reversed = !main_reversed;

    node.layout.padding = if (node.style.has_padding_values) resolveSpacingRect(&node.style.padding, owner_width orelse width.*, direction) else Rect{};
    node.layout.border = if (node.style.has_border_values) resolveBorderRect(&node.style.border, direction) else Rect{};
    const chrome_width = rectHorizontal(node.layout.padding) + rectHorizontal(node.layout.border);
    const chrome_height = rectVertical(node.layout.padding) + rectVertical(node.layout.border);

    const known_content_width = optionalSize(width.*).? - chrome_width;
    const known_content_height = optionalSize(height.*).? - chrome_height;
    const content_width_known = width.* > 0;
    const content_height_known = height.* > 0;
    var content_width: ?f32 = if (content_width_known) @max(0, known_content_width) else null;
    var content_height: ?f32 = if (content_height_known) @max(0, known_content_height) else null;
    const content_width_was_auto = content_width == null;
    const content_height_was_auto = content_height == null;

    if (node.style.flex_wrap != .no_wrap) {
        if (is_row and content_width == null) {
            if (owner_width) |available_width| content_width = @max(0, available_width - chrome_width);
        } else if (!is_row and content_height == null) {
            if (owner_height) |available_height| content_height = @max(0, available_height - chrome_height);
        }
    }

    const child_count = flowChildCount(node);
    if (child_count == 0) {
        if (content_width == null) content_width = 0;
        if (content_height == null) content_height = 0;
        width.* = clampDimension(content_width.? + chrome_width, node.style.min_width, node.style.max_width, owner_width);
        height.* = clampDimension(content_height.? + chrome_height, node.style.min_height, node.style.max_height, owner_height);
        updateContainingBlock(node, width.*, height.*);
        if ((node.style.position_type != .static or node.parent == null) and node.has_absolute_subtree) {
            layoutAbsoluteDescendants(node, node, 0, 0, content_width.?, content_height.?, direction);
        }
        return;
    }

    if (content_width != null and content_height != null) {
        width.* = clampDimension(content_width.? + chrome_width, node.style.min_width, node.style.max_width, owner_width);
        height.* = clampDimension(content_height.? + chrome_height, node.style.min_height, node.style.max_height, owner_height);
        content_width = @max(0, width.* - chrome_width);
        content_height = @max(0, height.* - chrome_height);
        updateContainingBlock(node, width.*, height.*);
        if (layoutKnownSingleLineFastPath(node, content_width.?, content_height.?, direction)) {
            return;
        }
    }

    var stack_items: [STACK_FLEX_ITEMS]LineItem = undefined;
    var heap_items: ?[]LineItem = null;
    const use_tls_scratch = child_count > stack_items.len and child_count <= TLS_FLEX_ITEMS and canUseFlatFlexScratch(node);
    const items = if (child_count <= stack_items.len) stack_items[0..child_count] else blk: {
        if (use_tls_scratch) break :blk tls_flex_items[0..child_count];
        const allocated = allocator.alloc(LineItem, child_count) catch @panic("failed to allocate Zig Yoga flex items");
        heap_items = allocated;
        break :blk allocated;
    };
    defer if (heap_items) |allocated| allocator.free(allocated);

    const actual_count = collectFlexItems(node, items, content_width, content_height, is_row, direction);
    const active_items = items[0..actual_count];

    const line_storage_count = @max(@as(usize, 1), actual_count);
    var stack_lines: [STACK_FLEX_ITEMS]FlexLine = undefined;
    var heap_lines: ?[]FlexLine = null;
    const line_storage = if (line_storage_count <= stack_lines.len) stack_lines[0..line_storage_count] else blk: {
        if (use_tls_scratch) break :blk tls_flex_lines[0..line_storage_count];
        const allocated = allocator.alloc(FlexLine, line_storage_count) catch @panic("failed to allocate Zig Yoga flex lines");
        heap_lines = allocated;
        break :blk allocated;
    };
    defer if (heap_lines) |allocated| allocator.free(allocated);

    const main_limit = if (is_row) content_width else content_height;
    const gap = resolveGap(&node.style, if (is_row) .column else .row, main_limit);
    const line_count = buildFlexLines(active_items, line_storage, main_limit, gap, node.style.flex_wrap);
    const lines = line_storage[0..line_count];

    var natural_main: f32 = 0;
    var natural_cross: f32 = 0;
    const cross_gap = resolveGap(&node.style, if (is_row) .row else .column, if (is_row) content_height else content_width);
    for (lines, 0..) |line, line_index| {
        natural_main = @max(natural_main, line.main);
        natural_cross += line.cross;
        if (line_index > 0) natural_cross += cross_gap;
    }

    if (is_row) {
        if (content_width == null) content_width = natural_main;
        if (content_height == null) content_height = natural_cross;
    } else {
        if (content_height == null) content_height = natural_main;
        if (content_width == null) content_width = natural_cross;
    }

    width.* = clampDimension(content_width.? + chrome_width, node.style.min_width, node.style.max_width, owner_width);
    height.* = clampDimension(content_height.? + chrome_height, node.style.min_height, node.style.max_height, owner_height);
    content_width = @max(0, width.* - chrome_width);
    content_height = @max(0, height.* - chrome_height);
    updateContainingBlock(node, width.*, height.*);

    const origin_x = node.layout.border.left + node.layout.padding.left;
    const origin_y = node.layout.border.top + node.layout.padding.top;
    var cross_cursor: f32 = 0;
    var distributed_cross_gap = cross_gap;
    var stretch_line_extra: f32 = 0;
    const cross_axis_reversed = if (is_row) node.style.flex_wrap == .wrap_reverse else (direction == .rtl) != (node.style.flex_wrap == .wrap_reverse);
    if (node.style.flex_wrap != .no_wrap and lines.len > 0) {
        const content_cross = if (is_row) content_height.? else content_width.?;
        const free_cross = content_cross - natural_cross;
        switch (node.style.align_content) {
            .flex_start, .auto, .baseline => {},
            .flex_end => cross_cursor = free_cross,
            .center => cross_cursor = free_cross / 2,
            .stretch => if (free_cross > 0) {
                stretch_line_extra = free_cross / @as(f32, @floatFromInt(lines.len));
            },
            .space_between => if (free_cross > 0 and lines.len > 1) {
                distributed_cross_gap += free_cross / @as(f32, @floatFromInt(lines.len - 1));
            },
            .space_around => if (free_cross > 0) {
                const space = free_cross / @as(f32, @floatFromInt(lines.len));
                cross_cursor = space / 2;
                distributed_cross_gap += space;
            },
            .space_evenly => if (free_cross > 0) {
                const space = free_cross / @as(f32, @floatFromInt(lines.len + 1));
                cross_cursor = space;
                distributed_cross_gap += space;
            },
        }
    }

    for (lines) |line| {
        const content_main = if (is_row) content_width.? else content_height.?;
        const content_cross = if (is_row) content_height.? else content_width.?;
        applyFlexDistribution(active_items, line, is_row, content_main, gap, direction);

        var occupied: f32 = 0;
        var auto_main_margins: usize = 0;
        for (active_items[line.start..line.end]) |item| {
            const item_main = if (is_row) item.target_width else item.target_height;
            const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
            occupied += item_main + margin_main;
            if (is_row) {
                if (item.margin_left_auto) auto_main_margins += 1;
                if (item.margin_right_auto) auto_main_margins += 1;
            } else {
                if (item.margin_top_auto) auto_main_margins += 1;
                if (item.margin_bottom_auto) auto_main_margins += 1;
            }
        }
        const item_count = line.end - line.start;
        if (item_count > 1) occupied += gap * @as(f32, @floatFromInt(item_count - 1));

        var free = content_main - occupied;
        if (free > 0 and auto_main_margins > 0) {
            const auto_margin = free / @as(f32, @floatFromInt(auto_main_margins));
            for (active_items[line.start..line.end]) |*item| {
                if (is_row) {
                    if (item.margin_left_auto) item.margin.left = auto_margin;
                    if (item.margin_right_auto) item.margin.right = auto_margin;
                } else {
                    if (item.margin_top_auto) item.margin.top = auto_margin;
                    if (item.margin_bottom_auto) item.margin.bottom = auto_margin;
                }
            }
            free = 0;
        }

        const justify: JustifyLayout = if (auto_main_margins > 0) .{ .offset = 0, .gap = gap } else justifyOffsetAndGap(node.style.justify_content, free, item_count, gap);
        var main_cursor = justify.offset;
        var line_cross = if (node.style.flex_wrap == .no_wrap) content_cross else line.cross + stretch_line_extra;
        var line_baseline: f32 = 0;

        if (is_row) {
            for (active_items[line.start..line.end]) |*item| {
                if (childAlign(node, item.node) != .baseline) continue;
                const baseline_width = item.target_width;
                const baseline_height = item.target_height;
                if (item.node.has_cached_layout and
                    (item.node.cached_generation == current_layout_generation or !item.node.dirty) and
                    item.node.layout.width == baseline_width and
                    item.node.layout.height == baseline_height)
                {
                    // Reuse existing layout for baseline measurement.
                } else {
                    _ = layoutNode(item.node, baseline_width, baseline_height, content_width, content_height, direction);
                }
                line_baseline = @max(line_baseline, item.margin.top + nodeBaseline(item.node));
            }

            for (active_items[line.start..line.end]) |*item| {
                if (childAlign(node, item.node) != .baseline) continue;
                const item_baseline = nodeBaseline(item.node);
                const baseline_offset = line_baseline - item.margin.top - item_baseline;
                line_cross = @max(line_cross, baseline_offset + item.margin.top + item.node.layout.height + item.margin.bottom);
            }
        }

        const line_cross_origin = if (cross_axis_reversed) content_cross - cross_cursor - line_cross else cross_cursor;

        var item_index: usize = 0;
        while (item_index < item_count) : (item_index += 1) {
            const storage_index = line.start + item_index;
            const item = &active_items[storage_index];

            var child_width = item.target_width;
            var child_height = item.target_height;
            const child_alignment = childAlign(node, item.node);
            const item_cross_margin = if (is_row) item.margin.top + item.margin.bottom else item.margin.left + item.margin.right;
            var cross_offset: f32 = 0;
            const cross_reversed = cross_axis_reversed;

            if (child_alignment == .stretch) {
                const stretched = @max(0, line_cross - item_cross_margin);
                if (is_row and !item.has_explicit_height) child_height = stretched;
                if (!is_row and !item.has_explicit_width) child_width = stretched;
            }

            const relax_auto_cross_measure = subtreeHasMeasureFunc(item.node);
            const assigned_child_width: ?f32 = if (!is_row and content_width_was_auto and !item.has_explicit_width and relax_auto_cross_measure) null else child_width;
            const assigned_child_height: ?f32 = if (is_row and content_height_was_auto and !item.has_explicit_height and relax_auto_cross_measure) null else child_height;

            const must_relayout_auto_cross_measure = relax_auto_cross_measure and ((is_row and content_height_was_auto and !item.has_explicit_height) or (!is_row and content_width_was_auto and !item.has_explicit_width));

            if (!must_relayout_auto_cross_measure and
                item.node.has_cached_layout and
                (item.node.cached_generation == current_layout_generation or !item.node.dirty) and
                item.node.layout.width == child_width and
                item.node.layout.height == child_height)
            {
                // Natural sizing already laid this subtree out with the final size.
            } else if (item.node.measure_callback != null and item.node.children.items.len == 0) {
                item.node.layout.margin = item.margin;
                item.node.layout.padding = if (item.node.style.has_padding_values) resolveSpacingRect(&item.node.style.padding, content_width, direction) else Rect{};
                item.node.layout.border = if (item.node.style.has_border_values) resolveBorderRect(&item.node.style.border, direction) else Rect{};
                item.node.layout.width = child_width;
                item.node.layout.height = child_height;
            } else {
                const child_owner_width = if (!is_row and content_width_was_auto and !item.has_explicit_width and relax_auto_cross_measure) null else content_width;
                const child_owner_height = if (is_row and content_height_was_auto and !item.has_explicit_height and relax_auto_cross_measure) null else content_height;
                _ = layoutNode(item.node, assigned_child_width, assigned_child_height, child_owner_width, child_owner_height, direction);
            }

            child_width = item.node.layout.width;
            child_height = item.node.layout.height;

            const item_cross_size = if (is_row) child_height else child_width;
            var available_cross = line_cross - item_cross_size - item_cross_margin;
            if (available_cross > 0) {
                if (is_row) {
                    if (item.margin_top_auto and item.margin_bottom_auto) {
                        item.margin.top = available_cross / 2;
                        item.margin.bottom = available_cross / 2;
                        available_cross = 0;
                    } else if (item.margin_top_auto) {
                        item.margin.top = available_cross;
                        available_cross = 0;
                    } else if (item.margin_bottom_auto) {
                        item.margin.bottom = available_cross;
                        available_cross = 0;
                    }
                } else {
                    if (item.margin_left_auto and item.margin_right_auto) {
                        item.margin.left = available_cross / 2;
                        item.margin.right = available_cross / 2;
                        available_cross = 0;
                    } else if (item.margin_left_auto) {
                        item.margin.left = available_cross;
                        available_cross = 0;
                    } else if (item.margin_right_auto) {
                        item.margin.right = available_cross;
                        available_cross = 0;
                    }
                }
            }
            if (child_alignment == .center) {
                cross_offset = available_cross / 2;
            } else if (child_alignment == .flex_end) {
                cross_offset = if (cross_reversed) 0 else available_cross;
            } else if (child_alignment == .baseline and is_row) {
                cross_offset = line_baseline - item.margin.top - nodeBaseline(item.node);
            } else if (cross_reversed) {
                cross_offset = available_cross;
            }

            var x: f32 = origin_x;
            var y: f32 = origin_y;
            if (is_row) {
                if (main_reversed) {
                    x += content_main - main_cursor - item.margin.right - child_width;
                } else {
                    x += main_cursor + item.margin.left;
                }
                y += line_cross_origin + cross_offset + item.margin.top;
            } else {
                x += line_cross_origin + cross_offset + item.margin.left;
                if (main_reversed) {
                    y += content_main - main_cursor - item.margin.bottom - child_height;
                } else {
                    y += main_cursor + item.margin.top;
                }
            }

            applyRelativePosition(item.node, &x, &y, content_width.?, content_height.?, direction);
            setChildLayout(node, item.node, x, y, item.node.layout.width, item.node.layout.height, content_width.?, content_height.?);
            const item_main = if (is_row) item.node.layout.width else item.node.layout.height;
            const margin_main = if (is_row) item.margin.left + item.margin.right else item.margin.top + item.margin.bottom;
            main_cursor += item_main + margin_main + justify.gap;
        }

        cross_cursor += line_cross + distributed_cross_gap;
    }

    if ((is_row and content_height_was_auto) or (!is_row and content_width_was_auto)) {
        var final_cross: f32 = 0;
        for (active_items) |item| {
            if (is_row) {
                final_cross = @max(final_cross, item.node.layout.height + item.margin.top + item.margin.bottom);
            } else {
                final_cross = @max(final_cross, item.node.layout.width + item.margin.left + item.margin.right);
            }
        }

        if (is_row) {
            if (final_cross > content_height.?) {
                content_height = final_cross;
                height.* = clampDimension(content_height.? + chrome_height, node.style.min_height, node.style.max_height, owner_height);
                content_height = @max(0, height.* - chrome_height);
            }
            for (active_items) |item| {
                if (item.node.style.height.unit != .percent) continue;
                if (nodeOuterHeightFromStyle(item.node, content_width, content_height, direction)) |resolved_height| {
                    item.node.has_cached_layout = false;
                    const relayout_width: ?f32 = if (!hasStyleWidth(item.node) and subtreeHasMeasureFunc(item.node)) null else item.node.layout.width;
                    _ = layoutNode(item.node, relayout_width, resolved_height, content_width, content_height, direction);
                    const available_cross = content_height.? - item.node.layout.height - item.margin.top - item.margin.bottom;
                    const alignment = childAlign(node, item.node);
                    const offset = if (alignment == .center)
                        available_cross / 2
                    else if (alignment == .flex_end)
                        available_cross
                    else
                        @as(f32, 0);
                    const next_y = origin_y + item.margin.top + offset;
                    setChildLayout(node, item.node, item.node.layout.left, next_y, item.node.layout.width, item.node.layout.height, content_width.?, content_height.?);
                }
            }
        } else {
            if (final_cross > content_width.?) {
                content_width = final_cross;
                width.* = clampDimension(content_width.? + chrome_width, node.style.min_width, node.style.max_width, owner_width);
                content_width = @max(0, width.* - chrome_width);
            }
            for (active_items) |item| {
                if (item.node.style.width.unit != .percent) continue;
                if (nodeOuterWidthFromStyle(item.node, content_width, content_height, direction)) |resolved_width| {
                    item.node.has_cached_layout = false;
                    const relayout_height: ?f32 = if (!hasStyleHeight(item.node) and subtreeHasMeasureFunc(item.node)) null else item.node.layout.height;
                    _ = layoutNode(item.node, resolved_width, relayout_height, content_width, content_height, direction);
                    const available_cross = content_width.? - item.node.layout.width - item.margin.left - item.margin.right;
                    const alignment = childAlign(node, item.node);
                    const cross_reversed = direction == .rtl;
                    const offset = if (alignment == .center)
                        available_cross / 2
                    else if (alignment == .flex_end)
                        if (cross_reversed) @as(f32, 0) else available_cross
                    else if (cross_reversed)
                        available_cross
                    else
                        @as(f32, 0);
                    const next_x = origin_x + item.margin.left + offset;
                    setChildLayout(node, item.node, next_x, item.node.layout.top, item.node.layout.width, item.node.layout.height, content_width.?, content_height.?);
                }
            }
        }
        updateContainingBlock(node, width.*, height.*);
    }

    if ((node.style.position_type != .static or node.parent == null) and node.has_absolute_subtree) {
        layoutAbsoluteDescendants(node, node, 0, 0, content_width.?, content_height.?, direction);
    }
}

fn tryLayoutSimpleColumnDirtyChild(node: *Node, child: *Node, assigned_height: ?f32, owner_width: ?f32, owner_height: ?f32, direction: Direction) ?Size {
    if (node.style.flex_direction != .column) return null;
    if (node.style.flex_wrap != .no_wrap) return null;
    if (node.style.justify_content != .flex_start) return null;
    if (!gapIsOwnerIndependent(&node.style, .row)) return null;
    if (node.has_absolute_subtree) return null;
    if (!child.has_cached_layout) return null;

    var child_index: ?usize = null;
    for (node.children.items, 0..) |candidate, index| {
        if (candidate.style.display != .flex) return null;
        if (candidate.style.position_type == .absolute) return null;
        if (nonNan(candidate.style.flex_grow, 0) != 0) return null;
        if (nonNan(candidate.style.flex_shrink, 0) != 0) return null;
        if (isConcrete(candidate.style.flex_basis)) return null;
        if (candidate.style.height.unit == .percent) return null;
        if (candidate == child) child_index = index;
    }
    const index = child_index orelse return null;

    const old_width = node.layout.width;
    const old_height = node.layout.height;
    const old_child_left = child.layout.left;
    const old_child_top = child.layout.top;
    const old_child_width = child.layout.width;
    const old_child_height = child.layout.height;
    const old_child_margin = child.layout.margin;
    const old_outer_height = old_child_height + old_child_margin.top + old_child_margin.bottom;

    const child_assigned_width = if ((child.measure_callback != null and !hasStyleWidth(child)) or (child.style_dirty and hasStyleWidth(child))) null else optionalFromCached(child.cached_assigned_width);
    const child_assigned_height = if ((child.measure_callback != null and !hasStyleHeight(child)) or (child.style_dirty and hasStyleHeight(child))) null else optionalFromCached(child.cached_assigned_height);
    _ = layoutNode(
        child,
        child_assigned_width,
        child_assigned_height,
        optionalFromCached(child.cached_owner_width),
        optionalFromCached(child.cached_owner_height),
        child.cached_direction,
    );

    if (child.layout.width != old_child_width) return null;
    if (child.layout.margin.left != old_child_margin.left or child.layout.margin.right != old_child_margin.right) return null;

    const new_outer_height = child.layout.height + child.layout.margin.top + child.layout.margin.bottom;
    const delta = new_outer_height - old_outer_height;
    const child_top_delta = child.layout.margin.top - old_child_margin.top;

    var next_height = old_height;
    if (assigned_height) |height| {
        next_height = height;
    } else if (!hasStyleHeight(node)) {
        if (isDefined(node.style.max_height)) return null;
        next_height = old_height + delta;
        if (isDefined(node.style.min_height)) {
            const min_height = outerDimensionFromStyle(node, node.style.min_height, owner_height, owner_width, owner_height, direction, false) orelse 0;
            if (old_height <= min_height or next_height <= min_height) return null;
        }
    }

    if (old_width != node.layout.width) return null;
    if (next_height != old_height) {
        markRoundDirty(node);
        node.layout.height = next_height;
        updateContainingBlock(node, node.layout.width, node.layout.height);
    }

    const content_width = @max(0, node.layout.width - rectHorizontal(node.layout.padding) - rectHorizontal(node.layout.border));
    const content_height = @max(0, node.layout.height - rectVertical(node.layout.padding) - rectVertical(node.layout.border));
    for (node.children.items, 0..) |sibling, sibling_index| {
        const y_delta = if (sibling == child)
            child_top_delta
        else if (sibling_index > index)
            delta
        else
            @as(f32, 0);
        if (y_delta == 0 and sibling != child) {
            if (next_height == old_height) continue;
        }
        const next_y = if (sibling == child) old_child_top + child_top_delta else sibling.layout.top + y_delta;
        const next_x = if (sibling == child) old_child_left else sibling.layout.left;
        setChildLayout(node, sibling, next_x, next_y, sibling.layout.width, sibling.layout.height, content_width, content_height);
    }

    node.cached_generation = current_layout_generation;
    node.has_cached_layout = true;
    return .{ .width = node.layout.width, .height = node.layout.height };
}

fn canReuseChildrenForSimpleColumn(node: *const Node, direction: Direction) bool {
    _ = direction;
    if (node.style.flex_direction != .column) return false;
    if (node.style.flex_wrap != .no_wrap) return false;
    if (node.style.justify_content != .flex_start) return false;
    if (!gapIsOwnerIndependent(&node.style, .row)) return false;
    if (node.has_absolute_subtree) return false;

    for (node.children.items) |child| {
        if (child.style.display != .flex) return false;
        if (child.style.position_type == .absolute) return false;
        if (!child.has_cached_layout) return false;
        if (child.dirty and (child.self_dirty or child.dirty_child_count != 0)) return false;
        if (nonNan(child.style.flex_grow, 0) != 0) return false;
        if (nonNan(child.style.flex_shrink, 0) != 0) return false;
        if (isConcrete(child.style.flex_basis)) return false;
        if (child.style.height.unit == .percent) return false;
    }
    return true;
}

fn tryLayoutSimpleVerticalPaddingChange(node: *Node, assigned_width: ?f32, assigned_height: ?f32, owner_width: ?f32, owner_height: ?f32, direction: Direction) ?Size {
    if (!node.self_dirty or !node.style_dirty) return null;
    if (node.dirty_child_count != 0) return null;
    if (isDefined(node.style.max_height)) return null;
    if (!canReuseChildrenForSimpleColumn(node, direction)) return null;

    const next_margin = if (node.style.has_margin_values) resolveSpacingRect(&node.style.margin, owner_width, direction) else Rect{};
    const next_padding = if (node.style.has_padding_values) resolveSpacingRect(&node.style.padding, owner_width, direction) else Rect{};
    const next_border = if (node.style.has_border_values) resolveBorderRect(&node.style.border, direction) else Rect{};

    if (!rectEqual(node.layout.margin, next_margin)) return null;
    if (!rectEqual(node.layout.border, next_border)) return null;
    if (node.layout.padding.left != next_padding.left or node.layout.padding.right != next_padding.right) return null;

    const top_delta = next_padding.top - node.layout.padding.top;
    const bottom_delta = next_padding.bottom - node.layout.padding.bottom;
    const height_delta = top_delta + bottom_delta;
    if (height_delta == 0) return null;

    const explicit_width = assigned_width orelse nodeOuterWidthFromStyle(node, owner_width, owner_height, direction);
    if (explicit_width) |width| {
        if (width != node.layout.width) return null;
    }

    const old_height = node.layout.height;
    var next_height = old_height;
    const explicit_height = assigned_height orelse nodeOuterHeightFromStyle(node, owner_width, owner_height, direction);
    if (explicit_height) |height| {
        if (height != old_height) return null;
    } else {
        next_height = old_height + height_delta;
        if (isDefined(node.style.min_height)) {
            const min_height = outerDimensionFromStyle(node, node.style.min_height, owner_height, owner_width, owner_height, direction, false) orelse 0;
            if (old_height <= min_height or next_height <= min_height) return null;
        }
    }

    const clamped = clampNodeSize(node, .{ .width = node.layout.width, .height = next_height }, owner_width, owner_height, direction);
    if (clamped.width != node.layout.width or clamped.height != next_height) return null;
    next_height = clamped.height;

    node.layout.padding = next_padding;
    if (node.layout.height != next_height) markRoundDirty(node);
    node.layout.height = next_height;
    updateContainingBlock(node, node.layout.width, node.layout.height);

    const content_width = @max(0, node.layout.width - rectHorizontal(node.layout.padding) - rectHorizontal(node.layout.border));
    const content_height = @max(0, node.layout.height - rectVertical(node.layout.padding) - rectVertical(node.layout.border));
    for (node.children.items) |child| {
        setChildLayout(node, child, child.layout.left, child.layout.top + top_delta, child.layout.width, child.layout.height, content_width, content_height);
    }

    const assigned_width_value = optionalToFloat(assigned_width);
    const assigned_height_value = optionalToFloat(assigned_height);
    const owner_width_value = optionalToFloat(owner_width);
    const owner_height_value = optionalToFloat(owner_height);
    node.cached_assigned_width = assigned_width_value;
    node.cached_assigned_height = assigned_height_value;
    node.cached_owner_width = owner_width_value;
    node.cached_owner_height = owner_height_value;
    node.cached_direction = direction;
    node.cached_generation = current_layout_generation;
    node.has_cached_layout = true;
    if (assigned_height == null) {
        _ = cacheBaseSize(node, owner_width_value, owner_height_value, direction, .{ .width = node.layout.width, .height = node.layout.height });
    }
    return .{ .width = node.layout.width, .height = node.layout.height };
}

fn layoutNode(node: *Node, assigned_width: ?f32, assigned_height: ?f32, owner_width: ?f32, owner_height: ?f32, direction: Direction) Size {
    if (node.style.display == .none) {
        zeroLayoutRecursive(node);
        return .{};
    }

    const assigned_width_value = optionalToFloat(assigned_width);
    const assigned_height_value = optionalToFloat(assigned_height);
    const owner_width_value = optionalToFloat(owner_width);
    const owner_height_value = optionalToFloat(owner_height);
    if ((node.cached_generation == current_layout_generation or !node.dirty) and
        cachedConstraintsMatch(node, assigned_width_value, assigned_height_value, owner_width_value, owner_height_value, direction))
    {
        return .{ .width = node.layout.width, .height = node.layout.height };
    }

    const can_try_incremental_self_layout = cachedColumnFlowInputsMatch(node, assigned_width_value, owner_width_value, owner_height_value, direction) or
        (assigned_height == null and cachedBaseSizeValuesMatch(node, owner_width_value, owner_height_value, direction));
    if (node.dirty and can_try_incremental_self_layout) {
        if (tryLayoutSimpleVerticalPaddingChange(node, assigned_width, assigned_height, owner_width, owner_height, direction)) |size| {
            return size;
        }
    }

    if (node.dirty and
        !node.self_dirty and
        node.dirty_child_count == 1 and
        node.dirty_child != null and
        node.style.flex_wrap == .no_wrap)
    {
        const child = node.dirty_child.?;
        if (cachedColumnFlowInputsMatch(node, assigned_width_value, owner_width_value, owner_height_value, direction)) {
            if (tryLayoutSimpleColumnDirtyChild(node, child, assigned_height, owner_width, owner_height, direction)) |size| {
                return size;
            }
        }
        if (!child.style_dirty and
            child.has_cached_layout and
            cachedConstraintValuesMatch(node, assigned_width_value, assigned_height_value, owner_width_value, owner_height_value, direction))
        {
            const old_child_width = child.layout.width;
            const old_child_height = child.layout.height;
            const child_assigned_width = if (child.measure_callback != null and !hasStyleWidth(child)) null else optionalFromCached(child.cached_assigned_width);
            const child_assigned_height = if (child.measure_callback != null and !hasStyleHeight(child)) null else optionalFromCached(child.cached_assigned_height);
            const child_size = layoutNode(
                child,
                child_assigned_width,
                child_assigned_height,
                optionalFromCached(child.cached_owner_width),
                optionalFromCached(child.cached_owner_height),
                child.cached_direction,
            );

            if (child_size.width == old_child_width and child_size.height == old_child_height) {
                node.cached_generation = current_layout_generation;
                return .{ .width = node.layout.width, .height = node.layout.height };
            }
        }
    }

    node.layout.margin = if (node.style.has_margin_values) resolveSpacingRect(&node.style.margin, owner_width, direction) else Rect{};
    node.layout.padding = if (node.style.has_padding_values) resolveSpacingRect(&node.style.padding, owner_width orelse assigned_width, direction) else Rect{};
    node.layout.border = if (node.style.has_border_values) resolveBorderRect(&node.style.border, direction) else Rect{};

    var width = assigned_width orelse nodeOuterWidthFromStyle(node, owner_width, owner_height, direction) orelse nan;
    var height = assigned_height orelse nodeOuterHeightFromStyle(node, owner_width, owner_height, direction) orelse nan;

    if (std.math.isNan(width)) {
        const min_width = outerDimensionFromStyle(node, node.style.min_width, owner_width, owner_width, owner_height, direction, true);
        const max_width = outerDimensionFromStyle(node, node.style.max_width, owner_width, owner_width, owner_height, direction, true);
        if (min_width != null and max_width != null and min_width.? == max_width.?) width = min_width.?;
    }
    if (std.math.isNan(height)) {
        const min_height = outerDimensionFromStyle(node, node.style.min_height, owner_height, owner_width, owner_height, direction, false);
        const max_height = outerDimensionFromStyle(node, node.style.max_height, owner_height, owner_width, owner_height, direction, false);
        if (min_height != null and max_height != null and min_height.? == max_height.?) height = min_height.?;
    }

    if (node.measure_callback != null) {
        const measured = measureLeaf(node, optionalSize(width), optionalSize(height), owner_width, owner_height);
        if (std.math.isNan(width)) width = measured.width;
        if (std.math.isNan(height)) height = measured.height;
    } else if (node.children.items.len > 0) {
        if (std.math.isNan(width)) width = 0;
        if (std.math.isNan(height)) height = 0;
        layoutFlexChildren(node, &width, &height, owner_width, owner_height, direction);
    } else {
        if (std.math.isNan(width)) width = 0;
        if (std.math.isNan(height)) height = 0;
    }

    const chrome_width = rectHorizontal(node.layout.padding) + rectHorizontal(node.layout.border);
    const chrome_height = rectVertical(node.layout.padding) + rectVertical(node.layout.border);
    width = @max(width, chrome_width);
    height = @max(height, chrome_height);

    const clamped = clampNodeSize(node, .{ .width = width, .height = height }, owner_width, owner_height, direction);
    if (node.layout.width != clamped.width or node.layout.height != clamped.height) markRoundDirty(node);
    node.layout.width = clamped.width;
    node.layout.height = clamped.height;
    updateContainingBlock(node, clamped.width, clamped.height);
    node.cached_assigned_width = assigned_width_value;
    node.cached_assigned_height = assigned_height_value;
    node.cached_owner_width = owner_width_value;
    node.cached_owner_height = owner_height_value;
    node.cached_direction = direction;
    node.cached_generation = current_layout_generation;
    node.has_cached_layout = true;
    return clamped;
}

fn setRootLayout(node: *Node, width: ?f32, height: ?f32, direction: Direction) void {
    const size = layoutNode(node, width, height, width, height, direction);
    var left = node.layout.margin.left;
    var top = node.layout.margin.top;
    applyRelativePosition(node, &left, &top, size.width, size.height, direction);
    if (layoutValuesChanged(node.layout, left, top, 0, 0, size.width, size.height)) markRoundDirty(node);
    node.layout.left = left;
    node.layout.top = top;
    node.layout.right = 0;
    node.layout.bottom = 0;
    node.layout.width = size.width;
    node.layout.height = size.height;
}

fn roundToPixelGrid(value: f32, point_scale_factor: f32) f32 {
    if (point_scale_factor == 0 or std.math.isNan(value)) return value;
    var scaled = value * point_scale_factor;
    var fractial = scaled - @floor(scaled);
    if (fractial < 0) fractial += 1;
    if (@abs(fractial) < 0.0001) {
        scaled -= fractial;
    } else if (@abs(fractial - 1) < 0.0001) {
        scaled = scaled - fractial + 1;
    } else {
        scaled = scaled - fractial + if (fractial >= 0.5) @as(f32, 1) else @as(f32, 0);
    }
    const rounded = scaled / point_scale_factor;
    return if (rounded == 0) 0 else rounded;
}

fn roundToPixelGrid4(values: F32x4, point_scale_factor: f32) F32x4 {
    if (point_scale_factor == 0) return values;

    const scale: F32x4 = @splat(point_scale_factor);
    const zero: F32x4 = @splat(0);
    const one: F32x4 = @splat(1);
    const half: F32x4 = @splat(0.5);
    const epsilon: F32x4 = @splat(0.0001);

    const scaled = values * scale;
    var fractial = scaled - @floor(scaled);
    fractial = @select(f32, fractial < zero, fractial + one, fractial);

    const base = scaled - fractial;
    var rounded_scaled = base + @select(f32, fractial >= half, one, zero);
    rounded_scaled = @select(f32, @abs(fractial) < epsilon, base, rounded_scaled);
    rounded_scaled = @select(f32, @abs(fractial - one) < epsilon, base + one, rounded_scaled);

    const rounded = rounded_scaled / scale;
    return @select(f32, rounded == zero, zero, rounded);
}

fn roundLayoutRecursive(node: *Node, parent_abs_left: f32, parent_abs_top: f32, point_scale_factor: f32) void {
    const node_left = node.layout.left;
    const node_top = node.layout.top;
    const abs_left = parent_abs_left + node_left;
    const abs_top = parent_abs_top + node_top;
    const abs_right = abs_left + node.layout.width;
    const abs_bottom = abs_top + node.layout.height;

    const rounded_edges = roundToPixelGrid4(@as(F32x4, .{ abs_right, abs_bottom, abs_left, abs_top }), point_scale_factor);
    const round_right = rounded_edges[0];
    const round_bottom = rounded_edges[1];
    const round_abs_left = rounded_edges[2];
    const round_abs_top = rounded_edges[3];

    node.layout.left = roundToPixelGrid(node_left, point_scale_factor);
    node.layout.top = roundToPixelGrid(node_top, point_scale_factor);
    node.layout.width = round_right - round_abs_left;
    node.layout.height = round_bottom - round_abs_top;

    for (node.children.items) |child| {
        roundLayoutRecursive(child, abs_left, abs_top, point_scale_factor);
    }
}

fn roundChangedLayoutRecursive(node: *Node, parent_abs_left: f32, parent_abs_top: f32, point_scale_factor: f32, parent_changed: bool) void {
    if (!parent_changed and !node.needs_round and !node.has_round_subtree) return;

    const node_left = node.layout.left;
    const node_top = node.layout.top;
    const abs_left = parent_abs_left + node_left;
    const abs_top = parent_abs_top + node_top;
    const should_round_node = parent_changed or node.needs_round;

    if (should_round_node) {
        const abs_right = abs_left + node.layout.width;
        const abs_bottom = abs_top + node.layout.height;
        const rounded_edges = roundToPixelGrid4(@as(F32x4, .{ abs_right, abs_bottom, abs_left, abs_top }), point_scale_factor);
        const round_right = rounded_edges[0];
        const round_bottom = rounded_edges[1];
        const round_abs_left = rounded_edges[2];
        const round_abs_top = rounded_edges[3];

        node.layout.left = roundToPixelGrid(node_left, point_scale_factor);
        node.layout.top = roundToPixelGrid(node_top, point_scale_factor);
        node.layout.width = round_right - round_abs_left;
        node.layout.height = round_bottom - round_abs_top;
    }

    for (node.children.items) |child| {
        roundChangedLayoutRecursive(child, abs_left, abs_top, point_scale_factor, should_round_node);
    }

    node.needs_round = false;
    node.has_round_subtree = false;
}

pub export fn yogaConfigCreate() *Config {
    const config = allocator.create(Config) catch @panic("failed to allocate Zig Yoga config");
    config.* = .{};
    return config;
}

pub export fn yogaConfigFree(config: *Config) void {
    allocator.destroy(config);
}

export fn yogaConfigSetUseWebDefaults(config: *Config, enabled: bool) void {
    config.use_web_defaults = enabled;
}

export fn yogaConfigGetUseWebDefaults(config: *const Config) bool {
    return config.use_web_defaults;
}

export fn yogaConfigSetPointScaleFactor(config: *Config, point_scale_factor: f32) void {
    config.point_scale_factor = point_scale_factor;
}

export fn yogaConfigGetPointScaleFactor(config: *const Config) f32 {
    return config.point_scale_factor;
}

export fn yogaConfigSetErrata(config: *Config, errata: u32) void {
    config.errata = errata;
}

export fn yogaConfigGetErrata(config: *const Config) u32 {
    return config.errata;
}

export fn yogaConfigSetExperimentalFeatureEnabled(config: *Config, feature: u32, enabled: bool) void {
    const bit = @as(u32, 1) << @intCast(feature);
    if (enabled) config.experimental_features |= bit else config.experimental_features &= ~bit;
}

export fn yogaConfigIsExperimentalFeatureEnabled(config: *const Config, feature: u32) bool {
    const bit = @as(u32, 1) << @intCast(feature);
    return (config.experimental_features & bit) != 0;
}

pub export fn yogaNodeCreate() *Node {
    const node = allocator.create(Node) catch @panic("failed to allocate Zig Yoga node");
    node.* = .{};
    return node;
}

pub export fn yogaNodeCreateWithConfig(config: *const Config) *Node {
    const node = yogaNodeCreate();
    node.config = config;
    if (config.use_web_defaults) {
        node.style.flex_shrink = 1;
    }
    return node;
}

pub export fn yogaNodeFree(node: *Node) void {
    if (node.parent) |parent| {
        yogaNodeRemoveChild(parent, node);
    }
    node.deinit();
    allocator.destroy(node);
}

pub export fn yogaNodeFreeRecursive(node: *Node) void {
    if (node.parent) |parent| {
        yogaNodeRemoveChild(parent, node);
    }
    freeRecursiveInternal(node);
}

export fn yogaNodeReset(node: *Node) void {
    node.style = .{};
    node.layout = .{};
    node.measure_callback = null;
    node.dirtied_callback = null;
    node.has_measure_subtree = false;
    node.is_reference_baseline = false;
    node.always_forms_containing_block = false;
    node.has_new_layout = true;
    refreshAbsoluteSubtreeUpwards(node);
    markDirty(node);
}

export fn yogaNodeCopyStyle(dst_node: *Node, src_node: *const Node) void {
    const old_position_type = dst_node.style.position_type;
    dst_node.style = src_node.style;
    if (old_position_type != dst_node.style.position_type) refreshAbsoluteFromNode(dst_node);
    markDirty(dst_node);
}

pub export fn yogaNodeInsertChild(node: *Node, child: *Node, index: u32) void {
    if (child.parent) |parent| {
        yogaNodeRemoveChild(parent, child);
    }
    const insert_index = @min(@as(usize, @intCast(index)), node.children.items.len);
    node.children.insert(allocator, insert_index, child) catch @panic("failed to insert Zig Yoga child");
    child.parent = node;
    refreshMeasureSubtreeUpwards(node);
    refreshAbsoluteSubtreeUpwards(node);
    markDirty(node);
}

export fn yogaNodeRemoveChild(node: *Node, child: *Node) void {
    for (node.children.items, 0..) |candidate, index| {
        if (candidate == child) {
            _ = node.children.orderedRemove(index);
            child.parent = null;
            refreshMeasureSubtreeUpwards(node);
            refreshAbsoluteSubtreeUpwards(node);
            markDirty(node);
            return;
        }
    }
}

export fn yogaNodeRemoveAllChildren(node: *Node) void {
    for (node.children.items) |child| {
        child.parent = null;
    }
    node.children.clearRetainingCapacity();
    refreshMeasureSubtreeUpwards(node);
    refreshAbsoluteSubtreeUpwards(node);
    markDirty(node);
}

export fn yogaNodeGetChild(node: *Node, index: u32) ?*Node {
    const child_index = @as(usize, @intCast(index));
    if (child_index >= node.children.items.len) return null;
    return node.children.items[child_index];
}

export fn yogaNodeGetChildCount(node: *const Node) u32 {
    return @intCast(node.children.items.len);
}

export fn yogaNodeGetParent(node: *Node) ?*Node {
    return node.parent;
}

pub export fn yogaNodeCalculateLayout(node: *Node, width: f32, height: f32, direction: u32) void {
    current_layout_generation +%= 1;
    if (current_layout_generation == 0) current_layout_generation = 1;

    const layout_direction: Direction = switch (@as(Direction, @enumFromInt(direction))) {
        .inherit => .ltr,
        else => |value| value,
    };
    current_root_direction = layout_direction;

    if (node.has_cached_layout and node.cached_direction != layout_direction) {
        markDirtyRecursiveNoCallback(node);
    }
    const resolved_width = nodeOuterWidthFromStyle(node, null, null, layout_direction) orelse optionalSize(width);
    const resolved_height = nodeOuterHeightFromStyle(node, null, null, layout_direction) orelse optionalSize(height);
    setRootLayout(node, resolved_width, resolved_height, layout_direction);
    const point_scale_factor = if (node.config) |config| config.point_scale_factor else 1;
    roundChangedLayoutRecursive(node, 0, 0, point_scale_factor, false);
    markCleanDirtyRecursive(node);
    node.has_new_layout = true;
}

export fn yogaNodeIsDirty(node: *const Node) bool {
    return node.dirty;
}

export fn yogaNodeMarkDirty(node: *Node) void {
    markMeasureDirty(node);
}

export fn yogaNodeGetHasNewLayout(node: *const Node) bool {
    return node.has_new_layout;
}

export fn yogaNodeSetHasNewLayout(node: *Node, has_new_layout: bool) void {
    node.has_new_layout = has_new_layout;
}

export fn yogaNodeSetIsReferenceBaseline(node: *Node, is_reference_baseline: bool) void {
    node.is_reference_baseline = is_reference_baseline;
}

export fn yogaNodeIsReferenceBaseline(node: *const Node) bool {
    return node.is_reference_baseline;
}

export fn yogaNodeSetAlwaysFormsContainingBlock(node: *Node, always_forms_containing_block: bool) void {
    node.always_forms_containing_block = always_forms_containing_block;
}

export fn yogaNodeGetAlwaysFormsContainingBlock(node: *const Node) bool {
    return node.always_forms_containing_block;
}

pub export fn yogaNodeGetComputedLayout(node: *const Node, out_ptr: *ExternalYogaLayout) void {
    out_ptr.* = .{
        .left = node.layout.left,
        .top = node.layout.top,
        .right = node.layout.right,
        .bottom = node.layout.bottom,
        .width = node.layout.width,
        .height = node.layout.height,
    };
}

export fn yogaNodeLayoutGetEdge(node: *const Node, kind: u32, edge: u32) f32 {
    const edge_value = @as(Edge, @enumFromInt(edge));
    const rect = switch (@as(YogaEdgeLayoutKind, @enumFromInt(kind))) {
        .margin => node.layout.margin,
        .padding => node.layout.padding,
        .border => node.layout.border,
    };
    return switch (edge_value) {
        .left, .start => rect.left,
        .top => rect.top,
        .right, .end => rect.right,
        .bottom => rect.bottom,
        .horizontal => rect.left + rect.right,
        .vertical => rect.top + rect.bottom,
        .all => @max(@max(rect.left, rect.right), @max(rect.top, rect.bottom)),
    };
}

pub export fn yogaNodeStyleSetEnum(node: *Node, kind: u32, value: u32) void {
    var changed = false;
    switch (@as(YogaEnumKind, @enumFromInt(kind))) {
        .direction => {
            const next: Direction = @enumFromInt(value);
            changed = node.style.direction != next;
            node.style.direction = next;
        },
        .flex_direction => {
            const next: FlexDirection = @enumFromInt(value);
            changed = node.style.flex_direction != next;
            node.style.flex_direction = next;
        },
        .justify_content => {
            const next: Justify = @enumFromInt(value);
            changed = node.style.justify_content != next;
            node.style.justify_content = next;
        },
        .align_content => {
            const next: Align = @enumFromInt(value);
            changed = node.style.align_content != next;
            node.style.align_content = next;
        },
        .align_items => {
            const next: Align = @enumFromInt(value);
            changed = node.style.align_items != next;
            node.style.align_items = next;
        },
        .align_self => {
            const next: Align = @enumFromInt(value);
            changed = node.style.align_self != next;
            node.style.align_self = next;
        },
        .position_type => {
            const next: PositionType = @enumFromInt(value);
            changed = node.style.position_type != next;
            node.style.position_type = next;
            if (changed) refreshAbsoluteFromNode(node);
        },
        .flex_wrap => {
            const next: Wrap = @enumFromInt(value);
            changed = node.style.flex_wrap != next;
            node.style.flex_wrap = next;
        },
        .overflow => {
            const next: Overflow = @enumFromInt(value);
            changed = node.style.overflow != next;
            node.style.overflow = next;
        },
        .display => {
            const next: Display = @enumFromInt(value);
            changed = node.style.display != next;
            node.style.display = next;
        },
        .box_sizing => {
            const next: BoxSizing = @enumFromInt(value);
            changed = node.style.box_sizing != next;
            node.style.box_sizing = next;
        },
    }
    if (changed) markDirty(node);
}

export fn yogaNodeStyleGetEnum(node: *const Node, kind: u32) u32 {
    return switch (@as(YogaEnumKind, @enumFromInt(kind))) {
        .direction => enumValue(node.style.direction),
        .flex_direction => enumValue(node.style.flex_direction),
        .justify_content => enumValue(node.style.justify_content),
        .align_content => enumValue(node.style.align_content),
        .align_items => enumValue(node.style.align_items),
        .align_self => enumValue(node.style.align_self),
        .position_type => enumValue(node.style.position_type),
        .flex_wrap => enumValue(node.style.flex_wrap),
        .overflow => enumValue(node.style.overflow),
        .display => enumValue(node.style.display),
        .box_sizing => enumValue(node.style.box_sizing),
    };
}

pub export fn yogaNodeStyleSetFloat(node: *Node, kind: u32, value: f32) void {
    var changed = false;
    switch (@as(YogaFloatKind, @enumFromInt(kind))) {
        .flex => {
            changed = !styleFloatEqual(node.style.flex, value);
            node.style.flex = value;
        },
        .flex_grow => {
            changed = !styleFloatEqual(node.style.flex_grow, value);
            node.style.flex_grow = value;
        },
        .flex_shrink => {
            changed = !styleFloatEqual(node.style.flex_shrink, value);
            node.style.flex_shrink = value;
        },
        .aspect_ratio => {
            changed = !styleFloatEqual(node.style.aspect_ratio, value);
            node.style.aspect_ratio = value;
        },
    }
    if (changed) markDirty(node);
}

export fn yogaNodeStyleGetFloat(node: *const Node, kind: u32) f32 {
    return switch (@as(YogaFloatKind, @enumFromInt(kind))) {
        .flex => node.style.flex,
        .flex_grow => node.style.flex_grow,
        .flex_shrink => node.style.flex_shrink,
        .aspect_ratio => node.style.aspect_ratio,
    };
}

export fn yogaNodeStyleSetBorder(node: *Node, edge: u32, border: f32) void {
    if (styleFloatEqual(node.style.border[edge], border)) return;
    node.style.border[edge] = border;
    node.style.has_border_values = !borderValuesAllUndefined(&node.style.border);
    markDirty(node);
}

export fn yogaNodeStyleGetBorder(node: *const Node, edge: u32) f32 {
    return node.style.border[edge];
}

pub export fn yogaNodeStyleSetValue(node: *Node, kind: u32, edge_or_gutter: u32, unit: u32, value: f32) void {
    const style_value = switch (@as(Unit, @enumFromInt(unit))) {
        .undefined => StyleValue.undef(),
        .point => StyleValue.point(value),
        .percent => StyleValue.percent(value),
        .auto => StyleValue.auto(),
    };

    const value_kind: YogaValueKind = @enumFromInt(kind);
    var current: *StyleValue = switch (value_kind) {
        .width => &node.style.width,
        .height => &node.style.height,
        .min_width => &node.style.min_width,
        .min_height => &node.style.min_height,
        .max_width => &node.style.max_width,
        .max_height => &node.style.max_height,
        .flex_basis => &node.style.flex_basis,
        .margin => &node.style.margin[edge_or_gutter],
        .padding => &node.style.padding[edge_or_gutter],
        .position => &node.style.position[edge_or_gutter],
        .gap => &node.style.gap[edge_or_gutter],
    };
    if (current.eql(style_value)) {
        return;
    }
    current.* = style_value;
    refreshStyleValueFlags(&node.style, value_kind);
    markDirty(node);
}

pub export fn yogaNodeStyleGetValue(node: *const Node, kind: u32, edge_or_gutter: u32) u64 {
    const value = switch (@as(YogaValueKind, @enumFromInt(kind))) {
        .width => node.style.width,
        .height => node.style.height,
        .min_width => node.style.min_width,
        .min_height => node.style.min_height,
        .max_width => node.style.max_width,
        .max_height => node.style.max_height,
        .flex_basis => node.style.flex_basis,
        .margin => node.style.margin[edge_or_gutter],
        .padding => node.style.padding[edge_or_gutter],
        .position => node.style.position[edge_or_gutter],
        .gap => node.style.gap[edge_or_gutter],
    };
    return packValue(value);
}

pub export fn yogaNodeSetMeasureFunc(node: *Node, callback: ?*const anyopaque) void {
    node.measure_callback = callback;
    refreshMeasureSubtreeUpwards(node);
    markDirtyWithoutCallback(node, true);
}

export fn yogaNodeUnsetMeasureFunc(node: *Node) void {
    node.measure_callback = null;
    refreshMeasureSubtreeUpwards(node);
    markDirtyWithoutCallback(node, true);
}

pub export fn yogaNodeHasMeasureFunc(node: *const Node) bool {
    return node.measure_callback != null;
}

pub export fn yogaNodeSetDirtiedFunc(node: *Node, callback: ?*const anyopaque) void {
    node.dirtied_callback = callback;
}

export fn yogaNodeUnsetDirtiedFunc(node: *Node) void {
    node.dirtied_callback = null;
}

export fn yogaStoreMeasureResult(width: f32, height: f32) void {
    tls_measure_width = width;
    tls_measure_height = height;
}
