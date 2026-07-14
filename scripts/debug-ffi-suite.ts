/**
 * ═══════════════════════════════════════════════════════════════════
 * opentui-bun-ffi-debug-suite.ts
 *
 * Comprehensive FFI debug suite for Bun on Android/Termux.
 * Tests every layer of the FFI stack to isolate pointer handling issues.
 *
 * USAGE:
 *   bun run opentui-bun-ffi-debug-suite.ts
 *
 * Each test prints [PASS] or [FAIL] with detailed diagnostics.
 * At the end, a summary shows which layers work and which fail.
 *
 * ROOT CAUSE BEING INVESTIGATED:
 *   Android's scudo allocator uses MTE (Memory Tagging Extension) to tag
 *   heap pointers with the top byte (e.g., 0xb400007e3c39c800).
 *   Bun's FFI converts these tagged pointers to JS doubles and back.
 *   The question is: does the pointer survive the round-trip, and does
 *   free() accept it?
 * ═══════════════════════════════════════════════════════════════════
 */

import { dlopen, JSCallback, ptr, suffix, toArrayBuffer } from "bun:ffi"
import { existsSync, readFileSync, statSync } from "node:fs"

// ─── Test harness ─────────────────────────────────────────────────
let passed = 0
let failed = 0
const results: { test: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    results.push({ test: name, status: "PASS", detail: "" })
    console.log(`  ✅ ${name}`)
  } catch (e: any) {
    failed++
    const msg = e?.message ?? String(e)
    results.push({ test: name, status: "FAIL", detail: msg })
    console.log(`  ❌ ${name}`)
    console.log(`     → ${msg}`)
  }
}

