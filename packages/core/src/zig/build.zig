const std = @import("std");
const builtin = @import("builtin");

const SupportedZigVersion = struct {
    major: u32,
    minor: u32,
    patch: u32,
};

const SUPPORTED_ZIG_VERSIONS = [_]SupportedZigVersion{
    .{ .major = 0, .minor = 15, .patch = 2 },
};

const SupportedTarget = struct {
    zig_target: []const u8,
    output_name: []const u8,
    description: []const u8,
};

// Unpinned linux-gnu targets can bind host libm symbols such as GLIBC_2.29.
const SUPPORTED_TARGETS = [_]SupportedTarget{
    .{ .zig_target = "x86_64-linux-gnu.2.17", .output_name = "x86_64-linux", .description = "Linux x86_64" },
    .{ .zig_target = "aarch64-linux-gnu.2.17", .output_name = "aarch64-linux", .description = "Linux aarch64" },
    .{ .zig_target = "x86_64-linux-musl", .output_name = "x86_64-linux-musl", .description = "Linux x86_64 (musl)" },
    .{ .zig_target = "aarch64-linux-musl", .output_name = "aarch64-linux-musl", .description = "Linux aarch64 (musl)" },
    .{ .zig_target = "x86_64-macos", .output_name = "x86_64-macos", .description = "macOS x86_64 (Intel)" },
    .{ .zig_target = "aarch64-macos", .output_name = "aarch64-macos", .description = "macOS aarch64 (Apple Silicon)" },
    .{ .zig_target = "x86_64-windows-gnu", .output_name = "x86_64-windows", .description = "Windows x86_64" },
    .{ .zig_target = "aarch64-windows-gnu", .output_name = "aarch64-windows", .description = "Windows aarch64" },
    // ── XINCLI: Android/Termux support ─────────────────────────────────
    // Targets Android (Bionic libc) on aarch64 — the only Android arch
    // Termux realistically runs on in 2026. The NDK sysroot must be passed
    // via --sysroot; see the `build-android` workflow for the exact flags.
    // The .so produced here is loaded by @xincli/opentui-core-android-arm64
    // at runtime inside cli.mjs on the user's phone.
    .{ .zig_target = "aarch64-linux-android", .output_name = "aarch64-android", .description = "Android aarch64 (Termux)" },
    .{ .zig_target = "arm-linux-android", .output_name = "arm-android", .description = "Android armv7 (legacy Termux)" },
    .{ .zig_target = "x86_64-linux-android", .output_name = "x86_64-android", .description = "Android x86_64 (emulator)" },
};

const DEFAULT_MACOS_SDK_PATH = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";

const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "lib.zig";

const YOGA_CXX_FLAGS = [_][]const u8{
    "-std=c++20",
    "-fexceptions",
    "-frtti",
};

const YOGA_CXX_SOURCES = [_][]const u8{
    "yoga/YGConfig.cpp",
    "yoga/YGEnums.cpp",
    "yoga/YGNode.cpp",
    "yoga/YGNodeLayout.cpp",
    "yoga/YGNodeStyle.cpp",
    "yoga/YGPixelGrid.cpp",
    "yoga/YGValue.cpp",
    "yoga/algorithm/AbsoluteLayout.cpp",
    "yoga/algorithm/Baseline.cpp",
    "yoga/algorithm/Cache.cpp",
    "yoga/algorithm/CalculateLayout.cpp",
    "yoga/algorithm/FlexLine.cpp",
    "yoga/algorithm/PixelGrid.cpp",
    "yoga/config/Config.cpp",
    "yoga/debug/AssertFatal.cpp",
    "yoga/debug/Log.cpp",
    "yoga/event/event.cpp",
    "yoga/node/LayoutResults.cpp",
    "yoga/node/Node.cpp",
};

fn nativeExecutableTarget(b: *std.Build) std.Build.ResolvedTarget {
    if (builtin.os.tag != .linux) {
        return b.resolveTargetQuery(.{});
    }

    // Zig 0.15.2's ELF linker currently fails on newer glibc startup objects
    // that ship .sframe relocations. Keep shipped libraries on linux-gnu, but
    // use musl for local native executables so test/debug/bench still work.
    var query = b.graph.host.query;
    query.abi = .musl;
    query.glibc_version = null;
    return b.resolveTargetQuery(query);
}

