import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { capture } from "../console.ts"
import { clearEnvCache } from "../lib/env.ts"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

let renderer: TestRenderer | null = null
let previousShowConsole: string | undefined
let previousUseAlternateScreen: string | undefined
let previousOverrideStdout: string | undefined
let previousUseConsole: string | undefined

const textScrollbackComponent = {
  scrollback: (data: string) => data,
}

beforeEach(() => {
  previousShowConsole = process.env.SHOW_CONSOLE
  previousUseAlternateScreen = process.env.OTUI_USE_ALTERNATE_SCREEN
  previousOverrideStdout = process.env.OTUI_OVERRIDE_STDOUT
  previousUseConsole = process.env.OTUI_USE_CONSOLE
  delete process.env.SHOW_CONSOLE
  delete process.env.OTUI_USE_ALTERNATE_SCREEN
  delete process.env.OTUI_OVERRIDE_STDOUT
  delete process.env.OTUI_USE_CONSOLE
  clearEnvCache()
})

afterEach(() => {
  renderer?.destroy()
  renderer = null
  capture.claimOutput()

  if (previousShowConsole === undefined) {
    delete process.env.SHOW_CONSOLE
  } else {
    process.env.SHOW_CONSOLE = previousShowConsole
  }

  if (previousUseAlternateScreen === undefined) {
    delete process.env.OTUI_USE_ALTERNATE_SCREEN
  } else {
    process.env.OTUI_USE_ALTERNATE_SCREEN = previousUseAlternateScreen
  }

  if (previousOverrideStdout === undefined) {
    delete process.env.OTUI_OVERRIDE_STDOUT
  } else {
    process.env.OTUI_OVERRIDE_STDOUT = previousOverrideStdout
  }

  if (previousUseConsole === undefined) {
    delete process.env.OTUI_USE_CONSOLE
  } else {
    process.env.OTUI_USE_CONSOLE = previousUseConsole
  }

  clearEnvCache()
})

test("CliRenderer initializes its clock before SHOW_CONSOLE triggers a render", async () => {
  process.env.SHOW_CONSOLE = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    clock: new ManualClock(),
  })

  renderer = result.renderer

  expect(renderer).toBeDefined()
})

test("CliRenderer uses its shared clock for debounced resize", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    clock,
  })

  renderer = result.renderer
  ;(renderer as any).handleResize(70, 30)

  expect(renderer.width).toBe(40)
  expect(renderer.height).toBe(20)

  clock.advance(99)

  expect(renderer.width).toBe(40)
  expect(renderer.height).toBe(20)

  clock.advance(1)

  expect(renderer.width).toBe(70)
  expect(renderer.height).toBe(30)
})

test("CliRenderer applies explicit screen and output modes", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("split-footer")
  expect(renderer.footerHeight).toBe(6)
  expect(renderer.externalOutputMode).toBe("capture-stdout")
  expect(renderer.consoleMode).toBe("disabled")
})

test("CliRenderer consoleMode disabled restores the original console", async () => {
  process.env.OTUI_USE_CONSOLE = "true"
  clearEnvCache()

  const originalConsole = global.console

  const result = await createTestRenderer({
    consoleMode: "console-overlay",
  })

  renderer = result.renderer

  expect(global.console).not.toBe(originalConsole)

  renderer.consoleMode = "disabled"

  expect(global.console).toBe(originalConsole)
})

test("CliRenderer clamps split footer height to terminal height at startup", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 5,
    screenMode: "split-footer",
    footerHeight: 12,
    externalOutputMode: "capture-stdout",
  })

  renderer = result.renderer

  expect(renderer.footerHeight).toBe(12)
  expect(renderer.height).toBe(5)
  expect((renderer as any)._splitHeight).toBe(5)
  expect((renderer as any).renderOffset).toBe(0)
})

