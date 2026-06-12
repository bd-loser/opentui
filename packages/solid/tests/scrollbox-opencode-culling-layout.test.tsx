import { afterEach, expect, test } from "bun:test"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { For, Show } from "solid-js"
import { testRender } from "../index.js"

const setups: Array<Awaited<ReturnType<typeof testRender>>> = []
afterEach(() => setups.splice(0).forEach((setup) => setup.renderer.destroy()))

async function createSession(viewportCulling: boolean) {
  const syntaxStyle = SyntaxStyle.fromTheme([])
  const treeSitterClient = new MockTreeSitterClient()
  treeSitterClient.setMockResult({ highlights: [] })
  let highlightCalls = 0
  const highlightOnce = treeSitterClient.highlightOnce.bind(treeSitterClient)
  treeSitterClient.highlightOnce = async (...args) => {
    highlightCalls++
    return highlightOnce(...args)
  }
  let scroll: ScrollBoxRenderable | undefined
  const turns = Array.from({ length: 80 }, (_, turn) => turn)
  const setup = await testRender(
    () => (
      <box width={100} height={24}>
        <scrollbox ref={(value) => (scroll = value)} viewportCulling={viewportCulling} flexGrow={1}>
          <For each={turns}>
            {(turn) => (
              <>
                <box id={`text-${turn}`} paddingLeft={3} marginTop={1} flexShrink={0}>
                  <text>Thinking</text>
                  <Show when={turn % 2 === 0}>
                    <box paddingLeft={2} marginTop={1}>
                      <code
                        syntaxStyle={syntaxStyle}
                        treeSitterClient={treeSitterClient}
                        filetype="markdown"
                        drawUnstyledText={false}
                        streaming={true}
                        content={Array.from(
                          { length: 8 },
                          (_, line) => `REASONING_${turn}_${line} ${"wrapped reasoning content ".repeat(18)}`,
                        ).join("\n\n")}
                      />
                    </box>
                  </Show>
                </box>
                <box id={`tool-block-${turn}`} border={["left"]} paddingTop={1} paddingBottom={1} flexShrink={0}>
                  <text>BLOCK_{turn}</text>
                  <text>OUTPUT_{turn}</text>
                </box>
              </>
            )}
          </For>
        </scrollbox>
      </box>
    ),
    { width: 100, height: 24 },
  )
  setups.push(setup)
  await setup.renderOnce()
  treeSitterClient.resolveAllHighlightOnce()
  await Promise.resolve()
  await setup.renderOnce()
  return { setup, scroll: scroll!, highlightCalls: () => highlightCalls }
}

const toolPattern = /(?:BLOCK|OUTPUT)_\d+/g

test("culling keeps OpenCode tool blocks aligned with initialized scrollback layout", async () => {
  const culled = await createSession(true)
  const unculled = await createSession(false)
  expect(culled.highlightCalls()).toBeLessThan(10)
  expect(culled.highlightCalls()).toBeLessThan(unculled.highlightCalls())
  const max = Math.min(culled.scroll.scrollHeight, unculled.scroll.scrollHeight) - culled.scroll.viewport.height

  for (let top = 0; top <= max; top += 20) {
    culled.scroll.scrollTo(top)
    unculled.scroll.scrollTo(top)
    await culled.setup.renderOnce()
    await unculled.setup.renderOnce()

    const actual = new Set(culled.setup.captureCharFrame().match(toolPattern) ?? [])
    const expected = new Set(unculled.setup.captureCharFrame().match(toolPattern) ?? [])
    expect(actual).toEqual(expected)
  }

  expect(culled.scroll.scrollHeight).toBe(unculled.scroll.scrollHeight)
})
