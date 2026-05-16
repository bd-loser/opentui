import { describe, expect, it } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"

describe("EditBuffer native event repro", () => {
  it("reproduces native edit buffer id wraparound", () => {
    if (process.env.OPENTUI_EDIT_BUFFER_ID_WRAP_REPRO !== "1") return

    const seen = new Set<number>()
    const buffers: EditBuffer[] = []

    try {
      for (let i = 0; i < 70_000; i++) {
        const buffer = EditBuffer.create("unicode")
        expect(seen.has(buffer.id)).toBe(false)
        seen.add(buffer.id)
        buffers.push(buffer)
      }
    } finally {
      for (const buffer of buffers) buffer.destroy()
    }
  })

  it("reproduces native event misrouting after edit buffer id wraparound", async () => {
    if (process.env.OPENTUI_EDIT_BUFFER_EVENT_WRAP_REPRO !== "1") return

    const first = EditBuffer.create("unicode")
    const buffers = [first]
    let duplicate: EditBuffer | undefined

    try {
      for (let i = 0; i < 70_000; i++) {
        const buffer = EditBuffer.create("unicode")
        buffers.push(buffer)

        if (buffer.id === first.id) {
          duplicate = buffer
          break
        }
      }

      expect(duplicate).toBeDefined()

      let firstEvents = 0
      let duplicateEvents = 0
      first.on("content-changed", () => {
        firstEvents++
      })
      duplicate?.on("content-changed", () => {
        duplicateEvents++
      })

      first.setText("draft")
      await Bun.sleep(0)

      expect(firstEvents).toBe(1)
      expect(duplicateEvents).toBe(0)
    } finally {
      for (const buffer of buffers) buffer.destroy()
    }
  })

  it("survives repeated setText cursor-event callbacks during immediate destroy", async () => {
    const iterations = Number(process.env.OPENTUI_EDIT_BUFFER_REPRO_ITERATIONS ?? 1_000)
    let cursorEvents = 0
    let contentEvents = 0

    for (let i = 0; i < iterations; i++) {
      const buffer = EditBuffer.create("unicode")
      buffer.on("cursor-changed", () => {
        cursorEvents++
      })
      buffer.on("content-changed", () => {
        contentEvents++
      })

      buffer.setText(`draft-${i}`)
      buffer.destroy()
    }

    await Bun.sleep(0)

    expect(cursorEvents).toBe(0)
    expect(contentEvents).toBe(0)
  })

  it("survives repeated setText native event delivery before destroy", async () => {
    const iterations = Number(process.env.OPENTUI_EDIT_BUFFER_DELIVERY_REPRO_ITERATIONS ?? 1_000)
    let cursorEvents = 0
    let contentEvents = 0

    for (let i = 0; i < iterations; i++) {
      const buffer = EditBuffer.create("unicode")
      buffer.on("cursor-changed", () => {
        cursorEvents++
      })
      buffer.on("content-changed", () => {
        contentEvents++
      })

      buffer.setText(`draft-${i}`)
      await Bun.sleep(0)
      buffer.destroy()
    }

    expect(cursorEvents).toBe(iterations)
    expect(contentEvents).toBe(iterations)
  })
})