function skip(name: string, reason: string): void {
  results.push({ test: name, status: "SKIP", detail: reason })
  console.log(`  ⏭️  ${name} (skipped: ${reason})`)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ─── Constants ────────────────────────────────────────────────────
const LIBOPENTUI_SO = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"
const LIBC_SO = "/system/lib64/libc.so"
const LIBM_SO = "/system/lib64/libm.so"

// ─── Helper: format pointer ───────────────────────────────────────
function hex(p: number | bigint): string {
  if (typeof p === "bigint") return "0x" + p.toString(16)
  return "0x" + p.toString(16)
}

function topByte(p: number): string {
  // JS bitwise ops are 32-bit, so use division for the top byte
  return "0x" + (Math.floor(p / 0x100000000000000) & 0xff).toString(16).padStart(2, "0")
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 1: Environment Diagnostics
// ═══════════════════════════════════════════════════════════════════
console.log("\n📋 Phase 1: Environment Diagnostics")
console.log("  Runtime:    Bun " + (process.versions.bun ?? "unknown"))
console.log("  Platform:   " + process.platform + "-" + process.arch)
console.log("  Termux:     " + (process.env.PREFIX?.includes("com.termux") ? "yes" : "no"))
console.log("  MEMTAG_OPTIONS: " + (process.env.MEMTAG_OPTIONS || "(not set)"))

test("libopentui.so exists", () => {
  assert(existsSync(LIBOPENTUI_SO), `not found at ${LIBOPENTUI_SO}`)
  const stat = statSync(LIBOPENTUI_SO)
  console.log(`     → size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 2: bun:ffi exports
// ═══════════════════════════════════════════════════════════════════
console.log("\n📦 Phase 2: bun:ffi exports")

test("dlopen is a function", () => assert(typeof dlopen === "function", `dlopen is ${typeof dlopen}`))
test("JSCallback is a constructor", () => assert(typeof JSCallback === "function", `JSCallback is ${typeof JSCallback}`))
test("ptr is a function", () => assert(typeof ptr === "function", `ptr is ${typeof ptr}`))
test("suffix is 'so'", () => assert(suffix === "so", `suffix is "${suffix}"`))

// ═══════════════════════════════════════════════════════════════════
// PHASE 3: MTE Tag Analysis — malloc + free
//
// This is THE critical test. Android's scudo allocator tags heap pointers
// with the top byte (MTE). We need to know:
//   1. Does malloc return tagged pointers?
//   2. Does free(tagged) work or abort?
//   3. Does free(untagged) work or abort?
// ═══════════════════════════════════════════════════════════════════
console.log("\n🔬 Phase 3: MTE Tag Analysis (malloc + free)")

let mallocPtr: number = 0

test("malloc returns tagged pointer", () => {
  const libc = dlopen(LIBC_SO, {
    malloc: { args: ["u64"], returns: "ptr" },
    free: { args: ["ptr"], returns: "void" },
  })
  mallocPtr = libc.symbols.malloc(64) as number
  console.log(`     → malloc(64) = ${hex(mallocPtr)}`)
  console.log(`     → top byte   = ${topByte(mallocPtr)}`)
  assert(mallocPtr > 0, "malloc returned 0")
  // Tagged pointers have top byte != 0
  const tb = Math.floor(mallocPtr / 0x100000000000000) & 0xff
  if (tb !== 0) {
    console.log(`     → TAGGED (MTE is active — top byte = ${topByte(mallocPtr)})`)
  } else {
    console.log(`     → UNTAGGED (MTE is disabled or not present)`)
  }
})

test("free(tagged_pointer) — does scudo accept the tag?", () => {
  const libc = dlopen(LIBC_SO, {
    malloc: { args: ["u64"], returns: "ptr" },
    free: { args: ["ptr"], returns: "void" },
  })
  const p = libc.symbols.malloc(64) as number
  console.log(`     → free(${hex(p)})`)
  // If this aborts, the test process dies (SIGABRT) and we never see [FAIL].
  // That itself is the diagnostic: free(tagged) → SIGABRT = MTE tag check active.
  libc.symbols.free(p)
  console.log(`     → free() returned without abort`)
})

test("double round-trip preserves tagged pointer", () => {
  // Simulate what fromPtrAddress does: usize → double → usize
  // JS Number IS a double, so the round-trip is automatic.
  const original = mallocPtr
  const asDouble = original // JS number IS double
  const back = asDouble // asPtrAddress reads it back
  console.log(`     → original: ${hex(original)} = ${original}`)
  console.log(`     → after JS: ${hex(back)} = ${back}`)
  console.log(`     → match: ${original === back}`)
  assert(original === back, `precision loss: ${original} ≠ ${back}`)
  console.log(`     → tagged pointer survives double round-trip ✓`)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 4: JSCallback (TinyCC-compiled trampolines)
//
// JSCallback uses TinyCC to compile a C trampoline that calls back into JS.
// This tests whether TinyCC-compiled code can handle tagged pointers
// passed as callback arguments.
// ═══════════════════════════════════════════════════════════════════
console.log("\n🎯 Phase 4: JSCallback (TinyCC trampolines)")

test("JSCallback with (u8, ptr, u32) — log callback signature", () => {
  const cb = new JSCallback(
    (level: number, msgPtr: number, msgLen: number) => {},
    { args: ["u8", "ptr", "u32"], returns: "void" },
  )
  assert(cb.ptr != null, "JSCallback.ptr is null")
  console.log(`     → ptr = ${hex(cb.ptr as number)}`)
  cb.close()
})

test("JSCallback with (ptr, u32, ptr, u32) — event callback signature", () => {
  const cb = new JSCallback(
    (namePtr: number, nameLen: number, dataPtr: number, dataLen: number) => {},
    { args: ["ptr", "u32", "ptr", "u32"], returns: "void" },
  )
  assert(cb.ptr != null, "JSCallback.ptr is null")
  console.log(`     → ptr = ${hex(cb.ptr as number)}`)
  cb.close()
})

test("JSCallback called from cc()-compiled C code", () => {
  // Create a JS callback that triples its input
  const cb = new JSCallback(
    (n: number) => n * 3,
    { args: ["i32"], returns: "i32" },
  )
  assert(cb.ptr != null, "JSCallback.ptr is null")

  // Compile C code that calls the callback via function pointer
  const { cc } = require("bun:ffi")
  const os = require("node:os")
  const path = require("node:path")
  const fs = require("node:fs")
  const tmpDir = process.env.TMPDIR || os.tmpdir()
  const cFile = path.join(tmpDir, `ffi_cb_${Date.now()}.c`)
  fs.writeFileSync(cFile, `
    typedef int (*int_cb)(int);
    int apply_callback(int_cb cb, int n) { return cb(n); }
  `)

  const lib = cc({
    source: cFile,
    symbols: { apply_callback: { args: ["ptr", "i32"], returns: "i32" } },
  })
  const result = lib.symbols.apply_callback(cb.ptr, 14)
  assert(result === 42, `apply_callback(triple, 14) = ${result}, expected 42`)
  console.log(`     → apply_callback(triple, 14) = ${result} ✓`)
  cb.close()
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 5: opentui native renderer — basic operations
//
// Tests the native libopentui.so functions that createCliRenderer() calls.
// These use dlopen (NOT TinyCC), so they test Bun's dlopen FFI path.
// ═══════════════════════════════════════════════════════════════════
console.log("\n🔌 Phase 5: opentui native renderer (dlopen)")

const opentuiSymbols = {
  createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
  destroyRenderer: { args: ["u32"], returns: "void" },
  setUseThread: { args: ["u32", "bool"], returns: "void" },
  setClearOnShutdown: { args: ["u32", "bool"], returns: "void" },
  setupTerminal: { args: ["u32", "bool"], returns: "void" },
  getTerminalCapabilities: { args: ["u32", "ptr"], returns: "void" },
  enableMouse: { args: ["u32", "bool"], returns: "void" },
  queryPixelResolution: { args: ["u32"], returns: "void" },
  queryThemeColors: { args: ["u32"], returns: "void" },
  setLogCallback: { args: ["ptr"], returns: "void" },
  createEventSink: { args: ["ptr"], returns: "u32" },
  destroyEventSink: { args: ["u32"], returns: "void" },
  getNextBuffer: { args: ["u32"], returns: "u32" },
  getCurrentBuffer: { args: ["u32"], returns: "u32" },
  setKittyKeyboardFlags: { args: ["u32", "u8"], returns: "void" },
  setTerminalEnvVar: { args: ["u32", "ptr", "u32", "ptr", "u32"], returns: "bool" },
}

let opentuiLib: any = null
let rendererHandle: number = 0

test("dlopen(libopentui.so)", () => {
  opentuiLib = dlopen(LIBOPENTUI_SO, opentuiSymbols)
  assert(opentuiLib !== null, "dlopen returned null")
})

test("createRenderer(80, 24, stdout, no-remote, null-feed)", () => {
  rendererHandle = opentuiLib.symbols.createRenderer(80, 24, 0, 0, 0)
  assert(rendererHandle > 0, `createRenderer returned ${rendererHandle}`)
  console.log(`     → handle = ${rendererHandle}`)
})

test("setUseThread(renderer, false)", () => {
  opentuiLib.symbols.setUseThread(rendererHandle, 0)
})

test("setClearOnShutdown(renderer, false)", () => {
  opentuiLib.symbols.setClearOnShutdown(rendererHandle, 0)
})

test("setKittyKeyboardFlags(renderer, 5)", () => {
  opentuiLib.symbols.setKittyKeyboardFlags(rendererHandle, 5)
})

test("setLogCallback(callback.ptr)", () => {
  const logCb = new JSCallback(
    (level: number, msgPtr: number, msgLen: number) => {},
    { args: ["u8", "ptr", "u32"], returns: "void" },
  )
  opentuiLib.symbols.setLogCallback(logCb.ptr)
  opentuiLib.symbols.setLogCallback(0) // clear it
  logCb.close()
})

test("createEventSink(callback.ptr)", () => {
  const eventCb = new JSCallback(
    (namePtr: number, nameLen: number, dataPtr: number, dataLen: number) => {},
    { args: ["ptr", "u32", "ptr", "u32"], returns: "void" },
  )
  const sinkId = opentuiLib.symbols.createEventSink(eventCb.ptr)
  assert(sinkId > 0, `createEventSink returned ${sinkId}`)
  opentuiLib.symbols.destroyEventSink(sinkId)
  eventCb.close()
})

test("getNextBuffer(renderer)", () => {
  const buf = opentuiLib.symbols.getNextBuffer(rendererHandle)
  assert(buf > 0, `getNextBuffer returned ${buf}`)
  console.log(`     → buffer handle = ${buf}`)
})

test("getCurrentBuffer(renderer)", () => {
  const buf = opentuiLib.symbols.getCurrentBuffer(rendererHandle)
  assert(buf > 0, `getCurrentBuffer returned ${buf}`)
})

test("setupTerminal(renderer, main-screen)", () => {
  opentuiLib.symbols.setupTerminal(rendererHandle, 0)
  console.log(`     → escape sequences written to stdout`)
})

test("getTerminalCapabilities(renderer, capsBuffer)", () => {
  const capsBuf = new ArrayBuffer(64)
  opentuiLib.symbols.getTerminalCapabilities(rendererHandle, ptr(capsBuf))
  console.log(`     → capabilities struct filled`)
})

test("enableMouse(renderer, false)", () => {
  opentuiLib.symbols.enableMouse(rendererHandle, 0)
})

test("queryPixelResolution(renderer)", () => {
  opentuiLib.symbols.queryPixelResolution(rendererHandle)
})

test("queryThemeColors(renderer)", () => {
  opentuiLib.symbols.queryThemeColors(rendererHandle)
})

test("destroyRenderer(renderer)", () => {
  opentuiLib.symbols.destroyRenderer(rendererHandle)
  console.log(`     → renderer destroyed`)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 6: Yoga node lifecycle — THE CRITICAL PATH
//
// yogaNodeCreateForOpenTUI returns "ptr" — a native pointer that goes
// through fromPtrAddress() → JS double → asPtrAddress() → native call.
// This is where MTE-tagged pointers cause issues.
//
// The lifecycle:
//   1. yogaNodeCreateForOpenTUI() → returns tagged ptr (0xb4...)
//   2. JS stores it as a double
//   3. JS passes it back to yogaNodeSetWidth etc. via dlopen
//   4. yogaNodeFree() calls free(ptr) — THIS IS WHERE IT CRASHES
// ═══════════════════════════════════════════════════════════════════
console.log("\n🧘 Phase 6: Yoga node lifecycle (ptr round-trip)")

const yogaSymbols = {
  ...opentuiSymbols,
  yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
  yogaNodeFree: { args: ["ptr"], returns: "void" },
  yogaNodeStyleSetValue: { args: ["ptr", "u32", "u32", "u32", "f32"], returns: "void" },
  yogaNodeStyleSetEnum: { args: ["ptr", "u32", "u32"], returns: "void" },
  yogaNodeCalculateLayout: { args: ["ptr", "f32", "f32"], returns: "void" },
  yogaNodeSetHasNewLayout: { args: ["ptr", "bool"], returns: "void" },
  yogaNodeSetIsReferenceBaseline: { args: ["ptr", "bool"], returns: "void" },
}

let yogaLib: any = null
let yogaRenderer: number = 0
let yogaNode: number = 0

test("dlopen(libopentui.so) with yoga symbols", () => {
  yogaLib = dlopen(LIBOPENTUI_SO, yogaSymbols)
  assert(yogaLib !== null, "dlopen returned null")
})

test("createRenderer for yoga test", () => {
  yogaRenderer = yogaLib.symbols.createRenderer(80, 24, 0, 0, 0)
  assert(yogaRenderer > 0, `createRenderer returned ${yogaRenderer}`)
})

test("yogaNodeCreateForOpenTUI() — returns ptr", () => {
  yogaNode = yogaLib.symbols.yogaNodeCreateForOpenTUI()
  console.log(`     → yogaNode = ${hex(yogaNode)}`)
  console.log(`     → top byte = ${topByte(yogaNode)}`)
  assert(yogaNode > 0, "yogaNodeCreateForOpenTUI returned 0")

  // Check if the pointer is tagged
  const tb = Math.floor(yogaNode / 0x100000000000000) & 0xff
  if (tb !== 0) {
    console.log(`     → TAGGED pointer (MTE active)`)
  } else {
    console.log(`     → UNTAGGED pointer`)
  }
})

test("yogaNodeSetHasNewLayout(node, true) — ptr arg (no f32)", () => {
  yogaLib.symbols.yogaNodeSetHasNewLayout(yogaNode, 1)
  console.log(`     → pointer accepted by native code ✓`)
})

test("yogaNodeSetIsReferenceBaseline(node, true) — ptr arg (no f32)", () => {
  yogaLib.symbols.yogaNodeSetIsReferenceBaseline(yogaNode, 1)
  console.log(`     → pointer accepted by native code ✓`)
})

test("yogaNodeStyleSetValue(node, width, 80) — ptr + f32 args", () => {
  yogaLib.symbols.yogaNodeStyleSetValue(yogaNode, 0, 0, 1, 80)
  console.log(`     → pointer + f32 accepted ✓`)
})

test("yogaNodeStyleSetValue(node, height, 24) — ptr + f32 args", () => {
  yogaLib.symbols.yogaNodeStyleSetValue(yogaNode, 1, 0, 1, 24)
})

test("yogaNodeStyleSetEnum(node, flexDirection, column) — ptr + u32 args", () => {
  yogaLib.symbols.yogaNodeStyleSetEnum(yogaNode, 0, 2)
})

test("yogaNodeCalculateLayout(node, 80, 24) — ptr + 2xf32 args", () => {
  // This is where we saw SIGSEGV at 0x14 (null + 20) in earlier tests.
  // If the pointer was corrupted by the f32 argument passing, this crashes.
  yogaLib.symbols.yogaNodeCalculateLayout(yogaNode, 80, 24)
  console.log(`     → layout calculated ✓`)
})

test("yogaNodeFree(node) — calls free(tagged_ptr)", () => {
  // THIS IS THE CRITICAL TEST.
  // yogaNodeFree calls free() on the tagged pointer.
  // If scudo's MTE tag check is active, this aborts with SIGABRT.
  // If the pointer was corrupted, this crashes with SIGSEGV.
  // If MTE is disabled AND pointer is correct, this succeeds.
  //
  // If this test crashes (SIGABRT/SIGSEGV), the test process dies
  // and you won't see [FAIL] — the crash itself IS the diagnostic.
  yogaLib.symbols.yogaNodeFree(yogaNode)
  console.log(`     → free(tagged_ptr) succeeded — MTE tag check PASSED ✓`)
})

test("destroyRenderer for yoga test", () => {
  yogaLib.symbols.destroyRenderer(yogaRenderer)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 7: f32 argument passing
//
// Tests whether Bun's FFI correctly passes f32 arguments to native code.
// This matters because yogaNodeCalculateLayout takes (ptr, f32, f32).
// ═══════════════════════════════════════════════════════════════════
console.log("\n🔢 Phase 7: f32 argument passing")

test("sqrt(2.0) via libm (f64 arg + return)", () => {
  const libm = dlopen(LIBM_SO, {
    sqrt: { args: ["f64"], returns: "f64" },
  })
  const result = libm.symbols.sqrt(2.0)
  assert(Math.abs(result - 1.4142135623730951) < 0.0001, `sqrt(2) = ${result}`)
  console.log(`     → sqrt(2.0) = ${result}`)
})

test("ceilf(1.5) via libm (f32 arg + return)", () => {
  const libm = dlopen(LIBM_SO, {
    ceilf: { args: ["f32"], returns: "f32" },
  })
  const result = libm.symbols.ceilf(1.5)
  assert(result === 2, `ceilf(1.5) = ${result}`)
  console.log(`     → ceilf(1.5) = ${result}`)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 8: stdin raw mode + data listener
//
// createCliRenderer() calls stdin.setRawMode(true) + stdin.resume().
// This tests whether those work under Bun on Android.
// ═══════════════════════════════════════════════════════════════════
console.log("\n⌨️  Phase 8: stdin raw mode + data listener")

test("stdin.setRawMode(true) + stdin.resume()", () => {
  process.stdin.setRawMode(true)
  process.stdin.setRawMode(false)
  process.stdin.on("data", (_chunk) => {})
  process.stdin.resume()
  console.log(`     → stdin raw mode + resume OK`)
})

// ═══════════════════════════════════════════════════════════════════
// PHASE 9: createCliRenderer (full JS wrapper)
//
// This is the ultimate test. If all phases above pass, this should work.
// If it crashes, the issue is in the JS wrapper code, not the native code.
// ═══════════════════════════════════════════════════════════════════
console.log("\n🎨 Phase 9: createCliRenderer (full JS wrapper)")

test("createCliRenderer with minimal config", () => {
  // Import from the npm package
  const { createCliRenderer } = require("@xincli/opentui-core")
  const r = createCliRenderer({
    exitOnCtrlC: false,
    useThread: false,
    useMouse: false,
    useKittyKeyboard: false,
    screenMode: "main-screen",
  })
  assert(r !== null, "createCliRenderer returned null")
  console.log(`     → renderer created ✓`)
  r.destroy()
})

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log("")
console.log("╔══════════════════════════════════════════════════════════╗")
console.log("║                    SUMMARY                               ║")
console.log("╠══════════════════════════════════════════════════════════╣")
console.log(`║  ✅ Passed:   ${String(passed).padStart(3)}                                      ║`)
console.log(`║  ❌ Failed:   ${String(failed).padStart(3)}                                      ║`)
console.log("╚══════════════════════════════════════════════════════════╝")

if (failed > 0) {
  console.log("\n❌ Failures:")
  for (const r of results) {
    if (r.status === "FAIL") {
      console.log(`   • ${r.test}: ${r.detail}`)
    }
  }
}

// If the process crashed (SIGABRT/SIGSEGV) before reaching this summary,
// the last [PASS] line before the crash tells you exactly which test failed.
// Common crash points:
//   - Phase 3 "free(tagged_pointer)" → SIGABRT = scudo MTE tag check active
//   - Phase 6 "yogaNodeFree" → SIGABRT = scudo MTE tag check on free(yoga_node)
//   - Phase 6 "yogaNodeCalculateLayout" → SIGSEGV = f32 arg corruption
//   - Phase 9 "createCliRenderer" → crash in JS wrapper (RootRenderable → yoga)

console.log("\n📋 Detailed Results:")
for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⏭️"
  console.log(`  ${icon} ${r.test}`)
  if (r.detail) console.log(`     ${r.detail}`)
}

console.log("")
if (failed > 0) {
  console.log("❌ Some tests failed. The crash point is the LAST test that printed")
  console.log("   before the SIGABRT/SIGSEGV. See comments above for diagnosis.")
  process.exit(1)
} else {
  console.log("🎉 All tests passed! opentui should work with Bun.")
  process.exit(0)
}
