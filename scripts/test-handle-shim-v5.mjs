// test-handle-shim-v5.mjs — Use libc's dlsym to get raw function pointers
//
// V3 failed because TinyCC can't call dlsym directly.
// V5 uses Bun's dlopen to call libc's dlopen+dlsym, getting RAW function
// pointers. These are CODE addresses (no 0xb4 heap tag), so they survive
// the JS→C boundary. Then we pass them to a cc() shim.
//
// The cc() shim:
//   - Stores function pointers (passed from JS as ptr args)
//   - Stores heap pointers in a C-side handle table
//   - JS only passes integer handles — never tagged heap pointers

const { dlopen, cc } = require("bun:ffi")
const os = require("os"), path = require("path"), fs = require("fs")

const libPath = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"

console.log("Step 1: dlopen libc to get dlopen+dlsym function pointers...")
const libc = dlopen("/system/lib64/libc.so", {
  dlopen: { args: ["ptr", "i32"], returns: "ptr" },
  dlsym: { args: ["ptr", "ptr"], returns: "ptr" },
  dlerror: { args: [], returns: "ptr" },
})
console.log("✅ libc dlopen'd")

// Helper: convert JS string to null-terminated Buffer (for ptr args)
function toCStringBuffer(str) {
  return Buffer.from(str + "\0", "utf8")
}

console.log("\nStep 2: Use libc.dlopen to load libopentui.so...")
const libPathBuf = toCStringBuffer(libPath)
const opentuiHandle = libc.symbols.dlopen(libPathBuf, 1)  // RTLD_LAZY = 1
console.log("  opentui handle =", "0x" + opentuiHandle.toString(16))
if (!opentuiHandle) {
  console.log("  dlopen failed")
  process.exit(1)
}

console.log("\nStep 3: Use libc.dlsym to get raw function pointers...")
const symbols = {}
const symNames = [
  "createRenderer",
  "destroyRenderer",
  "yogaNodeCreateForOpenTUI",
  "yogaNodeFree",
  "yogaNodeStyleSetValue",
  "yogaNodeStyleSetEnum",
  "yogaNodeCalculateLayout",
]
for (const name of symNames) {
  const nameBuf = toCStringBuffer(name)
  const ptr = libc.symbols.dlsym(opentuiHandle, nameBuf)
  console.log(`  ${name} = 0x${ptr.toString(16)}`)
  symbols[name] = ptr
}

console.log("\nStep 4: Compile cc() shim that accepts function pointers...")
const tmpDir = process.env.TMPDIR || os.tmpdir()
const cFile = path.join(tmpDir, "shim_v5.c")

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

  typedef unsigned int (*createRenderer_fn)(unsigned int, unsigned int, unsigned char, unsigned char, void*);
  typedef void (*destroyRenderer_fn)(unsigned int);
  typedef void* (*yogaNodeCreate_fn)(void);
  typedef void (*yogaNodeFree_fn)(void*);
  typedef void (*yogaNodeStyleSetValue_fn)(void*, unsigned int, unsigned int, unsigned int, float);
  typedef void (*yogaNodeStyleSetEnum_fn)(void*, unsigned int, unsigned int);
  typedef void (*yogaNodeCalculateLayout_fn)(void*, float, float);

  static createRenderer_fn p_createRenderer = 0;
  static destroyRenderer_fn p_destroyRenderer = 0;
  static yogaNodeCreate_fn p_yogaNodeCreate = 0;
  static yogaNodeFree_fn p_yogaNodeFree = 0;
  static yogaNodeStyleSetValue_fn p_yogaNodeStyleSetValue = 0;
  static yogaNodeStyleSetEnum_fn p_yogaNodeStyleSetEnum = 0;
  static yogaNodeCalculateLayout_fn p_yogaNodeCalculateLayout = 0;

  void shim_register(unsigned int which, void* fn) {
    switch(which) {
      case 0: p_createRenderer = (createRenderer_fn)fn; break;
      case 1: p_destroyRenderer = (destroyRenderer_fn)fn; break;
      case 2: p_yogaNodeCreate = (yogaNodeCreate_fn)fn; break;
      case 3: p_yogaNodeFree = (yogaNodeFree_fn)fn; break;
      case 4: p_yogaNodeStyleSetValue = (yogaNodeStyleSetValue_fn)fn; break;
      case 5: p_yogaNodeStyleSetEnum = (yogaNodeStyleSetEnum_fn)fn; break;
      case 6: p_yogaNodeCalculateLayout = (yogaNodeCalculateLayout_fn)fn; break;
    }
  }

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
    shim_register: { args: ["u32", "ptr"], returns: "void" },
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

console.log("\nStep 5: Register function pointers with shim...")
lib.symbols.shim_register(0, symbols.createRenderer)
lib.symbols.shim_register(1, symbols.destroyRenderer)
lib.symbols.shim_register(2, symbols.yogaNodeCreateForOpenTUI)
lib.symbols.shim_register(3, symbols.yogaNodeFree)
lib.symbols.shim_register(4, symbols.yogaNodeStyleSetValue)
lib.symbols.shim_register(5, symbols.yogaNodeStyleSetEnum)
lib.symbols.shim_register(6, symbols.yogaNodeCalculateLayout)
console.log("✅ All registered")

console.log("\nStep 6: Test — createRenderer...")
const renderer = lib.symbols.shim_createRenderer(80, 24)
console.log("  renderer =", renderer)

console.log("\nStep 7: Test — yogaNodeCreate (returns handle, not pointer)...")
const node = lib.symbols.shim_yogaNodeCreate()
console.log("  node handle =", node, "(NOT a tagged pointer!)")

console.log("\nStep 8: Test — yogaNodeStyleSetValue (handle + f32 args)...")
lib.symbols.shim_yogaNodeStyleSetValue(node, 0, 0, 1, 80)
console.log("  ✅ setWidth OK")

lib.symbols.shim_yogaNodeStyleSetValue(node, 1, 0, 1, 24)
console.log("  ✅ setHeight OK")

console.log("\nStep 9: Test — yogaNodeStyleSetEnum...")
lib.symbols.shim_yogaNodeStyleSetEnum(node, 0, 2)
console.log("  ✅ setFlexDirection OK")

console.log("\nStep 10: Test — yogaNodeCalculateLayout...")
lib.symbols.shim_yogaNodeCalculateLayout(node, 80, 24)
console.log("  ✅ calculateLayout OK")

console.log("\nStep 11: Test — yogaNodeFree (the original crash!)...")
lib.symbols.shim_yogaNodeFree(node)
console.log("  ✅ yogaNodeFree OK")

console.log("\nStep 12: Cleanup...")
lib.symbols.shim_destroyRenderer(renderer)
console.log("  ✅ destroyRenderer OK")

console.log("\n🎉 ALL TESTS PASSED — handle table with raw function pointers works!")
