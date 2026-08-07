#!/usr/bin/env bun
/**
 * Quick test: does OpenTUI load with Bun on Termux?
 * Run: bun run packages/core/scripts/test-bun-load.ts
 */

console.log("=== OpenTUI Bun Load Test ===")
console.log("Platform:", process.platform, process.arch)
console.log("Bun version:", process.versions.bun)
console.log("PREFIX:", process.env.PREFIX || "(not set)")
console.log("")

// Check if libopentui.so exists in prebuilt
import { existsSync } from "fs"
import { fileURLToPath } from "url"

const prebuiltUrl = new URL("../prebuilt/aarch64-android/libopentui.so", import.meta.url)
const prebuiltPath = fileURLToPath(prebuiltUrl)
console.log("Prebuilt .so path:", prebuiltPath)
console.log("Prebuilt .so exists:", existsSync(prebuiltPath))

if (!existsSync(prebuiltPath)) {
  console.error("❌ libopentui.so not found!")
  process.exit(1)
}

// Try to load it with bun:ffi
console.log("")
console.log("Loading libopentui.so via bun:ffi...")
try {
  const { dlopen } = require("bun:ffi")

  const lib = dlopen(prebuiltPath, {
    // Check if the .so has the core symbols
    createNativeRenderable: { args: ["ptr", "u64"], returns: "ptr" },
    destroyNativeRenderable: { args: ["ptr"], returns: "void" },
  })

  console.log("✅ libopentui.so loaded successfully!")
  console.log("   Symbols available:", Object.keys(lib.symbols))

  // Try to create a renderer
  console.log("")
  console.log("Attempting to create renderer...")
  try {
    const { createCliRenderer } = require("../src/index.ts")
    const renderer = createCliRenderer({
      fps: 30,
    })
    console.log("✅ Renderer created!")

    // Clean up after 2 seconds
    setTimeout(() => {
      renderer.destroy()
      console.log("✅ Renderer destroyed. Test passed!")
      process.exit(0)
    }, 2000)
  } catch (e: any) {
    console.log("⚠️  Renderer creation failed:", e.message)
    console.log("   (This is OK — the .so loaded, which is the important part)")
    process.exit(0)
  }
} catch (e: any) {
  console.error("❌ Failed to load libopentui.so:", e.message)
  process.exit(1)
}
