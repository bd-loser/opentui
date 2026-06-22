import { BoxRenderable, type CliRenderer, TextRenderable, createCliRenderer } from "@opentui/core"

import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const LETTERS = [
  { rows: ["▄▄▄", "█ █", "▀▀▀"], color: "#FF6B6B" },
  { rows: ["▄▄▄", "█ █", "█▀▀"], color: "#FFA94D" },
  { rows: ["▄▄▄", "█ ▀", "▀▀▀"], color: "#FFE066" },
  { rows: ["▄▄ ", "█ █", "▀ ▀"], color: "#69DB7C" },
  { rows: ["█▄▄", "█ ▄", "▀▀▀"], color: "#4DABF7" },
  { rows: ["▄ ▄", "█ █", "▀▀▀"], color: "#748FFC" },
  { rows: ["▄", "█", "▀"], color: "#DA77F2" },
]

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
    flexDirection: "column",
    gap: 2,
    backgroundColor: "#000000",
  })
  const logo = new BoxRenderable(renderer, {
    id: "opentui-logo",
    flexDirection: "row",
    gap: 1,
  })
  LETTERS.forEach((letter, index) =>
    logo.add(
      new TextRenderable(renderer, {
        id: `opentui-logo-letter-${index}`,
        content: letter.rows.join("\n"),
        fg: letter.color,
      }),
    ),
  )
  view.add(logo)
  view.add(
    new TextRenderable(renderer, {
      id: "opentui-logo-caption",
      content: "six pixels tall. unicode considered.",
      fg: "#8B949E",
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
