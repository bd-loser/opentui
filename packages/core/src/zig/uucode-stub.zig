// uucode-stub.zig — Stub module for android builds.
//
// Provides empty implementations of the uucode API used by utf8.zig.
// Grapheme breaking returns false (no breaks), East Asian width returns
// neutral, general category returns unassigned. This means text wrapping
// won't handle complex grapheme clusters (emoji sequences, combining
// marks) but the core renderer works fine.

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
        nonspacing_mark,
        spacing_mark,
        enclosing_mark,
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
        default: BreakState = .{},

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
