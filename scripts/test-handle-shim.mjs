// test-handle-shim.mjs — Test the C-side handle table approach
//
// This test verifies that by keeping all pointers in C and passing
// only integer handles through JS, we can call opentui functions
// without the TBI tag stripping crash.

const { cc } = require("bun:ffi")
const os = require("os"), path = require("path"), fs = require("fs")

const tmpDir = process.env.TMPDIR || os.tmpdir()
const cFile = path.join(tmpDir, "opentui-handle-shim.c")

// Read the shim source from the download directory, or use inline
const shimSource = `
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

#define MAX_HANDLES 4096
static void* handles[MAX_HANDLES];
static int handle_count = 1;

static int ptr_to_handle(void* ptr) {
    if (handle_count >= MAX_HANDLES) return 0;
    handles[handle_count] = ptr;
    return handle_count++;
}

static void* handle_to_ptr(int handle) {
    if (handle <= 0 || handle >= MAX_HANDLES) return NULL;
    return handles[handle];
}

static void free_handle(int handle) {
    if (handle > 0 && handle < MAX_HANDLES) handles[handle] = NULL;
}

typedef unsigned int (*createRenderer_fn)(unsigned int, unsigned int, unsigned char, unsigned char, void*);
typedef void (*destroyRenderer_fn)(unsigned int);
typedef void (*setUseThread_fn)(unsigned int, int);
typedef void (*setClearOnShutdown_fn)(unsigned int, int);
typedef void (*setupTerminal_fn)(unsigned int, int);
typedef void* (*yogaNodeCreateForOpenTUI_fn)(void);
typedef void (*yogaNodeFree_fn)(void*);
typedef void (*yogaNodeStyleSetValue_fn)(void*, unsigned int, unsigned int, unsigned int, float);
typedef void (*yogaNodeStyleSetEnum_fn)(void*, unsigned int, unsigned int);
typedef void (*yogaNodeCalculateLayout_fn)(void*, float, float);

static struct {
    createRenderer_fn createRenderer;
    destroyRenderer_fn destroyRenderer;
    setUseThread_fn setUseThread;
    setClearOnShutdown_fn setClearOnShutdown;
    setupTerminal_fn setupTerminal;
    yogaNodeCreateForOpenTUI_fn yogaNodeCreateForOpenTUI;
    yogaNodeFree_fn yogaNodeFree;
    yogaNodeStyleSetValue_fn yogaNodeStyleSetValue;
    yogaNodeStyleSetEnum_fn yogaNodeStyleSetEnum;
    yogaNodeCalculateLayout_fn yogaNodeCalculateLayout;
} opentui;

static void* opentui_lib = NULL;

int shim_init(const char* libpath) {
    opentui_lib = dlopen(libpath, 1);
    if (!opentui_lib) return -1;
    opentui.createRenderer = dlsym(opentui_lib, "createRenderer");
    opentui.destroyRenderer = dlsym(opentui_lib, "destroyRenderer");
    opentui.setUseThread = dlsym(opentui_lib, "setUseThread");
    opentui.setClearOnShutdown = dlsym(opentui_lib, "setClearOnShutdown");
    opentui.setupTerminal = dlsym(opentui_lib, "setupTerminal");
    opentui.yogaNodeCreateForOpenTUI = dlsym(opentui_lib, "yogaNodeCreateForOpenTUI");
    opentui.yogaNodeFree = dlsym(opentui_lib, "yogaNodeFree");
    opentui.yogaNodeStyleSetValue = dlsym(opentui_lib, "yogaNodeStyleSetValue");
    opentui.yogaNodeStyleSetEnum = dlsym(opentui_lib, "yogaNodeStyleSetEnum");
    opentui.yogaNodeCalculateLayout = dlsym(opentui_lib, "yogaNodeCalculateLayout");
    if (!opentui.createRenderer || !opentui.yogaNodeCreateForOpenTUI) return -2;
    return 0;
}

unsigned int shim_createRenderer(unsigned int w, unsigned int h, unsigned char a, unsigned char b) {
    return opentui.createRenderer(w, h, a, b, NULL);
}

void shim_destroyRenderer(unsigned int r) { opentui.destroyRenderer(r); }

void shim_setupTerminal(unsigned int r, int t) {
    opentui.setUseThread(r, 0);
    opentui.setClearOnShutdown(r, 0);
    opentui.setupTerminal(r, t);
}

unsigned int shim_yogaNodeCreate(void) {
    void* node = opentui.yogaNodeCreateForOpenTUI();
    if (!node) return 0;
    return ptr_to_handle(node);
}

void shim_yogaNodeFree(unsigned int handle) {
    void* node = handle_to_ptr(handle);
    if (node) { opentui.yogaNodeFree(node); free_handle(handle); }
}

void shim_yogaNodeStyleSetValue(unsigned int h, unsigned int k, unsigned int e, unsigned int u, float v) {
    void* node = handle_to_ptr(h);
    if (node) opentui.yogaNodeStyleSetValue(node, k, e, u, v);
}

void shim_yogaNodeStyleSetEnum(unsigned int h, unsigned int k, unsigned int v) {
    void* node = handle_to_ptr(h);
    if (node) opentui.yogaNodeStyleSetEnum(node, k, v);
}

void shim_yogaNodeCalculateLayout(unsigned int h, float w, float hh) {
    void* node = handle_to_ptr(h);
    if (node) opentui.yogaNodeCalculateLayout(node, w, hh);
}
`

fs.writeFileSync(cFile, shimSource)

const libPath = "/data/data/com.termux/files/home/opentui/packages/core/prebuilt/aarch64-android/libopentui.so"

console.log("Compiling handle shim...")
const lib = cc({
  source: cFile,
  symbols: {
    shim_init: { args: ["cstring"], returns: "i32" },
    shim_createRenderer: { args: ["u32", "u32", "u8", "u8"], returns: "u32" },
    shim_destroyRenderer: { args: ["u32"], returns: "void" },
    shim_setupTerminal: { args: ["u32", "i32"], returns: "void" },
    shim_yogaNodeCreate: { args: [], returns: "u32" },
    shim_yogaNodeFree: { args: ["u32"], returns: "void" },
    shim_yogaNodeStyleSetValue: { args: ["u32", "u32", "u32", "u32", "f32"], returns: "void" },
    shim_yogaNodeStyleSetEnum: { args: ["u32", "u32", "u32"], returns: "void" },
    shim_yogaNodeCalculateLayout: { args: ["u32", "f32", "f32"], returns: "void" },
  },
})

console.log("Initializing (dlopen in C)...")
const initResult = lib.symbols.shim_init(libPath)
console.log("shim_init =", initResult)
if (initResult !== 0) {
  console.log("❌ Failed to init shim")
  process.exit(1)
}

console.log("\nCreating renderer...")
const renderer = lib.symbols.shim_createRenderer(80, 24, 0, 0)
console.log("renderer =", renderer)

console.log("Setting up terminal...")
lib.symbols.shim_setupTerminal(renderer, 0)

console.log("\nCreating yoga node (handle-based)...")
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

console.log("\n🎉 ALL TESTS PASSED — handle table approach works!")
