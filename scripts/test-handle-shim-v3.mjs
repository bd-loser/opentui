// test-handle-shim-v3.mjs — Better error reporting
//
// V2 returned -2 (dlsym failed). Let's add per-symbol error reporting.

const { cc } = require("bun:ffi")
const os = require("os"), path = require("path"), fs = require("fs")

const tmpDir = process.env.TMPDIR || os.tmpdir()
const cFile = path.join(tmpDir, "shim_v3.c")

const shimSource = `
  extern void* dlopen(const char*, int);
  extern void* dlsym(void*, const char*);
  extern char* dlerror();

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

  static void* opentui_lib = 0;
  static createRenderer_fn p_createRenderer = 0;
  static destroyRenderer_fn p_destroyRenderer = 0;
  static yogaNodeCreate_fn p_yogaNodeCreate = 0;
  static yogaNodeFree_fn p_yogaNodeFree = 0;
  static yogaNodeStyleSetValue_fn p_yogaNodeStyleSetValue = 0;
  static yogaNodeStyleSetEnum_fn p_yogaNodeStyleSetEnum = 0;
  static yogaNodeCalculateLayout_fn p_yogaNodeCalculateLayout = 0;

  /* Error reporting: store the failed symbol name */
  static char last_error[256] = {0};
  static int last_error_code = 0;

  /* Simple string copy */
  static void set_error(int code, const char* msg) {
    last_error_code = code;
    int i;
    for (i = 0; i < 255 && msg[i]; i++) last_error[i] = msg[i];
    last_error[i] = 0;
  }

  /* Returns: 0 on success, negative on error.
   * shim_get_error_code() and shim_get_error_msg() give details. */
  int shim_init(const char* libpath) {
    /* Clear any existing error */
    dlerror();

    opentui_lib = dlopen(libpath, 1);
    if (!opentui_lib) {
      char* err = dlerror();
      set_error(1, err ? err : "dlopen returned NULL");
      return -1;
    }

    /* Clear error and lookup each symbol */
    dlerror();
    p_createRenderer = dlsym(opentui_lib, "createRenderer");
    if (!p_createRenderer) { set_error(2, "createRenderer"); return -2; }

    p_destroyRenderer = dlsym(opentui_lib, "destroyRenderer");
    if (!p_destroyRenderer) { set_error(3, "destroyRenderer"); return -3; }

    p_yogaNodeCreate = dlsym(opentui_lib, "yogaNodeCreateForOpenTUI");
    if (!p_yogaNodeCreate) { set_error(4, "yogaNodeCreateForOpenTUI"); return -4; }

    p_yogaNodeFree = dlsym(opentui_lib, "yogaNodeFree");
    if (!p_yogaNodeFree) { set_error(5, "yogaNodeFree"); return -5; }

    p_yogaNodeStyleSetValue = dlsym(opentui_lib, "yogaNodeStyleSetValue");
    if (!p_yogaNodeStyleSetValue) { set_error(6, "yogaNodeStyleSetValue"); return -6; }

    p_yogaNodeStyleSetEnum = dlsym(opentui_lib, "yogaNodeStyleSetEnum");
    if (!p_yogaNodeStyleSetEnum) { set_error(7, "yogaNodeStyleSetEnum"); return -7; }

    p_yogaNodeCalculateLayout = dlsym(opentui_lib, "yogaNodeCalculateLayout");
    if (!p_yogaNodeCalculateLayout) { set_error(8, "yogaNodeCalculateLayout"); return -8; }

    return 0;
  }

  int shim_get_error_code() { return last_error_code; }
  const char* shim_get_error_msg() { return last_error; }

  /* Also expose a function to test dlsym on a specific symbol */
  int shim_test_symbol(const char* name) {
    dlerror();
    void* p = dlsym(opentui_lib, name);
    if (!p) return 0;
    return 1;
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

console.log("Compiling shim...")
const lib = cc({
  source: cFile,
  symbols: {
    shim_init: { args: ["cstring"], returns: "i32" },
    shim_get_error_code: { args: [], returns: "i32" },
    shim_get_error_msg: { args: [], returns: "cstring" },
    shim_test_symbol: { args: ["cstring"], returns: "i32" },
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

const libPath = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-linux/libopentui.so"
// Try both paths
const fs2 = require("fs")
const possiblePaths = [
  "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so",
  "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-linux/libopentui.so",
]
let actualPath = null
for (const p of possiblePaths) {
  if (fs2.existsSync(p)) { actualPath = p; break }
}
if (!actualPath) {
  console.log("❌ libopentui.so not found in any expected location")
  process.exit(1)
}
console.log("Using:", actualPath)

console.log("Calling shim_init...")
const initResult = lib.symbols.shim_init(actualPath)
console.log("shim_init =", initResult)

if (initResult !== 0) {
  console.log("Error code:", lib.symbols.shim_get_error_code())
  const errorMsg = lib.symbols.shim_get_error_msg()
  console.log("Error msg:", errorMsg)
  console.log("\nTesting individual symbols:")
  for (const sym of ["createRenderer", "destroyRenderer", "yogaNodeCreateForOpenTUI",
                     "yogaNodeFree", "yogaNodeStyleSetValue", "yogaNodeStyleSetEnum",
                     "yogaNodeCalculateLayout"]) {
    const found = lib.symbols.shim_test_symbol(sym)
    console.log(`  ${sym}: ${found ? "✅ found" : "❌ NOT found"}`)
  }
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
