import { afterEach, expect, test } from "bun:test"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { SyntaxStyle } from "@opentui/core"
import { createSignal } from "solid-js"
import { testRender } from "../index.js"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

const snapshotFrame = (frame: string) => frame.split("\n")

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

test("streaming ordered list keeps growing text visible while markdown highlighting is pending", async () => {
  const treeSitterClient = new MockTreeSitterClient()
  treeSitterClient.setMockResult({ highlights: [] })
  const [content, setContent] = createSignal(`1. Trigger the permission prompt: uninstall and
2. Create a schedule with a confirm-to-start segment: tap +, name it "Test
3. Test the foreground
4. Test the background case: start the schedule again, press the side
5. Test the cancel: start the schedule, wait for the confirm-to-start segment, but stay in the app and tap the in
6. Test app lifecycle edge case: start a schedule with a confirm-to-start segment, wait`)

  setup = await testRender(
    () => (
      <box width={100} height={16}>
        <scrollbox viewportCulling stickyScroll stickyStart="bottom" flexGrow={1}>
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <markdown
              syntaxStyle={SyntaxStyle.fromTheme([])}
              treeSitterClient={treeSitterClient}
              streaming
              internalBlockMode="top-level"
              content={content()}
            />
          </box>
        </scrollbox>
      </box>
    ),
    { width: 100, height: 16 },
  )

  await setup.renderOnce()
  treeSitterClient.resolveAllHighlightOnce()
  await Promise.resolve()
  await Promise.resolve()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("1. Trigger the permission prompt: uninstall and")

  setContent(`1. Trigger the permission prompt: uninstall and reinstall the app, then relaunch it.
2. Create a schedule with a confirm-to-start segment: tap +, name it "Test", and save it.
3. Test the foreground case: start the schedule and use the in-app Start button.
4. Test the background case: start the schedule again, then press the side button.
5. Test the cancel: stay in the app and tap the in-app Start button before the notification appears.
6. Test app lifecycle edge case: wait for the segment, then send the app to the background.`)
  await setup.renderOnce()
  const frameWhileHighlighting = snapshotFrame(setup.captureCharFrame())

  treeSitterClient.resolveAllHighlightOnce()
  await Promise.resolve()
  await Promise.resolve()
  await setup.renderOnce()
  const settledFrame = snapshotFrame(setup.captureCharFrame())

  expect(settledFrame).toMatchSnapshot("after highlighting settles")
  expect(frameWhileHighlighting).toMatchSnapshot("while updated highlighting is pending")
})
