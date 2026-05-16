import { describe, expect, test } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"

function waitForWorker(worker: Worker) {
  let timeout: ReturnType<typeof setTimeout>
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("worker did not complete")), 5_000)
    worker.addEventListener("message", () => resolve(), { once: true })
    worker.addEventListener(
      "error",
      (event) => {
        reject(event.error ?? new Error(event.message))
      },
      { once: true },
    )
  }).finally(() => {
    clearTimeout(timeout)
  })
}

describe("native event worker callback repro", () => {
  test("keeps native event callback valid after a worker installs and releases its callback", async () => {
    if (process.env.OPENTUI_NATIVE_EVENT_WORKER_REPRO !== "1") return

    console.log("native-event-worker-repro: main before first")
    const first = EditBuffer.create("unicode")
    first.on("content-changed", () => {})
    first.setText("main-before-worker")
    await Bun.sleep(0)
    console.log("native-event-worker-repro: main before worker")

    const worker = new Worker(new URL("./native-event-worker-repro.worker.ts", import.meta.url), {
      type: "module",
    })
    await waitForWorker(worker)
    console.log("native-event-worker-repro: main after worker")
    await worker.terminate()
    console.log("native-event-worker-repro: main after terminate")

    let delivered = 0
    const second = EditBuffer.create("unicode")
    second.on("content-changed", () => {
      delivered++
    })

    second.setText("main-after-worker")
    await Bun.sleep(0)
    console.log("native-event-worker-repro: delivered", delivered)

    second.destroy()
    first.destroy()

    expect(delivered).toBe(1)
  })
})