test("CliRenderer rejects captured output outside split-footer mode", async () => {
  await expect(
    createTestRenderer({
      screenMode: "main-screen",
      externalOutputMode: "capture-stdout",
    }),
  ).rejects.toThrow('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
})

test("CliRenderer writeToScrollback throws when screen mode is not split-footer", async () => {
  const result = await createTestRenderer({
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await expect(renderer.writeToScrollback(textScrollbackComponent, "ignored\n")).rejects.toThrow(
    'writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
  )
})

test("CliRenderer writeToScrollback throws when external output mode is passthrough", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await expect(renderer.writeToScrollback(textScrollbackComponent, "ignored\n")).rejects.toThrow(
    'writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
  )
})

test("CliRenderer writeToScrollback enqueues text and commits unchanged bytes", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  await renderer.writeToScrollback(textScrollbackComponent, "api-line-1\napi-line-2\n")

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  await result.renderOnce()

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)

  const outputBytes = splitCommitSpy.mock.calls[0]?.[1] as Uint8Array
  const decodedOutput = new TextDecoder().decode(outputBytes)
  expect(decodedOutput).toBe("api-line-1\napi-line-2\n")

  splitCommitSpy.mockRestore()
})

test("CliRenderer writeToScrollback passes width and widthMethod to the scrollback component", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  let receivedContext: { width: number; widthMethod: string } | null = null

  await renderer.writeToScrollback(
    {
      scrollback: (_data: null, ctx) => {
        receivedContext = ctx
        return "ctx\n"
      },
    },
    null,
  )

  expect(receivedContext).toEqual({
    width: renderer.width,
    widthMethod: renderer.widthMethod,
  })
})

test("CliRenderer preserves append order when writeToScrollback and stdout capture are interleaved", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  await renderer.writeToScrollback(textScrollbackComponent, "api-1\n")
  ;(renderer as any).stdout.write("stdout-1\n")
  await renderer.writeToScrollback(textScrollbackComponent, "api-2\n")

  await result.renderOnce()

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)

  const outputBytes = splitCommitSpy.mock.calls[0]?.[1] as Uint8Array
  const decodedOutput = new TextDecoder().decode(outputBytes)
  expect(decodedOutput).toBe("api-1\nstdout-1\napi-2\n")

  splitCommitSpy.mockRestore()
})

test("CliRenderer writeToScrollback bypasses global console capture singleton", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  capture.claimOutput()

  await renderer.writeToScrollback(textScrollbackComponent, "api-only\n")
  await result.renderOnce()

  expect(capture.size).toBe(0)
  expect(capture.claimOutput()).toBe("")
})

test("CliRenderer flushes captured output before switching to passthrough in split-footer", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  ;(renderer as any).stdout.write("pending output\n")

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  renderer.externalOutputMode = "passthrough"

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)
  const flushedOutput = new TextDecoder().decode(splitCommitSpy.mock.calls[0]?.[1] as Uint8Array)
  expect(flushedOutput).toBe("pending output\n")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  splitCommitSpy.mockRestore()
})

test("CliRenderer flushes pending split output before resize applies new geometry", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).stdout.write("before-resize\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalRenderSplitFooter = lib.renderSplitFooter.bind(lib)
  const originalResizeRenderer = lib.resizeRenderer.bind(lib)

  lib.renderSplitFooter = (...args: any[]) => {
    order.push("split-commit")
    return originalRenderSplitFooter(...args)
  }
  lib.resizeRenderer = (...args: any[]) => {
    order.push("resize")
    return originalResizeRenderer(...args)
  }

  ;(renderer as any).processResize(60, 16)

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("resize")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("resize"))

  lib.renderSplitFooter = originalRenderSplitFooter
  lib.resizeRenderer = originalResizeRenderer
})

test("CliRenderer flushes pending writeToScrollback output before resize applies new geometry", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  await renderer.writeToScrollback(textScrollbackComponent, "before-resize\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalRenderSplitFooter = lib.renderSplitFooter.bind(lib)
  const originalResizeRenderer = lib.resizeRenderer.bind(lib)

  lib.renderSplitFooter = (...args: any[]) => {
    order.push("split-commit")
    return originalRenderSplitFooter(...args)
  }
  lib.resizeRenderer = (...args: any[]) => {
    order.push("resize")
    return originalResizeRenderer(...args)
  }

  ;(renderer as any).processResize(60, 16)

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("resize")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("resize"))

  lib.renderSplitFooter = originalRenderSplitFooter
  lib.resizeRenderer = originalResizeRenderer
})

