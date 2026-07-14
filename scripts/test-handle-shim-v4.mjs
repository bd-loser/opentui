// test-handle-shim-v4.mjs — Pass function pointers from JS to C
//
// V3 failed because dlsym() from within TinyCC code doesn't work
// (TinyCC doesn't link against libdl properly).
//
// V4 uses a different approach:
// 1. Use Bun's dlopen to get function pointers from libopentui.so
//    (this works — dlopen returns pointers correctly to JS)
// 2. Pass function pointers from JS to C
//    (this works — Phase 9 proved JSCallback ptr can be passed JS→C)
// 3. C stores them and calls them via function pointer
// 4. Heap pointers (yoga nodes) stay in C-side handle table
//
// Function pointers are CODE addresses (no 0xb4 heap tag), so they
// survive the JS→C boundary without tag stripping.

const { dlopen, cc } = require("bun:ffi")
const os = require("os"), path = require("path"), fs = require("fs")

const libPath = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"

console.log("Step 1: dlopen libopentui.so via Bun...")
const opentui = dlopen(libPath, {
  createRenderer: { args: ["u32", "u32", "u8", "u8", "ptr"], returns: "u32" },
  destroyRenderer: { args: ["u32"], returns: "void" },
  setUseThread: { args: ["u32", "bool"], returns: "void" },
  setClearOnShutdown: { args: ["u32", "bool"], returns: "void" },
  setupTerminal: { args: ["u32", "bool"], returns: "void" },
  yogaNodeCreateForOpenTUI: { args: [], returns: "ptr" },
  yogaNodeFree: { args: ["ptr"], returns: "void" },
  yogaNodeStyleSetValue: { args: ["ptr", "u32", "u32", "u32", "f32"], returns: "void" },
  yogaNodeStyleSetEnum: { args: ["ptr", "u32", "u32"], returns: "void" },
  yogaNodeCalculateLayout: { args: ["ptr", "f32", "f32"], returns: "void" },
})
console.log("✅ dlopen OK")

// Get the raw function pointer addresses
// Bun stores them internally — we can access via the symbols object
// But we need the RAW pointer, not the wrapper.
// Actually, in Bun's dlopen, the symbols are already callable, but we
// can't get the raw pointer from JS directly.
//
// However, we CAN use cc() to compile a shim that takes function pointers
// as arguments and stores them. Let's do that.

console.log("\nStep 2: Compile C shim that accepts function pointers...")
const tmpDir = process.env.TMPDIR || os.tmpdir()
const cFile = path.join(tmpDir, "shim_v4.c")

