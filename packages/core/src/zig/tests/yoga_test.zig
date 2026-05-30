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
