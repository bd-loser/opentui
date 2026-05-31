const std = @import("std");
const yoga = @import("../yoga.zig");

const nan = std.math.nan(f32);

test "Zig Yoga computes basic flex layout" {
    const config = yoga.yogaConfigCreate();
    defer yoga.yogaConfigFree(config);

    const root = yoga.yogaNodeCreateWithConfig(config);
    defer yoga.yogaNodeFreeRecursive(root);

    yoga.yogaNodeStyleSetEnum(root, @intFromEnum(yoga.YogaEnumKind.flex_direction), @intFromEnum(yoga.FlexDirection.row));
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 100);
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 100);

    const child = yoga.yogaNodeCreateWithConfig(config);
    yoga.yogaNodeStyleSetFloat(child, @intFromEnum(yoga.YogaFloatKind.flex_grow), 1);
    yoga.yogaNodeInsertChild(root, child, 0);

    yoga.yogaNodeCalculateLayout(root, nan, nan, @intFromEnum(yoga.Direction.ltr));

    var layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(child, &layout);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.width, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 100), layout.height, 0.001);
}

test "Zig Yoga packs style values" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeStyleSetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0, @intFromEnum(yoga.Unit.point), 10);
    const packed_value = yoga.yogaNodeStyleGetValue(node, @intFromEnum(yoga.YogaValueKind.flex_basis), 0);
    const unit: u32 = @intCast(packed_value & 0xffffffff);
    const value_bits: u32 = @intCast((packed_value >> 32) & 0xffffffff);
    const value: f32 = @bitCast(value_bits);

    try std.testing.expectEqual(@as(u32, @intFromEnum(yoga.Unit.point)), unit);
    try std.testing.expectApproxEqAbs(@as(f32, 10), value, 0.001);
}

test "Zig Yoga stores dirtied callback alongside measure callback" {
    const node = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFree(node);

    yoga.yogaNodeSetMeasureFunc(node, null);
    yoga.yogaNodeSetDirtiedFunc(node, null);
    try std.testing.expect(!yoga.yogaNodeHasMeasureFunc(node));
}

test "Zig Yoga incremental column layout handles gaps and center alignment" {
    const root = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFreeRecursive(root);

    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 100);
    yoga.yogaNodeStyleSetEnum(root, @intFromEnum(yoga.YogaEnumKind.align_items), @intFromEnum(yoga.Align.center));
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.gap), @intFromEnum(yoga.Gutter.row), @intFromEnum(yoga.Unit.point), 2);

    const first = yoga.yogaNodeCreate();
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 20);
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 10);
    yoga.yogaNodeInsertChild(root, first, 0);

    const second = yoga.yogaNodeCreate();
    yoga.yogaNodeStyleSetValue(second, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 30);
    yoga.yogaNodeStyleSetValue(second, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 5);
    yoga.yogaNodeInsertChild(root, second, 1);

    yoga.yogaNodeCalculateLayout(root, nan, nan, @intFromEnum(yoga.Direction.ltr));
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 14);
    yoga.yogaNodeCalculateLayout(root, nan, nan, @intFromEnum(yoga.Direction.ltr));

    var first_layout: yoga.ExternalYogaLayout = undefined;
    var second_layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(first, &first_layout);
    yoga.yogaNodeGetComputedLayout(second, &second_layout);

    try std.testing.expectApproxEqAbs(@as(f32, 40), first_layout.left, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 35), second_layout.left, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 16), second_layout.top, 0.001);
}

test "Zig Yoga incremental column layout handles fixed height and RTL" {
    const root = yoga.yogaNodeCreate();
    defer yoga.yogaNodeFreeRecursive(root);

    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 100);
    yoga.yogaNodeStyleSetValue(root, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 80);
    yoga.yogaNodeStyleSetEnum(root, @intFromEnum(yoga.YogaEnumKind.align_items), @intFromEnum(yoga.Align.flex_end));

    const first = yoga.yogaNodeCreate();
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 20);
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 10);
    yoga.yogaNodeInsertChild(root, first, 0);

    const second = yoga.yogaNodeCreate();
    yoga.yogaNodeStyleSetValue(second, @intFromEnum(yoga.YogaValueKind.width), 0, @intFromEnum(yoga.Unit.point), 30);
    yoga.yogaNodeStyleSetValue(second, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 5);
    yoga.yogaNodeInsertChild(root, second, 1);

    yoga.yogaNodeCalculateLayout(root, nan, nan, @intFromEnum(yoga.Direction.rtl));
    yoga.yogaNodeStyleSetValue(first, @intFromEnum(yoga.YogaValueKind.height), 0, @intFromEnum(yoga.Unit.point), 14);
    yoga.yogaNodeCalculateLayout(root, nan, nan, @intFromEnum(yoga.Direction.rtl));

    var first_layout: yoga.ExternalYogaLayout = undefined;
    var second_layout: yoga.ExternalYogaLayout = undefined;
    var root_layout: yoga.ExternalYogaLayout = undefined;
    yoga.yogaNodeGetComputedLayout(root, &root_layout);
    yoga.yogaNodeGetComputedLayout(first, &first_layout);
    yoga.yogaNodeGetComputedLayout(second, &second_layout);

    try std.testing.expectApproxEqAbs(@as(f32, 0), first_layout.left, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0), second_layout.left, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 14), second_layout.top, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 80), root_layout.height, 0.001);
}