fn pathExists(path: []const u8) bool {
    if (path.len == 0) return false;
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

fn isMacOSSDKPath(path: []const u8) bool {
    const trimmed_path = std.mem.trimRight(u8, path, "/");
    if (trimmed_path.len == 0) return false;

    const base_name = std.fs.path.basename(trimmed_path);
    return std.mem.startsWith(u8, base_name, "MacOSX") and std.mem.endsWith(u8, base_name, ".sdk");
}

fn macOSSDKHasFramework(b: *std.Build, sdk_path: []const u8, framework: []const u8) bool {
    return pathExists(b.pathJoin(&.{ sdk_path, "System", "Library", "Frameworks", b.fmt("{s}.framework", .{framework}) }));
}

fn isMacOSSDKAvailable(b: *std.Build, sdk_path: []const u8) bool {
    return isMacOSSDKPath(sdk_path) and
        pathExists(b.pathJoin(&.{ sdk_path, "usr", "lib" })) and
        macOSSDKHasFramework(b, sdk_path, "CoreFoundation") and
        macOSSDKHasFramework(b, sdk_path, "CoreAudio") and
        macOSSDKHasFramework(b, sdk_path, "AudioToolbox");
}

fn resolveMacOSSDKPath(b: *std.Build) ?[]const u8 {
    if (b.option([]const u8, "macos-sdk", "Path to a macOS SDK for CoreAudio headers and framework linking")) |sdk_path| {
        if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        std.debug.print("macOS SDK path '{s}' must be a MacOSX*.sdk with the required frameworks\n", .{sdk_path});
        return null;
    }

    const env_vars = [_][]const u8{ "SDKROOT", "MACOS_SDK_PATH", "MACOSX_SDK_PATH" };
    for (env_vars) |env_var| {
        if (b.graph.env_map.get(env_var)) |sdk_path| {
            if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        }
    }

    if (builtin.os.tag == .macos and std.zig.system.darwin.isSdkInstalled(b.allocator)) {
        const sdk_target = b.resolveTargetQuery(.{ .cpu_arch = .aarch64, .os_tag = .macos });
        if (std.zig.system.darwin.getSdk(b.allocator, &sdk_target.result)) |sdk_path| {
            if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        }
    }

    if (isMacOSSDKAvailable(b, DEFAULT_MACOS_SDK_PATH)) return DEFAULT_MACOS_SDK_PATH;
    return null;
}

fn printMissingMacOSSDK(target_description: []const u8) void {
    std.debug.print(
        "macOS SDK not found for {s}. Set SDKROOT, MACOS_SDK_PATH, or -Dmacos-sdk=/path/to/MacOSX.sdk.\n",
        .{target_description},
    );
}

fn addMiniaudioShim(
    b: *std.Build,
    artifact: *std.Build.Step.Compile,
    target: std.Build.ResolvedTarget,
    macos_sdk_path: ?[]const u8,
) void {
    const c_flags: []const []const u8 = switch (target.result.os.tag) {
        .macos => blk: {
            const flags = b.allocator.alloc([]const u8, 4) catch @panic("OOM");
            flags[0] = "-std=c99";
            flags[1] = "-DMA_NO_RUNTIME_LINKING";
            flags[2] = "-isysroot";
            flags[3] = macos_sdk_path.?;
            break :blk flags;
        },
        else => &.{"-std=c99"},
    };

    artifact.addIncludePath(b.path("."));
    // ── XINCLI: skip linkLibC() for android ───────────────────────────
    // linkLibC() emits -lm -lc -ldl that Zig tries to resolve via its own
    // libc resolution. On Termux/Android, Zig can't find Bionic properly
    // (it falls back to glibc defaults), so -lm -lc -ldl fail.
    // For android, we link the .so files directly via addObjectFile in
    // buildTarget() instead. For all other targets, linkLibC() works fine.
    if (target.result.abi != .android) {
        artifact.linkLibC();
    }
    artifact.addCSourceFile(.{
        .file = b.path("miniaudio_shim.c"),
        .flags = c_flags,
    });
}

fn addMacOSSDKSearchPaths(b: *std.Build, artifact: *std.Build.Step.Compile, sdk_path: []const u8) void {
    const include_path = b.pathJoin(&.{ sdk_path, "usr", "include" });
    const framework_path = b.pathJoin(&.{ sdk_path, "System", "Library", "Frameworks" });
    const lib_path = b.pathJoin(&.{ sdk_path, "usr", "lib" });

    artifact.addSystemIncludePath(.{ .cwd_relative = include_path });
    artifact.addSystemFrameworkPath(.{ .cwd_relative = framework_path });
    artifact.addFrameworkPath(.{ .cwd_relative = framework_path });
    artifact.addLibraryPath(.{ .cwd_relative = lib_path });
}

fn addMacOSSystemLibraries(b: *std.Build, artifact: *std.Build.Step.Compile, sdk_path: []const u8) void {
    artifact.linkFramework("CoreFoundation");
    artifact.linkFramework("CoreAudio");
    artifact.linkFramework("AudioToolbox");
    artifact.linkSystemLibrary("pthread");
    addMacOSSDKSearchPaths(b, artifact, sdk_path);
}

fn addNativeAudioDependencies(
    b: *std.Build,
    artifact: *std.Build.Step.Compile,
    target: std.Build.ResolvedTarget,
    macos_sdk_path: ?[]const u8,
) void {
    addMiniaudioShim(b, artifact, target, macos_sdk_path);

    switch (target.result.os.tag) {
        .macos => addMacOSSystemLibraries(b, artifact, macos_sdk_path.?),
        .linux => {
            // ── XINCLI: Android is linux + .android ABI in Zig, not a
            // separate OS tag. For Android, link OpenSLES directly by path
            // instead of using linkSystemLibrary — the system library
            // resolution fails because --sysroot makes Zig double the
            // addLibraryPath paths. addObjectFile bypasses the search
            // entirely and links the .so directly.
            if (target.result.abi == .android) {
                if (std.posix.getenv("XINCLI_ANDROID_LIB_PATH")) |lib_path| {
                    const opensles_path = b.pathJoin(&.{ lib_path, "libOpenSLES.so" });
                    artifact.addObjectFile(.{ .cwd_relative = opensles_path });
                } else {
                    // Fallback: try linkSystemLibrary (may fail without paths)
                    artifact.linkSystemLibrary("OpenSLES");
                }
            } else {
                artifact.linkSystemLibrary("dl");
                artifact.linkSystemLibrary("pthread");
            }
        },
        else => {},
    }
}

fn addYogaDependencies(
    b: *std.Build,
    artifact: *std.Build.Step.Compile,
    target: std.Build.ResolvedTarget,
) void {
    const yoga_dep = b.dependency("yoga", .{});

    // ── XINCLI: skip linkLibCpp() for android ─────────────────────────
    // linkLibCpp() emits -lc++ which fails on Termux (only libc++_shared.so
    // exists, not libc++.so). For android, we link libc++_shared.so directly
    // via addObjectFile in buildTarget(). For other targets, linkLibCpp() works.
    if (target.result.abi != .android) {
        artifact.linkLibCpp();
    }

    // ── XINCLI: add libc++ include path for android C++ compilation ────
    // Yoga's C++ files #include <type_traits>, <cstddef>, <cmath>, etc.
    // from the C++ standard library. linkLibCpp() normally adds libc++'s
    // include path, but we skipped it for android.
    //
    // Also: add a math.h wrapper dir FIRST in the search path. The wrapper
    // #includes the real Bionic math.h then #undefs isinf/isnan/fabs/abs
    // macros that break std::isinf in C++ context.
    if (target.result.abi == .android) {
        // libc++ headers
        if (std.posix.getenv("XINCLI_ANDROID_LIBCXX_INCLUDE")) |cxx_inc| {
            artifact.addSystemIncludePath(.{ .cwd_relative = cxx_inc });
        }
        if (std.posix.getenv("XINCLI_ANDROID_LIBCXX_INCLUDE2")) |cxx_inc2| {
            artifact.addSystemIncludePath(.{ .cwd_relative = cxx_inc2 });
        }
    }

    artifact.addIncludePath(yoga_dep.path(""));

    // ── XINCLI: Android-specific C++ flags ─────────────────────────────
    // Force-include termux-cxx-fixup.h which:
    //   1. Neutralizes _LIBCPP_USING_IF_EXISTS (the root cause of the
    //      'unresolved using declaration' error)
    //   2. Provides std::isinf/isnan/abs as inline functions calling
    //      __builtin_* directly
    //   3. #undefs the C macros after <cmath> has processed them
    if (target.result.abi == .android) {
        const android_cxx_flags = [_][]const u8{
            "-std=c++20",
            "-fexceptions",
            "-frtti",
            "-include",
            "termux-cxx-fixup.h",
        };
        artifact.addCSourceFiles(.{
            .root = yoga_dep.path(""),
            .files = &YOGA_CXX_SOURCES,
            .flags = &android_cxx_flags,
        });
    } else {
        artifact.addCSourceFiles(.{
            .root = yoga_dep.path(""),
            .files = &YOGA_CXX_SOURCES,
            .flags = &YOGA_CXX_FLAGS,
        });
    }
}

/// Apply dependencies to a module
fn applyDependencies(
    b: *std.Build,
    module: *std.Build.Module,
    optimize: std.builtin.OptimizeMode,
    target: std.Build.ResolvedTarget,
    build_options: *std.Build.Step.Options,
) void {
    module.addOptions("build_options", build_options);

    // Add uucode for grapheme break detection and width calculation
    if (b.lazyDependency("uucode", .{
        .target = target,
        .optimize = optimize,
        .fields = @as([]const []const u8, &.{
            "grapheme_break",
            "east_asian_width",
            "general_category",
            "is_emoji_presentation",
        }),
    })) |uucode_dep| {
        module.addImport("uucode", uucode_dep.module("uucode"));
    }
}

fn checkZigVersion() void {
    const current_version = builtin.zig_version;
    var is_supported = false;

    for (SUPPORTED_ZIG_VERSIONS) |supported| {
        if (current_version.major == supported.major and
            current_version.minor == supported.minor and
            current_version.patch == supported.patch)
        {
            is_supported = true;
            break;
        }
    }

    if (!is_supported) {
        std.debug.print("\x1b[31mError: Unsupported Zig version {}.{}.{}\x1b[0m\n", .{
            current_version.major,
            current_version.minor,
            current_version.patch,
        });
        std.debug.print("Supported Zig versions:\n", .{});
        for (SUPPORTED_ZIG_VERSIONS) |supported| {
            std.debug.print("  - {}.{}.{}\n", .{
                supported.major,
                supported.minor,
                supported.patch,
            });
        }
        std.debug.print("\nPlease install a supported Zig version to continue.\n", .{});
        std.process.exit(1);
    }
}

pub fn build(b: *std.Build) void {
    checkZigVersion();

    const optimize = b.standardOptimizeOption(.{});
    const bench_optimize = b.option(std.builtin.OptimizeMode, "bench-optimize", "Optimize mode for benchmarks") orelse .ReleaseFast;
    const debug_use_llvm = b.option(bool, "debug-llvm", "Use LLVM backend for debug/test artifacts");
    const target_option = b.option([]const u8, "target", "Build for specific target (e.g., 'x86_64-linux-gnu.2.17').");
    const build_all = b.option(bool, "all", "Build for all supported targets") orelse false;
    const gpa_safe_stats = b.option(bool, "gpa-safe-stats", "Enable GPA safety checks for trustworthy allocator stats") orelse false;
    const macos_sdk_path = resolveMacOSSDKPath(b);
    const build_options = b.addOptions();
    build_options.addOption(bool, "gpa_safe_stats", gpa_safe_stats);

    if (target_option) |target_str| {
        // Build single target
        buildSingleTarget(b, target_str, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building target '{s}': {}\n", .{ target_str, err });
            std.process.exit(1);
        };
    } else if (build_all) {
        // Build all supported targets
        buildAllTargets(b, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building all targets: {}\n", .{err});
            std.process.exit(1);
        };
    } else {
        // Build for native target only (default)
        buildNativeTarget(b, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building native target: {}\n", .{err});
            std.process.exit(1);
        };
    }

    // Test step (native only)
    const test_step = b.step("test", "Run unit tests");
    const native_target = nativeExecutableTarget(b);
    const test_mod = b.createModule(.{
        .root_source_file = b.path("test.zig"),
        .target = native_target,
        .optimize = .Debug,
    });
    applyDependencies(b, test_mod, .Debug, native_target, build_options);
    const test_artifact = b.addTest(.{
        .root_module = test_mod,
        .filters = if (b.option([]const u8, "test-filter", "Skip tests that do not match filter")) |f| &.{f} else &.{},
        .use_llvm = debug_use_llvm,
    });

    if (native_target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK("native macOS tests");
        std.process.exit(1);
    }
    addNativeAudioDependencies(b, test_artifact, native_target, macos_sdk_path);
    addYogaDependencies(b, test_artifact, native_target);

    const run_test = b.addRunArtifact(test_artifact);
    test_step.dependOn(&run_test.step);

    // Bench step (native only)
    const bench_step = b.step("bench", "Run benchmarks");
    const bench_mod = b.createModule(.{
        .root_source_file = b.path("bench.zig"),
        .target = native_target,
        .optimize = bench_optimize,
    });
    applyDependencies(b, bench_mod, bench_optimize, native_target, build_options);
    const bench_exe = b.addExecutable(.{
        .name = "opentui-bench",
        .root_module = bench_mod,
    });
    const run_bench = b.addRunArtifact(bench_exe);
    if (b.args) |args| {
        run_bench.addArgs(args);
    }
    bench_step.dependOn(&run_bench.step);

    const bench_ffi_step = b.step("bench-ffi", "Build NativeSpanFeed benchmark library");
    const bench_ffi_mod = b.createModule(.{
        .root_source_file = b.path("native-span-feed-bench-lib.zig"),
        .target = native_target,
        .optimize = bench_optimize,
    });
    applyDependencies(b, bench_ffi_mod, bench_optimize, native_target, build_options);
    const bench_ffi_lib = b.addLibrary(.{
        .name = "native_span_feed_bench",
        .root_module = bench_ffi_mod,
        .linkage = .dynamic,
    });
    if (native_target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK("native macOS benchmark FFI library");
        std.process.exit(1);
    }
    addNativeAudioDependencies(b, bench_ffi_lib, native_target, macos_sdk_path);
    addYogaDependencies(b, bench_ffi_lib, native_target);
    const install_bench_ffi = b.addInstallArtifact(bench_ffi_lib, .{});
    bench_ffi_step.dependOn(&install_bench_ffi.step);
    bench_step.dependOn(bench_ffi_step);

    // Debug step (native only)
    const debug_step = b.step("debug", "Run debug executable");
    const debug_mod = b.createModule(.{
        .root_source_file = b.path("debug-view.zig"),
        .target = native_target,
        .optimize = .Debug,
    });
    applyDependencies(b, debug_mod, .Debug, native_target, build_options);
    const debug_exe = b.addExecutable(.{
        .name = "opentui-debug",
        .root_module = debug_mod,
        .use_llvm = debug_use_llvm,
    });
    const run_debug = b.addRunArtifact(debug_exe);
    debug_step.dependOn(&run_debug.step);
}

fn buildAllTargets(
    b: *std.Build,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    for (SUPPORTED_TARGETS) |supported_target| {
        try buildTarget(
            b,
            supported_target.zig_target,
            supported_target.output_name,
            supported_target.description,
            optimize,
            build_options,
            macos_sdk_path,
        );
    }
}

fn buildNativeTarget(
    b: *std.Build,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    // Find the matching supported target for the native platform
    const native_arch = @tagName(builtin.cpu.arch);
    const native_os = @tagName(builtin.os.tag);

    for (SUPPORTED_TARGETS) |supported_target| {
        // Check if this target matches the native platform
        if (std.mem.indexOf(u8, supported_target.zig_target, native_arch) != null and
            std.mem.indexOf(u8, supported_target.zig_target, native_os) != null)
        {
            try buildTarget(
                b,
                supported_target.zig_target,
                supported_target.output_name,
                supported_target.description,
                optimize,
                build_options,
                macos_sdk_path,
            );
            return;
        }
    }

    std.debug.print("No matching supported target for native platform ({s}-{s})\n", .{ native_arch, native_os });
    return error.UnsupportedNativeTarget;
}

fn buildSingleTarget(
    b: *std.Build,
    target_str: []const u8,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    // Check if it matches a known target, use its output_name
    for (SUPPORTED_TARGETS) |supported_target| {
        if (std.mem.eql(u8, target_str, supported_target.zig_target)) {
            try buildTarget(
                b,
                supported_target.zig_target,
                supported_target.output_name,
                supported_target.description,
                optimize,
                build_options,
                macos_sdk_path,
            );
            return;
        }
    }
    // Custom target - use target string as output name
    const description = try std.fmt.allocPrint(b.allocator, "Custom target: {s}", .{target_str});
    try buildTarget(b, target_str, target_str, description, optimize, build_options, macos_sdk_path);
}

fn buildTarget(
    b: *std.Build,
    zig_target: []const u8,
    output_name: []const u8,
    description: []const u8,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    const target_query = try std.Target.Query.parse(.{ .arch_os_abi = zig_target });
    const target = b.resolveTargetQuery(target_query);

    if (target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK(description);
        return error.MissingMacOSSDK;
    }

    const module = b.createModule(.{
        .root_source_file = b.path(ROOT_SOURCE_FILE),
        .target = target,
        .optimize = optimize,
        // ── XINCLI: tell Zig's stdlib that libc IS available for android ─
        // We skipped linkLibC() (it emits -lm -lc -ldl that fail on Termux),
        // but Zig's stdlib needs to KNOW libc is available — otherwise
        // std.heap (free/malloc) and std.c (extern "c" fns) refuse to
        // compile with 'dependency on libc must be explicitly specified'.
        //
        // link_libc=true on the module tells the stdlib "libc symbols exist
        // at link time" WITHOUT emitting the -l flags. We link the .so files
        // directly via addObjectFile in buildTarget() instead.
        .link_libc = target.result.abi == .android,
    });

    // ── XINCLI: @cImport include path for android ──────────────────────
    // We skipped linkLibC() for android (it emits -lm -lc -ldl that fail).
    // The libc file's include_dir points at Termux's real $PREFIX/include
    // (set by build-native-termux.sh). @cImport reads it from there.
    //
    // The arch-specific asm/ headers live at $PREFIX/include/aarch64-linux-android/
    // which isn't in the default search path. Add it via addSystemIncludePath
    // so @cImport finds <asm/sigcontext.h> etc. This ONLY affects @cImport
    // (C) — C++ compilation doesn't use module include paths for system headers.
    if (target.result.abi == .android) {
        if (std.posix.getenv("XINCLI_ANDROID_ASM_INCLUDE")) |asm_inc| {
            module.addSystemIncludePath(.{ .cwd_relative = asm_inc });
        }
    }

    applyDependencies(b, module, optimize, target, build_options);

    const lib = b.addLibrary(.{
        .name = LIB_NAME,
        .root_module = module,
        .linkage = .dynamic,
    });

    // ── XINCLI: Android native build (Termux) ───────────────────────────
    // On Termux, Zig's --sysroot flag makes ld.lld look at <sysroot>/usr/lib/
    // which doesn't exist (Termux's libs are at <sysroot>/lib/). We add the
    // real lib paths explicitly via addLibraryPath, reading them from the
    // XINCLI_ANDROID_LIB_SEARCH_PATHS env var (colon-separated) set by
    // build-native-termux.sh.
    //
    // This is done in build.zig (not via LDFLAGS) because Zig's ld.lld
    // doesn't respect the LDFLAGS env var — only flags passed through the
    // build system reach the linker.

    addNativeAudioDependencies(b, lib, target, macos_sdk_path);
    addYogaDependencies(b, lib, target);

    // Add Termux lib search paths so ld.lld finds libc/libm/libdl
    if (target.result.abi == .android) {
        if (std.posix.getenv("XINCLI_ANDROID_LIB_SEARCH_PATHS")) |paths| {
            var it = std.mem.splitScalar(u8, paths, ':');
            while (it.next()) |path| {
                if (path.len > 0) {
                    lib.addLibraryPath(.{ .cwd_relative = path });
                }
            }
        }

        // ── XINCLI: link Bionic + libc++ directly by absolute path ─────
        // We skipped linkLibC() and linkLibCpp() for android (they emit
        // -lm -lc -ldl -lc++ that fail on Termux). Instead, link the .so
        // files directly via addObjectFile. Paths read from env vars set
        // by build-native-termux.sh, with /system/lib64 + $PREFIX/lib
        // fallbacks.
        const android_libs = [_]struct { env: []const u8, fallback: []const u8 }{
            .{ .env = "XINCLI_ANDROID_LIBC_PATH", .fallback = "/system/lib64/libc.so" },
            .{ .env = "XINCLI_ANDROID_LIBM_PATH", .fallback = "/system/lib64/libm.so" },
            .{ .env = "XINCLI_ANDROID_LIBDL_PATH", .fallback = "/system/lib64/libdl.so" },
            // libc++_shared.so is at $PREFIX/lib/libc++_shared.so on Termux
            .{ .env = "XINCLI_ANDROID_LIBCXX_PATH", .fallback = "/data/data/com.termux/files/usr/lib/libc++_shared.so" },
        };
        for (android_libs) |al| {
            const path = std.posix.getenv(al.env) orelse al.fallback;
            lib.addObjectFile(.{ .cwd_relative = path });
        }
    }

    const install_dir = b.addInstallArtifact(lib, .{
        .dest_dir = .{
            .override = .{
                .custom = try std.fmt.allocPrint(b.allocator, "../lib/{s}", .{output_name}),
            },
        },
    });

    const build_step_name = try std.fmt.allocPrint(b.allocator, "build-{s}", .{output_name});
    const build_step = b.step(build_step_name, try std.fmt.allocPrint(b.allocator, "Build for {s}", .{description}));
    build_step.dependOn(&install_dir.step);

    b.getInstallStep().dependOn(&install_dir.step);
}
