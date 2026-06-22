import { BoxRenderable, type CliRenderer, TextRenderable, createCliRenderer } from "@opentui/core"

import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const LOGO = ["▄▄▄ ▄▄▄ ▄▄▄ ▄▄  █▄▄ ▄ ▄ ▄", "█ █ █ █ █ ▀ █ █ █ ▄ █ █ █", "▀▀▀ █▀▀ ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀"].join("\n")

let view: BoxRenderable | null = null

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#000000")

  view?.destroy()
  view = new BoxRenderable(renderer, {
    id: "opentui-logo-demo",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000000",
  })
  view.add(
    new TextRenderable(renderer, {
      id: "opentui-logo",
      content: LOGO,
      fg: "#FFFFFF",
    }),
  )
  renderer.root.add(view)
}

export function destroy(_renderer: CliRenderer): void {
  view?.destroy()
  view = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: () => (view = null) })
  setupCommonDemoKeys(renderer)
  run(renderer)
}
