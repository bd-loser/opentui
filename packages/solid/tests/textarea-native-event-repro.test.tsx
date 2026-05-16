import { describe, expect, it } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { onMount } from "solid-js"
import { testRender } from "../index.js"

describe("Textarea native event repro", () => {
  it("survives repeated initialValue mount, focus, input, and destroy", async () => {
    const iterations = Number(process.env.OPENTUI_TEXTAREA_REPRO_ITERATIONS ?? 100)

    for (let i = 0; i < iterations; i++) {
      let textarea: TextareaRenderable | undefined

      function App() {
        onMount(() => {
          textarea?.gotoLineEnd()
          setTimeout(() => {
            if (!textarea || textarea.isDestroyed) return
            textarea.focus()
          }, 1)
        })

        return <textarea ref={(value) => (textarea = value)} initialValue={`draft-${i}`} width={20} height={3} />
      }

      const testSetup = await testRender(() => <App />, {
        width: 40,
        height: 10,
        kittyKeyboard: true,
      })

      await testSetup.renderOnce()
      testSetup.mockInput.pressEnter()
      testSetup.renderer.destroy()
      await Bun.sleep(0)
    }

    expect(iterations).toBeGreaterThan(0)
  })
})
