import { afterEach, expect, test } from "bun:test"
import { SyntaxStyle } from "../../syntax-style.js"
import { createTestRenderer, MockTreeSitterClient, type TestRenderer } from "../../testing.js"
import { BoxRenderable } from "../Box.js"
import { CodeRenderable } from "../Code.js"
import { MarkdownRenderable } from "../Markdown.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"

let renderer: TestRenderer | undefined

afterEach(() => {
  renderer?.destroy()
  renderer = undefined
})

const pendingHighlights = (markdown: MarkdownRenderable) => {
  const children = [...markdown.getChildren()]
  const pending: CodeRenderable[] = []
  while (children.length > 0) {
    const child = children.pop()!
    if (child instanceof CodeRenderable && child.isHighlighting) pending.push(child)
    children.push(...child.getChildren())
  }
  return pending
}

test("streaming ordered list keeps growing text visible while markdown highlighting is pending", async () => {
  const setup = await createTestRenderer({ width: 100, height: 16 })
  renderer = setup.renderer
  const treeSitterClient = new MockTreeSitterClient()
  treeSitterClient.setMockResult({ highlights: [] })
  const scrollbox = new ScrollBoxRenderable(renderer, {
    width: 100,
    height: 16,
    viewportCulling: true,
    stickyScroll: true,
    stickyStart: "bottom",
  })
  const container = new BoxRenderable(renderer, {
    width: "100%",
    paddingLeft: 3,
    marginTop: 1,
    flexShrink: 0,
  })
  const markdown = new MarkdownRenderable(renderer, {
    content: `1. Trigger the permission prompt: uninstall and
2. Create a schedule with a confirm-to-start segment: tap +, name it "Test
3. Test the foreground
4. Test the background case: start the schedule again, press the side
5. Test the cancel: start the schedule, wait for the confirm-to-start segment, but stay in the app and tap the in
6. Test app lifecycle edge case: start a schedule with a confirm-to-start segment, wait`,
    syntaxStyle: SyntaxStyle.fromTheme([]),
    treeSitterClient,
    streaming: true,
    internalBlockMode: "top-level",
  })

  container.add(markdown)
  scrollbox.add(container)
  renderer.root.add(scrollbox)

  await setup.renderOnce()
  const initialHighlights = pendingHighlights(markdown)
  treeSitterClient.resolveAllHighlightOnce()
  await Promise.all(initialHighlights.map((code) => code.highlightingDone))
  await setup.renderOnce()

  markdown.content = `1. Trigger the permission prompt: uninstall and reinstall the app, then relaunch it.
2. Create a schedule with a confirm-to-start segment: tap +, name it "Test", and save it.
3. Test the foreground case: start the schedule and use the in-app Start button.
4. Test the background case: start the schedule again, then press the side button.
5. Test the cancel: stay in the app and tap the in-app Start button before the notification appears.
6. Test app lifecycle edge case: wait for the segment, then send the app to the background.`
  await setup.renderOnce()
  const frameWhileHighlighting = setup.captureCharFrame().split("\n")

  const updatedHighlights = pendingHighlights(markdown)
  treeSitterClient.resolveAllHighlightOnce()
  await Promise.all(updatedHighlights.map((code) => code.highlightingDone))
  await setup.renderOnce()
  const settledFrame = setup.captureCharFrame().split("\n")

  expect(settledFrame).toMatchSnapshot("after highlighting settles")
  expect(frameWhileHighlighting).toMatchSnapshot("while updated highlighting is pending")
})
