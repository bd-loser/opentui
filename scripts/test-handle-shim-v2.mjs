// test-handle-shim-v2.mjs — Simplified version using extern declarations
//
// H0-A passed with: extern void* malloc(unsigned long); extern void free(void*);
// This version uses the same pattern — no #include, just extern declarations.

const { cc } = require("bun:ffi")
const os = require("os"), path = require("path"), fs = require("fs")

const tmpDir = process.env.TMPDIR || os.tmpdir()
const cFile = path.join(tmpDir, "shim_v2.c")

// Use extern declarations — no #include (TinyCC can't find system headers)
const shimSource = `
  /* extern declarations — no #include needed */
  extern void* dlopen(const char*, int);
  extern void* dlsym(void*, const char*);
  extern char* dlerror();
  extern int fprintf(void*, const char*, ...);
  extern void* stderr_ptr();

  /* Use a static variable for stderr — can't #include <stdio.h> */
  static void* get_stderr() {
    /* stderr is at a known offset in Bionic — but we can't easily get it
       without headers. Just return NULL and skip fprintf for now. */
    return (void*)0;
  }

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
  typedef void (*setUseThread_fn)(unsigned int, int);
  typedef void (*setClearOnShutdown_fn)(unsigned int, int);
  typedef void (*setupTerminal_fn)(unsigned int, int);
  typedef void* (*yogaNodeCreate_fn)(void);
  typedef void (*yogaNodeFree_fn)(void*);
  typedef void (*yogaNodeStyleSetValue_fn)(void*, unsigned int, unsigned int, unsigned int, float);
  typedef void (*yogaNodeStyleSetEnum_fn)(void*, unsigned int, unsigned int);
  typedef void (*yogaNodeCalculateLayout_fn)(void*, float, float);

  static void* opentui_lib = 0;
  static createRenderer_fn p_createRenderer = 0;
  static destroyRenderer_fn p_destroyRenderer = 0;
  static yogaNodeCreate_fn p_yogaNodeCreate = 0;
  static yogaNodeFree_fn p_yogaNodeFree = 0;
  static yogaNodeStyleSetValue_fn p_yogaNodeStyleSetValue = 0;
  static yogaNodeStyleSetEnum_fn p_yogaNodeStyleSetEnum = 0;
  static yogaNodeCalculateLayout_fn p_yogaNodeCalculateLayout = 0;

  /* Store last error code for JS to read */
  static int shim_error = 0;

  int shim_init(const char* libpath) {
    shim_error = 0;
    opentui_lib = dlopen(libpath, 1);
    if (!opentui_lib) {
      shim_error = 1;
      return -1;
    }
    p_createRenderer = dlsym(opentui_lib, "createRenderer");
    p_destroyRenderer = dlsym(opentui_lib, "destroyRenderer");
    p_yogaNodeCreate = dlsym(opentui_lib, "yogaNodeCreateForOpenTUI");
    p_yogaNodeFree = dlsym(opentui_lib, "yogaNodeFree");
    p_yogaNodeStyleSetValue = dlsym(opentui_lib, "yogaNodeStyleSetValue");
    p_yogaNodeStyleSetEnum = dlsym(opentui_lib, "yogaNodeStyleSetEnum");
    p_yogaNodeCalculateLayout = dlsym(opentui_lib, "yogaNodeCalculateLayout");

    if (!p_createRenderer || !p_yogaNodeCreate) {
      shim_error = 2;
      return -2;
    }
    return 0;
  }

  int shim_get_error() { return shim_error; }

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

console.log("Compiling shim...")
const lib = cc({
  source: cFile,
  symbols: {
    shim_init: { args: ["cstring"], returns: "i32" },
    shim_get_error: { args: [], returns: "i32" },
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

const libPath = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"

console.log("Calling shim_init...")
const initResult = lib.symbols.shim_init(libPath)
console.log("shim_init =", initResult)
if (initResult !== 0) {
  console.log("❌ Failed. Error code:", lib.symbols.shim_get_error())
  process.exit(1)
}
console.log("✅ Init OK")

console.log("Creating renderer...")
const renderer = lib.symbols.shim_createRenderer(80, 24)
console.log("renderer =", renderer)

console.log("Creating yoga node...")
const node = lib.symbols.shim_yogaNodeCreate()
console.log("node handle =", node)

console.log("Setting width...")
lib.symbols.shim_yogaNodeStyleSetValue(node, 0, 0, 1, 80)
console.log("✅ setWidth OK")

console.log("Setting height...")
lib.symbols.shim_yogaNodeStyleSetValue(node, 1, 0, 1, 24)
console.log("✅ setHeight OK")

console.log("Setting flex direction...")
lib.symbols.shim_yogaNodeStyleSetEnum(node, 0, 2)
console.log("✅ setFlexDirection OK")

console.log("Calculating layout...")
lib.symbols.shim_yogaNodeCalculateLayout(node, 80, 24)
console.log("✅ calculateLayout OK")

console.log("Freeing yoga node...")
lib.symbols.shim_yogaNodeFree(node)
console.log("✅ yogaNodeFree OK")

console.log("Destroying renderer...")
lib.symbols.shim_destroyRenderer(renderer)
console.log("✅ destroyRenderer OK")

console.log("\n🎉 ALL TESTS PASSED!")