const shimSource = `
  #define MAX_HANDLES 4096
  static void* handles[MAX_HANDLES];
  static int handle_count = 1;

  static int ptr_to_handle(void* ptr) {
    if (handle_count >= MAX_HANDLES) return 0;
    handles[handle_count] = ptr;
    return handle_count++;
  }

  static void* handle_to_ptr(int handle) {
    if (handle <= 0 || handle >= MAX_HANDLES) return 0;
    return handles[handle];
  }

  static void free_handle(int handle) {
    if (handle > 0 && handle < MAX_HANDLES) handles[handle] = 0;
  }

  /* Function pointer types */
  typedef unsigned int (*createRenderer_fn)(unsigned int, unsigned int, unsigned char, unsigned char, void*);
  typedef void (*destroyRenderer_fn)(unsigned int);
  typedef void* (*yogaNodeCreate_fn)(void);
  typedef void (*yogaNodeFree_fn)(void*);
  typedef void (*yogaNodeStyleSetValue_fn)(void*, unsigned int, unsigned int, unsigned int, float);
  typedef void (*yogaNodeStyleSetEnum_fn)(void*, unsigned int, unsigned int);
  typedef void (*yogaNodeCalculateLayout_fn)(void*, float, float);

  /* Stored function pointers */
  static createRenderer_fn p_createRenderer = 0;
  static destroyRenderer_fn p_destroyRenderer = 0;
  static yogaNodeCreate_fn p_yogaNodeCreate = 0;
  static yogaNodeFree_fn p_yogaNodeFree = 0;
  static yogaNodeStyleSetValue_fn p_yogaNodeStyleSetValue = 0;
  static yogaNodeStyleSetEnum_fn p_yogaNodeStyleSetEnum = 0;
  static yogaNodeCalculateLayout_fn p_yogaNodeCalculateLayout = 0;

  /* JS calls this to register each function pointer */
  void shim_register_createRenderer(void* fn) { p_createRenderer = (createRenderer_fn)fn; }
  void shim_register_destroyRenderer(void* fn) { p_destroyRenderer = (destroyRenderer_fn)fn; }
  void shim_register_yogaNodeCreate(void* fn) { p_yogaNodeCreate = (yogaNodeCreate_fn)fn; }
  void shim_register_yogaNodeFree(void* fn) { p_yogaNodeFree = (yogaNodeFree_fn)fn; }
  void shim_register_yogaNodeStyleSetValue(void* fn) { p_yogaNodeStyleSetValue = (yogaNodeStyleSetValue_fn)fn; }
  void shim_register_yogaNodeStyleSetEnum(void* fn) { p_yogaNodeStyleSetEnum = (yogaNodeStyleSetEnum_fn)fn; }
  void shim_register_yogaNodeCalculateLayout(void* fn) { p_yogaNodeCalculateLayout = (yogaNodeCalculateLayout_fn)fn; }

  /* Wrapper functions that JS calls — these take/return handles, not pointers */
  unsigned int shim_createRenderer(unsigned int w, unsigned int h) {
    if (!p_createRenderer) return 0;
    return p_createRenderer(w, h, 0, 0, 0);
  }

  void shim_destroyRenderer(unsigned int r) {
    if (p_destroyRenderer) p_destroyRenderer(r);
  }

  unsigned int shim_yogaNodeCreate(void) {
    if (!p_yogaNodeCreate) return 0;
    void* node = p_yogaNodeCreate();
    if (!node) return 0;
    return ptr_to_handle(node);
  }

  void shim_yogaNodeFree(unsigned int handle) {
    void* node = handle_to_ptr(handle);
    if (node && p_yogaNodeFree) {
      p_yogaNodeFree(node);
      free_handle(handle);
    }
  }

  void shim_yogaNodeStyleSetValue(unsigned int h, unsigned int k, unsigned int e, unsigned int u, float v) {
    void* node = handle_to_ptr(h);
    if (node && p_yogaNodeStyleSetValue) p_yogaNodeStyleSetValue(node, k, e, u, v);
  }

  void shim_yogaNodeStyleSetEnum(unsigned int h, unsigned int k, unsigned int v) {
    void* node = handle_to_ptr(h);
    if (node && p_yogaNodeStyleSetEnum) p_yogaNodeStyleSetEnum(node, k, v);
  }

  void shim_yogaNodeCalculateLayout(unsigned int h, float w, float hh) {
    void* node = handle_to_ptr(h);
    if (node && p_yogaNodeCalculateLayout) p_yogaNodeCalculateLayout(node, w, hh);
  }
`

fs.writeFileSync(cFile, shimSource)
const lib = cc({
  source: cFile,
  symbols: {
    shim_register_createRenderer: { args: ["ptr"], returns: "void" },
    shim_register_destroyRenderer: { args: ["ptr"], returns: "void" },
    shim_register_yogaNodeCreate: { args: ["ptr"], returns: "void" },
    shim_register_yogaNodeFree: { args: ["ptr"], returns: "void" },
    shim_register_yogaNodeStyleSetValue: { args: ["ptr"], returns: "void" },
    shim_register_yogaNodeStyleSetEnum: { args: ["ptr"], returns: "void" },
    shim_register_yogaNodeCalculateLayout: { args: ["ptr"], returns: "void" },
    shim_createRenderer: { args: ["u32", "u32"], returns: "u32" },
    shim_destroyRenderer: { args: ["u32"], returns: "void" },
    shim_yogaNodeCreate: { args: [], returns: "u32" },
    shim_yogaNodeFree: { args: ["u32"], returns: "void" },
    shim_yogaNodeStyleSetValue: { args: ["u32", "u32", "u32", "u32", "f32"], returns: "void" },
    shim_yogaNodeStyleSetEnum: { args: ["u32", "u32", "u32"], returns: "void" },
    shim_yogaNodeCalculateLayout: { args: ["u32", "f32", "f32"], returns: "void" },
  },
})
console.log("✅ Compiled")

