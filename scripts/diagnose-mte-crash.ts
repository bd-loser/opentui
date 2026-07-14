/**
 * ═══════════════════════════════════════════════════════════════════
 * diagnose-mte-crash.ts — Pinpoint the exact root cause of free(tagged_ptr) SIGABRT
 *
 * This script runs a series of focused tests to determine WHERE the
 * tagged pointer gets corrupted (if it does) and WHY scudo's free()
 * rejects it.
 *
 * Hypotheses to test:
 *   H1: Bun's FFI trampoline corrupts the tagged pointer
 *       (e.g., truncates to 32 bits, sign-extends, strips top byte)
 *   H2: TinyCC's arm64 codegen has a bug in pointer passing
 *   H3: Scudo's free() rejects tagged pointers from external callers
 *   H4: The tag is being modified between malloc and free
 *
 * USAGE:
 *   bun run scripts/diagnose-mte-crash.ts
 * ═══════════════════════════════════════════════════════════════════
 */

import { spawnSync } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

interface Phase {
  name: string
  description: string
  code: string
}

const phases: Phase[] = [
  // ─── H0: malloc+free entirely from C (bypass JS↔C boundary) ───
  {
    name: "H0-A: malloc+free entirely from C (cc)",
    description: "CRITICAL: Call malloc AND free from within a TinyCC-compiled C function. No JS round-trip.",
    code: `
      const { cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "test_c_malloc_free_" + Date.now() + ".c")
      fs.writeFileSync(cFile, \`
        extern void* malloc(unsigned long);
        extern void free(void*);
        extern unsigned long long strrchr_addr;
        int test_c_malloc_free() {
          void* p = malloc(64);
          if (!p) return -1;
          // Store the pointer value so JS can read it
          *(unsigned long long*)strrchr_addr = (unsigned long long)p;
          free(p);
          return 0;
        }
      \`)
      const lib = cc({
        source: cFile,
        symbols: {
          test_c_malloc_free: { args: [], returns: "i32" },
          strrchr_addr: { args: [], returns: "u64" },
        },
      })
      const result = lib.symbols.test_c_malloc_free()
      console.log("test_c_malloc_free() =", result)
      console.log(result === 0 ? "✅ malloc+free from C works — scudo is fine" : "❌ malloc+free from C failed")
    `,
  },
  {
    name: "H0-B: malloc from C, free from JS (cross boundary)",
    description: "malloc from cc() C code, free via dlopen'd libc.free. Tests if the tag survives JS.",
    code: `
      const { dlopen, cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")
      const libc = dlopen("/system/lib64/libc.so", {
        free: { args: ["ptr"], returns: "void" },
      })
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "c_malloc_" + Date.now() + ".c")
      fs.writeFileSync(cFile, \`
        extern void* malloc(unsigned long);
        void* c_malloc(unsigned long sz) { return malloc(sz); }
      \`)
      const lib = cc({
        source: cFile,
        symbols: { c_malloc: { args: ["u64"], returns: "ptr" } },
      })
      const p = lib.symbols.c_malloc(64)
      console.log("c_malloc(64) =", "0x" + p.toString(16))
      const topByte = Math.floor(p / 0x100000000000000) & 0xff
      console.log("top byte    =", "0x" + topByte.toString(16))
      console.log("calling free via dlopen...")
      libc.symbols.free(p)
      console.log("free OK!")
    `,
  },
  // ─── H1: Does the FFI trampoline preserve tagged pointers? ───
  {
    name: "H1-A: cc() echo pointer (TinyCC ptr round-trip)",
    description: "Compile a C function that takes a ptr and returns it. Verify the tagged pointer survives.",
    code: `
      const { dlopen, cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")

      // Get a tagged pointer from malloc
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64) =", "0x" + p.toString(16))
      const topByte = Math.floor(p / 0x100000000000000) & 0xff
      console.log("top byte   =", "0x" + topByte.toString(16))

      // Compile a C function that echoes the pointer
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "echo_ptr_" + Date.now() + ".c")
      fs.writeFileSync(cFile, "void* echo_ptr(void* p) { return p; }")
      const lib = cc({
        source: cFile,
        symbols: { echo_ptr: { args: ["ptr"], returns: "ptr" } },
      })

      const echoed = lib.symbols.echo_ptr(p)
      console.log("echo_ptr() =", "0x" + echoed.toString(16))
      console.log("match:", p === echoed ? "YES — TinyCC preserves tagged ptr" : "NO — TinyCC corrupts ptr")
    `,
  },
  {
    name: "H1-B: cc() echo pointer via u64 (bypass ptr type)",
    description: "Same as H1-A but use u64 instead of ptr to see if ptr type is the issue",
    code: `
      const { dlopen, cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")

      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64)   =", "0x" + p.toString(16))

      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "echo_u64_" + Date.now() + ".c")
      fs.writeFileSync(cFile, "unsigned long long echo_u64(unsigned long long p) { return p; }")
      const lib = cc({
        source: cFile,
        symbols: { echo_u64: { args: ["u64"], returns: "u64" } },
      })

      const echoed = lib.symbols.echo_u64(p)
      console.log("echo_u64()   =", "0x" + echoed.toString(16))
      console.log("match:", echoed === BigInt(p) ? "YES" : "NO — u64 also corrupts!")
    `,
  },

  // ─── H2: Does the pointer get truncated to 32 bits? ───
  {
    name: "H2: Check for 32-bit truncation",
    description: "Test if the pointer's lower 32 bits are preserved but upper bits are lost",
    code: `
      const { dlopen, cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")

      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("original    =", "0x" + p.toString(16))

      // Check what the C function sees
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "check_trunc_" + Date.now() + ".c")
      fs.writeFileSync(cFile, \`
        #include <stdio.h>
        void check_ptr(unsigned long long p) {
          fprintf(stderr, "[C] received    = 0x%016llx\\n", p);
          fprintf(stderr, "[C] lower 32    = 0x%08x\\n", (unsigned int)p);
          fprintf(stderr, "[C] upper 32    = 0x%08x\\n", (unsigned int)(p >> 32));
          fprintf(stderr, "[C] top byte    = 0x%02x\\n", (unsigned int)(p >> 56));
        }
      \`)
      const lib = cc({
        source: cFile,
        symbols: { check_ptr: { args: ["u64"], returns: "void" } },
      })
      lib.symbols.check_ptr(p)
      console.log("(see stderr above for what C received)")
    `,
  },

  // ─── H3: Does free() work with manually-untagged pointer? ───
  {
    name: "H3-A: free(untagged_pointer) — strip top byte",
    description: "If scudo accepts untagged pointers, this should work. If not, it'll SIGABRT.",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
        free: { args: ["ptr"], returns: "void" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64)  =", "0x" + p.toString(16))
      // Strip top byte using BigInt (JS bitwise & converts to Int32, which gives 0)
      const untagged = Number(BigInt(p) & 0x00FFFFFFFFFFFFFFn)
      console.log("untagged    =", "0x" + untagged.toString(16))
      console.log("calling free(untagged)...")
      libc.symbols.free(untagged)
      console.log("free(untagged) OK — scudo accepts untagged pointers")
    `,
  },
  {
    name: "H3-B: free(tagged_pointer) — original failing case",
    description: "Reproduce the original crash for comparison",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
        free: { args: ["ptr"], returns: "void" },
      })
      const p = libc.symbols.malloc(64)
      console.log("malloc(64)  =", "0x" + p.toString(16))
      console.log("calling free(tagged)...")
      libc.symbols.free(p)
      console.log("free(tagged) OK")
    `,
  },

  // ─── H4: Does the tag change between malloc and free? ───
  {
    name: "H4: Print pointer at every step",
    description: "Track the pointer value through JS, through C, and back to verify no modification",
    code: `
      const { dlopen, cc } = require("bun:ffi")
      const os = require("os"), path = require("path"), fs = require("fs")

      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
      })
      const p = libc.symbols.malloc(64)
      console.log("step 1 (malloc return) :", "0x" + p.toString(16))

      // Store in a variable, read back
      const stored = p
      console.log("step 2 (JS variable)   :", "0x" + stored.toString(16))

      // Pass through a C function that just returns it
      const tmpDir = process.env.TMPDIR || os.tmpdir()
      const cFile = path.join(tmpDir, "identity_" + Date.now() + ".c")
      fs.writeFileSync(cFile, "void* identity(void* p) { return p; }")
      const lib = cc({
        source: cFile,
        symbols: { identity: { args: ["ptr"], returns: "ptr" } },
      })
      const roundtripped = lib.symbols.identity(p)
      console.log("step 3 (C round-trip)  :", "0x" + roundtripped.toString(16))
      console.log("step 4 (match?)        :", p === roundtripped ? "YES" : "NO")
    `,
  },

  // ─── H5: Is it actually MTE, or something else? ───
  {
    name: "H5: Check /proc/self/status for MTE",
    description: "Read /proc/self/status to see if MTE is actually enabled",
    code: `
      const fs = require("fs")
      try {
        const status = fs.readFileSync("/proc/self/status", "utf8")
        const lines = status.split("\\n").filter(l =>
          /tag|mte|TaggedAddress/i.test(l)
        )
        if (lines.length === 0) {
          console.log("No MTE/tag lines in /proc/self/status")
          console.log("(this means MTE is likely NOT hardware-active)")
        } else {
          for (const l of lines) console.log(l)
        }
      } catch (e) {
        console.log("Cannot read /proc/self/status:", e.message)
      }
      // Also check the AT_HWCAP for MTE bit (bit 18 = 0x40000 = HWCAP2_MTE)
      try {
        const statm = fs.readFileSync("/proc/self/auxv", "utf8")
        console.log("auxv size:", statm.length, "bytes")
      } catch (e) {
        console.log("Cannot read auxv:", e.message)
      }
    `,
  },

  // ─── H6: Test with a fresh process and no env vars ───
  {
    name: "H6: Check env vars affecting MTE",
    description: "Print all MTE/scudo-related env vars",
    code: `
      const keys = Object.keys(process.env).filter(k =>
        /memtag|scudo|mte|tag/i.test(k)
      )
      if (keys.length === 0) {
        console.log("No MTE/scudo env vars set")
      } else {
        for (const k of keys) console.log(k + "=" + process.env[k])
      }
      console.log("")
      console.log("Bun version:", process.versions.bun)
      console.log("Platform:", process.platform, process.arch)
    `,
  },

  // ─── H7: Does the issue happen with calloc too? ───
  {
    name: "H7-A: calloc + free",
    description: "Test if calloc-allocated pointers also crash on free",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        calloc: { args: ["u64", "u64"], returns: "ptr" },
        free: { args: ["ptr"], returns: "void" },
      })
      const p = libc.symbols.calloc(1, 64)
      console.log("calloc(1,64) =", "0x" + p.toString(16))
      console.log("calling free()...")
      libc.symbols.free(p)
      console.log("free(calloc) OK")
    `,
  },
  {
    name: "H7-B: realloc + free",
    description: "Test if realloc-allocated pointers also crash on free",
    code: `
      const { dlopen } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        malloc: { args: ["u64"], returns: "ptr" },
        realloc: { args: ["ptr", "u64"], returns: "ptr" },
        free: { args: ["ptr"], returns: "void" },
      })
      const p1 = libc.symbols.malloc(32)
      console.log("malloc(32)   =", "0x" + p1.toString(16))
      const p2 = libc.symbols.realloc(p1, 128)
      console.log("realloc(128) =", "0x" + p2.toString(16))
      console.log("calling free(realloc'd)...")
      libc.symbols.free(p2)
      console.log("free(realloc'd) OK")
    `,
  },

  // ─── H8: Does the issue happen with aligned_alloc? ───
  {
    name: "H8: posix_memalign + free",
    description: "Test if aligned allocation also crashes on free",
    code: `
      const { dlopen, ptr } = require("bun:ffi")
      const libc = dlopen("/system/lib64/libc.so", {
        posix_memalign: { args: ["ptr", "u64", "u64"], returns: "i32" },
        free: { args: ["ptr"], returns: "void" },
      })
      // Allocate a buffer to hold the pointer
      const buf = new ArrayBuffer(8)
      const result = libc.symbols.posix_memalign(buf, 16, 64)
      console.log("posix_memalign result:", result)
      const view = new DataView(buf)
      const p = view.getBigUint64(0, true)
      console.log("allocated ptr =", "0x" + p.toString(16))
      console.log("calling free()...")
      // Note: can't easily pass bigint to free in Bun, so just print
      console.log("(skipping free — would need bigint support)")
    `,
  },
]

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════

const BANNER = "═".repeat(60)
console.log(`╔${BANNER}╗`)
console.log(`║  MTE Crash Diagnostic Suite                            ║`)
console.log(`║  Pinpointing free(tagged_ptr) SIGABRT root cause       ║`)
console.log(`╚${BANNER}╝`)

const tmpDir = join(tmpdir(), "bun-mte-diag")
try { mkdirSync(tmpDir, { recursive: true }) } catch {}

let passed = 0, failed = 0, crashed = 0

for (let i = 0; i < phases.length; i++) {
  const phase = phases[i]
  const scriptPath = join(tmpDir, `diag_${i + 1}.mjs`)

  writeFileSync(scriptPath, phase.code)

  console.log(`\n── ${phase.name} ──`)
  console.log(`   ${phase.description}`)

  const result = spawnSync("bun", ["run", scriptPath], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env },
  })

  if (result.stdout) {
    for (const line of result.stdout.split("\n")) {
      if (line.trim()) console.log(`   ${line}`)
    }
  }

  if (result.status === 0) {
    console.log(`   ✅ PASS`)
    passed++
  } else if (result.signal) {
    console.log(`   💥 ${result.signal}`)
    if (result.stderr) {
      const lines = result.stderr.split("\n").filter((l) => l.trim())
      for (const line of lines.slice(-5)) {
        console.log(`   stderr: ${line}`)
      }
    }
    crashed++
  } else {
    console.log(`   ❌ FAIL (exit ${result.status})`)
    if (result.stderr) {
      const lines = result.stderr.split("\n").filter((l) => l.trim())
      for (const line of lines.slice(-3)) {
        console.log(`   stderr: ${line}`)
      }
    }
    failed++
  }
}

console.log(`\n${"═".repeat(60)}`)
console.log(`SUMMARY: ${passed} passed, ${failed} failed, ${crashed} crashed`)
console.log("═".repeat(60))

if (crashed > 0) {
  console.log("\n📋 Analysis:")
  console.log("  If H1-A PASSED: TinyCC preserves tagged pointers → issue is in scudo")
  console.log("  If H1-A FAILED: TinyCC corrupts pointers → need to fix TinyCC codegen")
  console.log("  If H3-A PASSED: scudo accepts untagged pointers → fix: untag in shim")
  console.log("  If H3-A CRASHED: scudo requires tagged pointers → fix: side-table shim")
  console.log("  If H5 shows MTE lines: MTE is hardware-active")
  console.log("  If H5 shows nothing: 0xb4 is a software tag (heap tagging mode)")
}
