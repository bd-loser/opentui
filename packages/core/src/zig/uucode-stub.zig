// uucode-stub.zig — Stub module for android builds.
//
// uucode_build_tables (a build-time executable) fails to link on Termux
// because linkLibC() emits -lm -lc -ldl that Zig can't resolve for
// native executables. This stub provides the same API with neutral
// return values so the .so compiles without grapheme breaking support.

pub const types = struct {
    pub const EastAsianWidth = enum {
        narrow,
        wide,
        fullwidth,
        halfwidth,
        ambiguous,
        neutral,
    };

    pub const GeneralCategory = enum {
        unassigned,
        uppercase_letter,
        lowercase_letter,
        titlecase_letter,
        modifier_letter,
        other_letter,
        mark_nonspacing,
        mark_spacing_combining,
        mark_enclosing,
        decimal_number,
        letter_number,
        other_number,
        connector_punctuation,
        dash_punctuation,
        open_punctuation,
        close_punctuation,
        initial_punctuation,
        final_punctuation,
        other_punctuation,
        math_symbol,
        currency_symbol,
        modifier_symbol,
        other_symbol,
        space_separator,
        line_separator,
        paragraph_separator,
        control,
        format,
        surrogate,
        private_use,
    };
};

pub const grapheme = struct {
    pub const BreakState = struct {
        pub const default: BreakState = .{};
    };

    pub fn isBreak(prev_cp: ?u21, curr_cp: u21, state: *BreakState) bool {
        _ = prev_cp;
        _ = curr_cp;
        _ = state;
        return false;
    }
};

pub fn get(comptime field: anytype, cp: u21) switch (field) {
    .east_asian_width => types.EastAsianWidth,
    .general_category => types.GeneralCategory,
    else => @compileError("unknown field"),
} {
    _ = cp;
    return switch (field) {
        .east_asian_width => .neutral,
        .general_category => .unassigned,
        else => @compileError("unknown field"),
    };
}
