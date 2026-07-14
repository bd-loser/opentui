/**
 * ═══════════════════════════════════════════════════════════════════
 * debug-ffi-suite.ts — Comprehensive FFI Debug Suite (crash-safe)
 *
 * Each phase runs in a SEPARATE child process so a crash (SIGABRT/
 * SIGSEGV) in one phase doesn't kill the whole suite. The parent
 * captures the child's exit code and stdout/stderr, then reports
 * PASS/FAIL/CRASH for each phase.
 *
 * USAGE:
 *   bun run scripts/debug-ffi-suite.ts
 *
 * OUTPUT:
 *   Each phase prints its result. At the end, a summary shows which
 *   phases passed, failed, or crashed (with signal info).
 * ═══════════════════════════════════════════════════════════════════
 */

import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ═══════════════════════════════════════════════════════════════════
// Test definitions — each is a self-contained script that runs in
// a child process. If it crashes, the parent detects it.
// ═══════════════════════════════════════════════════════════════════

interface Phase {
  name: string
  description: string
  code: string
}

const phases: Phase[] = [
  {
    name: "Phase 1: Environment",
    description: "Check MEMTAG_OPTIONS, .so exists, bun version",
    code: `
      console.log("MEMTAG_OPTIONS:", process.env.MEMTAG_OPTIONS || "(not set)")
      console.log("Platform:", process.platform, process.arch)
      console.log("Bun:", process.versions.bun)
      const fs = require("fs")
      const so = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"
      console.log("libopentui.so exists:", fs.existsSync(so))
      if (fs.existsSync(so)) console.log("size:", fs.statSync(so).size, "bytes")
    `,
  },
  {
    name: "Phase 2: bun:ffi exports",
    description: "Verify dlopen, JSCallback, ptr, suffix exist",
    code: `
      const ffi = require("bun:ffi")
      console.log("dlopen:", typeof ffi.dlopen)
      console.log("JSCallback:", typeof ffi.JSCallback)
      console.log("ptr:", typeof ffi.ptr)
      console.log("suffix:", ffi.suffix)
      console.log("cc:", typeof ffi.cc)
    `,
  },
  {
    name: "Phase 3: malloc returns tagged pointer?",
    description: "Check if scudo tags heap pointers with top byte",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64) =", "0x" + p.toString(16))
      const topByte = Math.floor(p / 0x100000000000000) & 0xff
      console.log("top byte =", "0x" + topByte.toString(16))
      console.log("tagged:", topByte !== 0 ? "YES (MTE active)" : "NO")
    `,
  },
  {
    name: "Phase 4: free(tagged_pointer)",
    description: "CRITICAL: does free() accept tagged pointers? SIGABRT = MTE tag check active",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
        free: { args: ["ptr"], returns: "void" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64) =", "0x" + p.toString(16))
      console.log("calling free(p)...")
      libc.symbols.free(p)
      console.log("free() OK — MTE tag check is DISABLED")
    `,
  },
  {
    name: "Phase 5: double round-trip preserves pointer",
    description: "Does the tagged pointer survive JS double conversion?",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("original:", "0x" + p.toString(16), "=", p)
      // JS Number IS a double. The round-trip is automatic.
      const back = p // asPtrAddress reads it back
      console.log("after JS:", "0x" + back.toString(16), "=", back)
      console.log("match:", p === back ? "YES (no precision loss)" : "NO (corrupted)")
    `,
  },
  {
    name: "Phase 6: JSCallback (u8, ptr, u32)",
    description: "Log callback signature — TinyCC trampoline",
    code: `
      const { JSCallback } = require("bun:ffi")
      const cb = new JSCallback(
        (level, msgPtr, msgLen) => {},
        { args: ["u8", "ptr", "u32"], returns: "void" },
      )
      console.log("JSCallback ptr =", "0x" + cb.ptr.toString(16))
      console.log("ptr non-null:", cb.ptr !== null)
      cb.close()
      console.log("close() OK")
    `,
  },
  {
    name: "Phase 7: JSCallback (ptr, u32, ptr, u32)",
    description: "Event callback signature — 4 args with 2 ptrs",
    code: `
      const { JSCallback } = require("bun:ffi")
      const cb = new JSCallback(
        (namePtr, nameLen, dataPtr, dataLen) => {},
        { args: ["ptr", "u32", "ptr", "u32"], returns: "void" },
      )
      console.log("JSCallback ptr =", "0x" + cb.ptr.toString(16))
      cb.close()
      console.log("OK")
    `,
  },
  {
    name: "Phase 8: cc() compiles C code",
    description: "TinyCC can compile and call C functions",
    code: `
      const { cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "ffi_test_" + Date.now() + ".c")
      fs.writeFileSync(cFile, "int add(int a, int b) { return a + b; }")
      const lib = cc({
        source: cFile,
        symbols: { add: { args: ["i32", "i32"], returns: "i32" } },
      })
      const result = lib.symbols.add(20, 22)
      console.log("add(20, 22) =", result)
      console.log("cc() OK")
    `,
  },
  {
    name: "Phase 9: JSCallback called from cc() code",
    description: "TinyCC-compiled C code calling JS callback via function pointer",
    code: `
      const { cc, JSCallback } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")
      const cb = new JSCallback((n) => n * 3, { args: ["i32"], returns: "i32" })
      console.log("callback ptr =", "0x" + cb.ptr.toString(16))
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "ffi_cb_" + Date.now() + ".c")
      fs.writeFileSync(cFile, \`
        typedef int (*int_cb)(int);
        int apply_callback(int_cb cb, int n) { return cb(n); }
      \`)
      const lib = cc({
        source: cFile,
        symbols: { apply_callback: { args: ["ptr", "i32"], returns: "i32" } },
      })
      const result = lib.symbols.apply_callback(cb.ptr, 14)
      console.log("apply_callback(triple, 14) =", result, "(expected 42)")
      cb.close()
    `,
  },
  {
    name: "Phase 10: opentui createRenderer + setupTerminal",
    description: "Basic native renderer lifecycle (no JSCallback, no yoga)",
    code: `
      const { dlopen } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          setUseThread: { args: ["u32", "bool"], returns: "void" },
          setClearOnShutdown: { args: ["u32", "bool"], returns: "void" },
          setupTerminal: { args: ["u32", "bool"], returns: "void" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      console.log("createRenderer =", r)
      lib.symbols.setUseThread(r, 0)
      lib.symbols.setClearOnShutdown(r, 0)
      lib.symbols.setupTerminal(r, 0)
      console.log("setupTerminal OK")
      lib.symbols.destroyRenderer(r)
      console.log("destroyRenderer OK")
    `,
  },
  {
    name: "Phase 11: opentui with JSCallback (log + event)",
    description: "JSCallback registration with opentui (setupLogging + setupEventBus)",
    code: `
      const { dlopen, JSCallback } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          setLogCallback: { args: ["ptr"], returns: "void" },
          createEventSink: { args: ["ptr"], returns: "u32" },
          destroyEventSink: { args: ["u32"], returns: "void" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      console.log("createRenderer =", r)
      const logCb = new JSCallback(
        (level, msgPtr, msgLen) => {},
        { args: ["u8", "ptr", "u32"], returns: "void" },
      )
      lib.symbols.setLogCallback(logCb.ptr)
      console.log("setLogCallback OK")
      const eventCb = new JSCallback(
        (namePtr, nameLen, dataPtr, dataLen) => {},
        { args: ["ptr", "u32", "ptr", "u32"], returns: "void" },
      )
      const sink = lib.symbols.createEventSink(eventCb.ptr)
      console.log("createEventSink =", sink)
      lib.symbols.destroyEventSink(sink)
      lib.symbols.setLogCallback(0)
      lib.symbols.destroyRenderer(r)
      logCb.close()
      eventCb.close()
      console.log("cleanup OK")
    `,
  },
  {
    name: "Phase 12: yogaNodeCreateForOpenTUI (returns ptr)",
    description: "Yoga node creation — does ptr survive the double round-trip?",
    code: `
      const { dlopen } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      console.log("createRenderer =", r)
      const node = lib.symbols.yogaNodeCreateForOpenTUI()
      console.log("yogaNode =", "0x" + node.toString(16))
      console.log("decimal =", node)
      const topByte = Math.floor(node / 0x100000000000000) & 0xff
      console.log("top byte =", "0x" + topByte.toString(16))
      console.log("tagged:", topByte !== 0 ? "YES" : "NO")
      lib.symbols.destroyRenderer(r)
      console.log("destroyRenderer OK (node NOT freed yet)")
    `,
  },
  {
    name: "Phase 13: yoga node setWidth/setHeight (ptr + f32 args)",
    description: "Yoga style operations — ptr + f32 argument passing",
    code: `
      const { dlopen } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
          yogaNodeStyleSetValue: { args: ["ptr", "u32", "u32", "u32", "f32"], returns: "void" },
          yogaNodeStyleSetEnum: { args: ["ptr", "u32", "u32"], returns: "void" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      const node = lib.symbols.yogaNodeCreateForOpenTUI()
      console.log("yogaNode =", "0x" + node.toString(16))
      lib.symbols.yogaNodeStyleSetValue(node, 0, 0, 1, 80)
      console.log("setWidth(80) OK")
      lib.symbols.yogaNodeStyleSetValue(node, 1, 0, 1, 24)
      console.log("setHeight(24) OK")
      lib.symbols.yogaNodeStyleSetEnum(node, 0, 2)
      console.log("setFlexDirection(column) OK")
      lib.symbols.destroyRenderer(r)
      console.log("destroyRenderer OK")
    `,
  },
  {
    name: "Phase 14: yogaNodeCalculateLayout (ptr + 2xf32)",
    description: "Yoga layout calculation — known crash point at 0x14",
    code: `
      const { dlopen } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
          yogaNodeStyleSetValue: { args: ["ptr", "u32", "u32", "u32", "f32"], returns: "void" },
          yogaNodeStyleSetEnum: { args: ["ptr", "u32", "u32"], returns: "void" },
          yogaNodeCalculateLayout: { args: ["ptr", "f32", "f32"], returns: "void" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      const node = lib.symbols.yogaNodeCreateForOpenTUI()
      console.log("yogaNode =", "0x" + node.toString(16))
      lib.symbols.yogaNodeStyleSetValue(node, 0, 0, 1, 80)
      lib.symbols.yogaNodeStyleSetValue(node, 1, 0, 1, 24)
      lib.symbols.yogaNodeStyleSetEnum(node, 0, 2)
      console.log("style set OK, calling calculateLayout...")
      lib.symbols.yogaNodeCalculateLayout(node, 80, 24)
      console.log("calculateLayout OK!")
      lib.symbols.destroyRenderer(r)
    `,
  },
  {
    name: "Phase 15: yogaNodeFree (calls free(tagged_ptr))",
    description: "CRITICAL: free(yoga_node) — SIGABRT = MTE tag check, SIGSEGV = corrupted ptr",
    code: `
      const { dlopen } = require("bun:ffi")
      const lib = dlopen(
        "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
        {
          createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
          destroyRenderer: { args: ["u32"], returns: "void" },
          yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
          yogaNodeFree: { args: ["ptr"], returns: "void" },
        }
      )
      const r = lib.symbols.createRenderer(80, 24, 0, 0, 0)
      const node = lib.symbols.yogaNodeCreateForOpenTUI()
      console.log("yogaNode =", "0x" + node.toString(16))
      console.log("calling yogaNodeFree(node)...")
      lib.symbols.yogaNodeFree(node)
      console.log("yogaNodeFree OK — free(tagged_ptr) succeeded!")
      lib.symbols.destroyRenderer(r)
    `,
  },
  {
    name: "Phase 16: f32 args (sqrt, ceilf)",
    description: "Verify f32 argument passing with libm",
    code: `
      const { dlopen } = require("bun:ffi")
      const libm = dlopen("/system/lib64/libm.so", {
        sqrt: { args: ["f64"], returns: "f64" },
        ceilf: { args: ["f32"], returns: "f32" },
      })
      console.log("sqrt(2.0) =", libm.symbols.sqrt(2.0))
      console.log("ceilf(1.5) =", libm.symbols.ceilf(1.5))
      console.log("f32 args OK")
    `,
  },
  {
    name: "Phase 17: stdin setRawMode + resume",
    description: "Bun stdin I/O on Android",
    code: `
      process.stdin.setRawMode(true)
      process.stdin.setRawMode(false)
      process.stdin.on("data", () => {})
      process.stdin.resume()
      console.log("stdin raw mode + resume OK")
    `,
  },
  {
    name: "Phase 18: createCliRenderer (full JS wrapper)",
    description: "ULTIMATE TEST: the full opentui createCliRenderer() path",
    code: `
      const { createCliRenderer } = require("@xincli/opentui-core")
      console.log("calling createCliRenderer...")
      const r = createCliRenderer({
        exitOnCtrlC: false,
        useThread: false,
        useMouse: false,
        useKittyKeyboard: false,
        screenMode: "main-screen",
      })
      console.log("createCliRenderer OK!")
      r.destroy()
      console.log("destroy OK!")
    `,
  },
]