test("CliRenderer reuses generic suspend/resume native helpers in split-footer mode", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  const suspendGenericSpy = spyOn((renderer as any).lib, "suspendRenderer")
  const resumeGenericSpy = spyOn((renderer as any).lib, "resumeRenderer")

  renderer.suspend()
  renderer.resume()

  expect(suspendGenericSpy).toHaveBeenCalledTimes(1)
  expect(resumeGenericSpy).toHaveBeenCalledTimes(1)

  suspendGenericSpy.mockRestore()
  resumeGenericSpy.mockRestore()
})

test("CliRenderer does not flush captured split output during resize while suspended", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  renderer.suspend()
  ;(renderer as any).stdout.write("during-suspend\n")
  ;(renderer as any).processResize(60, 16)

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)

  splitCommitSpy.mockRestore()
})

test("CliRenderer flushes pending writeToScrollback output before suspend", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  await renderer.writeToScrollback(textScrollbackComponent, "before-suspend\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalRenderSplitFooter = lib.renderSplitFooter.bind(lib)
  const originalSuspendRenderer = lib.suspendRenderer.bind(lib)

  lib.renderSplitFooter = (...args: any[]) => {
    order.push("split-commit")
    return originalRenderSplitFooter(...args)
  }
  lib.suspendRenderer = (...args: any[]) => {
    order.push("suspend")
    return originalSuspendRenderer(...args)
  }

  renderer.suspend()

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("suspend")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("suspend"))

  lib.renderSplitFooter = originalRenderSplitFooter
  lib.suspendRenderer = originalSuspendRenderer
})

test("CliRenderer clears split footer surface when leaving split-footer mode", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const clearCalls: number[] = []
  const lib = (renderer as any).lib
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)

  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      clearCalls.push(args[1])
    }
    return originalSetRenderOffset(...args)
  }

  renderer.screenMode = "main-screen"

  expect(clearCalls.length).toBeGreaterThanOrEqual(1)

  lib.setRenderOffset = originalSetRenderOffset
})

test("CliRenderer destroy flushes split output before clearing split footer surface", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).stdout.write("before-destroy\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalRenderSplitFooter = lib.renderSplitFooter.bind(lib)
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)

  lib.renderSplitFooter = (...args: any[]) => {
    order.push("split-commit")
    return originalRenderSplitFooter(...args)
  }
  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      order.push("clear")
    }
    return originalSetRenderOffset(...args)
  }
  lib.destroyRenderer = (...args: any[]) => {
    order.push("destroy")
    return originalDestroyRenderer(...args)
  }

  renderer.destroy()

  expect(order).toEqual(["split-commit", "clear", "destroy"])

  lib.renderSplitFooter = originalRenderSplitFooter
  lib.setRenderOffset = originalSetRenderOffset
  lib.destroyRenderer = originalDestroyRenderer
})

test("CliRenderer destroy flushes writeToScrollback output before clearing split footer surface", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  await renderer.writeToScrollback(textScrollbackComponent, "before-destroy\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalRenderSplitFooter = lib.renderSplitFooter.bind(lib)
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)

  lib.renderSplitFooter = (...args: any[]) => {
    order.push("split-commit")
    return originalRenderSplitFooter(...args)
  }
  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      order.push("clear")
    }
    return originalSetRenderOffset(...args)
  }
  lib.destroyRenderer = (...args: any[]) => {
    order.push("destroy")
    return originalDestroyRenderer(...args)
  }

  renderer.destroy()

  expect(order).toEqual(["split-commit", "clear", "destroy"])

  lib.renderSplitFooter = originalRenderSplitFooter
  lib.setRenderOffset = originalSetRenderOffset
  lib.destroyRenderer = originalDestroyRenderer
})

test("CliRenderer split-footer passthrough ignores console capture writes", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const requestRenderSpy = spyOn(renderer, "requestRender")

  capture.write("stdout", "from console capture\n")

  expect(requestRenderSpy).toHaveBeenCalledTimes(0)
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  requestRenderSpy.mockRestore()
})