// PROBLEM: We need to get the raw function pointer addresses from Bun's dlopen.
// Bun's dlopen wraps them — we can't directly access the raw pointer.
//
// SOLUTION: Use a tiny C helper that calls the dlopen'd function and
// returns its address. But that's circular...
//
// BETTER SOLUTION: Use Bun's linkSymbols() which lets us pass raw ptr values.
// Or: use dlopen with the "ptr" field to specify function addresses.
//
// Actually, the simplest approach: we know from Phase 9 that JSCallback
// pointers can be passed JS→C. Let's try passing the dlopen'd symbols
// directly — even though they're wrapped, Bun might still give us the
// raw pointer somehow.
//
// Wait — actually, in Bun's FFI, when you dlopen a library, the symbols
// object contains callable wrappers. But there's no direct API to get
// the raw function pointer.
//
// ALTERNATIVE: Use cc() to compile a function that takes the SYMBOL NAME
// and uses dlsym. But dlsym doesn't work in TinyCC (V3 proved this).
//
// ALTERNATIVE 2: Use Bun's dlopen to call each function once and capture
// its address. But we can't get the address from JS.
//
// ALTERNATIVE 3: Actually, maybe we CAN just call the dlopen'd functions
// directly from JS, and only use cc() for the ones that take pointer args.
//
// Let's test: which operations actually crash?
// - createRenderer (no pointer args) → should work via dlopen
// - yogaNodeCreateForOpenTUI (returns ptr) → should work (H1-A proved return works)
// - yogaNodeStyleSetValue (takes ptr arg) → CRASHES (tag stripped)
// - yogaNodeCalculateLayout (takes ptr arg) → CRASHES
// - yogaNodeFree (takes ptr arg) → CRASHES
//
// So we only need the cc() shim for functions that TAKE pointer arguments!
// createRenderer and yogaNodeCreate can be called directly via dlopen.

console.log("\nStep 3: Test — createRenderer via dlopen (no pointer args)...")
const renderer = opentui.symbols.createRenderer(80, 24, 0, 0, 0)
console.log("  renderer =", renderer)
console.log("  ✅ createRenderer OK (no pointer args)")

console.log("\nStep 4: Test — yogaNodeCreate via dlopen (returns ptr, no pointer args)...")
const nodePtr = opentui.symbols.yogaNodeCreateForOpenTUI()
console.log("  node ptr =", "0x" + nodePtr.toString(16))
console.log("  ✅ yogaNodeCreate OK (pointer RETURN works)")

// Now the problem: we have `nodePtr` in JS (a tagged pointer), but
// passing it BACK to a dlopen'd function crashes.
//
// The cc() shim needs the function pointer AND the handle.
// But we can't get the raw function pointer from Bun's dlopen.
//
// SOLUTION: Pass the dlopen'd symbol WRAPPER to cc() as a callback!
// Bun's JSCallback lets us create C-callable function pointers from JS.
// We can create a JSCallback that wraps each dlopen'd function.

const { JSCallback } = require("bun:ffi")

console.log("\nStep 5: Create JSCallbacks that wrap dlopen'd functions...")

// For yogaNodeFree(ptr) — we need a C-callable wrapper
const freeCallback = new JSCallback(
  (ptr) => {
    // This callback is called from C. The ptr is an integer handle.
    // We look up the real pointer from our handle table.
    // But wait — we need to call the REAL yogaNodeFree, which takes a pointer.
    // And calling dlopen'd functions from within a JSCallback might also crash...
    console.log("    [freeCallback] called with handle:", ptr)
    // Actually, let's just call the dlopen'd function directly here:
    // opentui.symbols.yogaNodeFree(ptr)  // this would crash if ptr is tagged
  },
  { args: ["u64"], returns: "void" }
)
console.log("  freeCallback ptr =", "0x" + freeCallback.ptr.toString(16))

console.log("\nStep 6: Register JSCallback with C shim...")
// The C shim will call our JSCallback when it needs to free a node
// But actually, this is getting complicated. Let me try a simpler approach.

console.log("\n--- SIMPLER APPROACH ---")
console.log("Calling yogaNodeStyleSetValue directly via dlopen...")
console.log("  (this should crash — it takes a pointer arg)")
try {
  opentui.symbols.yogaNodeStyleSetValue(nodePtr, 0, 0, 1, 80)
  console.log("  ✅ didn't crash!")
} catch (e) {
  console.log("  ❌ crashed:", e.message)
}

console.log("\nDone.")