// ═══════════════════════════════════════════════════════════════════
// Runner — executes each phase in a child process
// ═══════════════════════════════════════════════════════════════════

const BANNER = "═".repeat(60)
console.log(`╔${BANNER}╗`)
console.log(`║  Bun FFI Debug Suite (crash-safe)                       ║`)
console.log(`║  Each phase runs in a separate child process            ║`)
console.log(`╚${BANNER}╝`)

const results: { phase: string; status: string; detail: string }[] = []
let passed = 0
let failed = 0
let crashed = 0

// Create temp dir for phase scripts
const tmpDir = join(tmpdir(), "bun-ffi-debug")
try { mkdirSync(tmpDir, { recursive: true }) } catch {}

for (let i = 0; i < phases.length; i++) {
  const phase = phases[i]
  const scriptPath = join(tmpDir, `phase_${i + 1}.mjs`)

  // Write the phase script
  writeFileSync(scriptPath, phase.code)

  console.log(`\n── ${phase.name} ──`)
  console.log(`   ${phase.description}`)

  // Run in a child process
  const result = spawnSync("bun", ["run", scriptPath], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env },
  })

  // Print stdout
  if (result.stdout) {
    for (const line of result.stdout.split("\n")) {
      if (line.trim()) console.log(`   ${line}`)
    }
  }

  // Determine result
  if (result.status === 0) {
    console.log(`   ✅ PASS`)
    results.push({ phase: phase.name, status: "PASS", detail: "" })
    passed++
  } else if (result.signal) {
    const signal = result.signal
    let crashType = "CRASH"
    if (signal === "SIGABRT") crashType = "SIGABRT (MTE tag check — scudo abort)"
    else if (signal === "SIGSEGV") crashType = "SIGSEGV (segfault — corrupted pointer or null deref)"
    else if (signal === "SIGBUS") crashType = "SIGBUS (bus error — misaligned access)"
    console.log(`   💥 ${crashType}`)
    if (result.stderr) {
      const lines = result.stderr.split("\n").filter((l) => l.trim())
      for (const line of lines.slice(-3)) {
        console.log(`   stderr: ${line}`)
      }
    }
    results.push({ phase: phase.name, status: crashType, detail: signal })
    crashed++
  } else {
    console.log(`   ❌ FAIL (exit code ${result.status})`)
    if (result.stderr) {
      const lines = result.stderr.split("\n").filter((l) => l.trim())
      for (const line of lines.slice(-3)) {
        console.log(`   stderr: ${line}`)
      }
    }
    results.push({ phase: phase.name, status: "FAIL", detail: `exit ${result.status}` })
    failed++
  }
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`)
console.log("SUMMARY")
console.log("═".repeat(60))
console.log(`  ✅ Passed:   ${passed}`)
console.log(`  ❌ Failed:   ${failed}`)
console.log(`  💥 Crashed:  ${crashed}`)
console.log()

for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : r.status.includes("CRASH") || r.status.includes("SIG") ? "💥" : "❌"
  console.log(`  ${icon} ${r.phase}`)
  if (r.status !== "PASS") console.log(`     → ${r.status}`)
}

console.log()
if (crashed > 0) {
  console.log("💥 Crash analysis:")
  console.log("   The FIRST crashed phase is the root cause.")
  console.log("   Everything before it works; everything after it is untested.")
  console.log()
  const firstCrash = results.find((r) => r.status.includes("SIG"))
  if (firstCrash) {
    console.log(`   First crash: ${firstCrash.phase}`)
    console.log(`   Signal: ${firstCrash.detail}`)
    if (firstCrash.detail === "SIGABRT") {
      console.log("   → scudo's MTE tag check rejected a tagged pointer in free()")
      console.log("   → MEMTAG_OPTIONS=off doesn't work on this Android version")
    } else if (firstCrash.detail === "SIGSEGV") {
      console.log("   → Pointer was corrupted (null or wrong address)")
      console.log("   → Likely double precision loss or 32-bit truncation")
    }
  }
} else if (failed > 0) {
  console.log("❌ Some tests failed but no crashes — see details above.")
} else {
  console.log("🎉 All phases passed! Bun FFI works correctly on this device.")
}