test("CliRenderer split-footer captures direct console writes when console mode is disabled", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("direct write\n")

  expect((renderer as any).externalOutputQueue.claim()).toBe("direct write\n")
  expect(capture.size).toBe(0)
})

test("CliRenderer split-footer renderNative does not call TypeScript flush path", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const flushSpy = spyOn(renderer as any, "flushStdoutCache")

  ;(renderer as any).stdout.write("pending output\n")
  await result.renderOnce()

  expect(flushSpy).toHaveBeenCalledTimes(0)
  flushSpy.mockRestore()
})

test("CliRenderer split-footer starts in settling phase and then pins as output grows", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect((renderer as any).renderOffset).toBe(0)

  ;(renderer as any).stdout.write("a\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(2)

  ;(renderer as any).stdout.write("b\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(3)

  ;(renderer as any).stdout.write("c\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(4)

  for (let i = 0; i < 8; i++) {
    ;(renderer as any).stdout.write(`line-${i}\n`)
    await result.renderOnce()
  }

  expect((renderer as any).renderOffset).toBe(6)
})

test("CliRenderer split-footer commits only unpublished captured output chunks", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  ;(renderer as any).stdout.write("first\n")
  await result.renderOnce()

  ;(renderer as any).stdout.write("second\n")
  await result.renderOnce()

  await result.renderOnce()

  const firstOutput = new TextDecoder().decode(splitCommitSpy.mock.calls[0]?.[1] as Uint8Array)
  const secondOutput = new TextDecoder().decode(splitCommitSpy.mock.calls[1]?.[1] as Uint8Array)
  const thirdOutput = new TextDecoder().decode(splitCommitSpy.mock.calls[2]?.[1] as Uint8Array)

  expect(firstOutput).toBe("first\n")
  expect(secondOutput).toBe("second\n")
  expect(thirdOutput).toBe("")
  splitCommitSpy.mockRestore()
})

test("CliRenderer split-footer passes captured output bytes through unchanged to native commit", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "renderSplitFooter")

  ;(renderer as any).stdout.write("line-1\nline-2\n")
  await result.renderOnce()

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)

  const outputBytes = splitCommitSpy.mock.calls[0]?.[1] as Uint8Array
  const decodedOutput = new TextDecoder().decode(outputBytes)
  expect(decodedOutput).toBe("line-1\nline-2\n")
  expect((renderer as any).renderOffset).toBe(3)

  splitCommitSpy.mockRestore()
})

test("CliRenderer split-footer native scrollback tracks wrapped tail state across commits", async () => {
  const result = await createTestRenderer({
    width: 4,
    height: 6,
    screenMode: "split-footer",
    footerHeight: 2,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("abcd")
  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(1)

  ;(renderer as any).stdout.write("e")
  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(2)
})

test("CliRenderer flushes captured output when leaving split-footer for alternate-screen", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    useThread: false,
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).lib.suspendRenderer = () => {}
  ;(renderer as any).lib.setupTerminal = () => {}

  ;(renderer as any).stdout.write("pending output\n")
  renderer.externalOutputMode = "passthrough"
  renderer.screenMode = "alternate-screen"

  expect((renderer as any).externalOutputQueue.size).toBe(0)
})

test("CliRenderer allows env to force main-screen mode", async () => {
  process.env.OTUI_USE_ALTERNATE_SCREEN = "false"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "alternate-screen",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("main-screen")
})

test("CliRenderer allows env to force alternate-screen mode", async () => {
  process.env.OTUI_USE_ALTERNATE_SCREEN = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "main-screen",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("alternate-screen")
})

test("CliRenderer allows env to force passthrough stdout", async () => {
  process.env.OTUI_OVERRIDE_STDOUT = "false"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  renderer = result.renderer

  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("CliRenderer allows env to force captured stdout in split-footer", async () => {
  process.env.OTUI_OVERRIDE_STDOUT = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "passthrough",
  })

  renderer = result.renderer

  expect(renderer.externalOutputMode).toBe("capture-stdout")
})
