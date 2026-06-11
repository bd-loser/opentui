import { afterEach, describe, expect, it } from "bun:test"
import { For, createSignal } from "solid-js"
import { testRender } from "../index.js"
import type { BoxRenderable, ScrollBoxRenderable } from "../../core/src/renderables/index.js"

let setups: Array<Awaited<ReturnType<typeof testRender>>> = []

afterEach(() => {
  for (const setup of setups) setup.renderer.destroy()
  setups = []
})

describe("ScrollBox streaming blank content", () => {
  it("renders every child that occupies the viewport", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => i)
    const [streamLines, setStreamLines] = createSignal(["STREAM_PENDING"])

    function InlineTool(props: { row: number }) {
      const [margin, setMargin] = createSignal(0)
      return (
        <box
          id={`tool-${props.row}`}
          paddingLeft={3}
          marginTop={margin()}
          renderBefore={function () {
            const element = this as BoxRenderable
            const parent = element.parent
            if (!parent) return
            const siblings = parent.getChildren()
            const previous = siblings[siblings.indexOf(element) - 1]
            setMargin(previous?.id.startsWith("message-") ? 1 : 0)
          }}
        >
          <text>TOOL_{props.row}</text>
        </box>
      )
    }

    let scroll: ScrollBoxRenderable | undefined
    const setup = await testRender(
      () => (
        <box flexDirection="column" width={100} height={23}>
          <scrollbox ref={(value) => (scroll = value)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={rows}>
              {(row) => (
                <>
                  <box id={`message-${row}`} border={["left"]} marginTop={1} paddingTop={1} paddingBottom={1}>
                    <text>MESSAGE_{row}</text>
                  </box>
                  <InlineTool row={row} />
                  <box id={`text-${row}`} border={["left"]} marginTop={1} paddingTop={1} paddingBottom={1}>
                    <text>{`VALUE_${row}\nDONE_${row}`}</text>
                  </box>
                </>
              )}
            </For>
            <box id="stream-tail" flexShrink={0} border={["left"]} marginTop={1}>
              <For each={streamLines()}>{(line) => <text>{line}</text>}</For>
            </box>
          </scrollbox>
        </box>
      ),
      { width: 100, height: 23 },
    )
    setups.push(setup)

    await setup.renderOnce()
    await setup.renderOnce()
    scroll!.scrollTo(40)
    setStreamLines(Array.from({ length: 20 }, (_, i) => `STREAM_RESULT_${i}`))
    await setup.renderOnce()

    const culledFrame = setup.captureCharFrame()
    const culledChildren = (scroll!.content as any)
      ._getVisibleChildren()
      .map((num: number) => scroll!.getChildren().find((child) => child.num === num)?.id)
      .filter(Boolean)
    const culledRenderList = ((setup.renderer.root as any).renderList as Array<any>)
      .filter((command) => command.action === "render")
      .map((command) => command.renderable.id)
      .filter((id) => /^(?:message|tool|text)-/.test(id))

    scroll!.viewportCulling = false
    await setup.renderOnce()
    await setup.renderOnce()
    scroll!.scrollTo(40)
    await setup.renderOnce()
    const unculledFrame = setup.captureCharFrame()

    const tokenPattern = /(?:MESSAGE|TOOL|VALUE|DONE)_\d+/g
    const culledTokens = new Set(culledFrame.match(tokenPattern) ?? [])
    const unculledTokens = new Set(unculledFrame.match(tokenPattern) ?? [])
    const missing = [...unculledTokens].filter((token) => !culledTokens.has(token))
    const culledLines = culledFrame.split("\n")
    const unculledLines = unculledFrame.split("\n")
    const blankRows = unculledLines.flatMap((line, index) =>
      line.trim().length > 0 && culledLines[index]?.trim().length === 0 ? [index] : [],
    )

    if (missing.length > 0) {
      console.log("blank culling diagnostic", {
        scrollTop: scroll!.scrollTop,
        missing,
        blankRows,
        culledChildren,
        culledRenderList,
        culledFrame,
        unculledFrame,
      })
    }

    expect(blankRows).toEqual([])
    expect(missing).toEqual([])
  })
})
