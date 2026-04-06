import {
  BoxRenderable,
  createCliRenderer,
  registerActionCommands,
  registerExCommands,
  RenderableEvents,
  TextRenderable,
  type CliRenderer,
  useKeymap,
  useKeymappings,
} from "../index.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let root: BoxRenderable | null = null
let alphaPanel: BoxRenderable | null = null
let betaPanel: BoxRenderable | null = null
let alphaText: TextRenderable | null = null
let betaText: TextRenderable | null = null
let detailsText: TextRenderable | null = null

let alphaCount = 0
let betaCount = 0
let helpVisible = true
let leaderArmed = false
let lastAction = "Click a panel or press Tab to start."
let logLines: string[] = []
let leaderTimeout: ReturnType<typeof setTimeout> | undefined
let disposers: Array<() => void> = []

function addLog(message: string): void {
  logLines = [message, ...logLines].slice(0, 6)
}

function getFocusedPanelName(renderer: CliRenderer): string {
  if (renderer.currentFocusedRenderable === alphaPanel) {
    return "Alpha"
  }

  if (renderer.currentFocusedRenderable === betaPanel) {
    return "Beta"
  }

  return "None"
}

function renderPanels(): void {
  if (!alphaText || !betaText) {
    return
  }

  alphaText.content = [
    "Alpha Panel",
    `Count: ${alphaCount}`,
    "j: +1",
    "k: -1",
    "enter: :announce Alpha confirmed",
  ].join("\n")

  betaText.content = [
    "Beta Panel",
    `Count: ${betaCount}`,
    "j: +5",
    "k: -5",
    "enter: :announce Beta confirmed",
  ].join("\n")
}

function renderStatus(renderer: CliRenderer): void {
  if (!detailsText) {
    return
  }

  const lines = [
    `Focused: ${getFocusedPanelName(renderer)}`,
    `Leader: ${leaderArmed ? "armed (ctrl+x)" : "idle"}`,
    `Last action: ${lastAction}`,
  ]

  if (helpVisible) {
    lines.push(
      "",
      "Global keymaps:",
      "tab / shift+tab: move focus",
      "?: toggle help | ctrl+r: :reset",
      "ctrl+x then s: :announce Saved via leader",
      "ctrl+x then h: toggle help",
    )
  }

  if (logLines.length > 0) {
    lines.push("", "Recent log:", ...logLines)
  }

  detailsText.content = lines.join("\n")
}

function renderAll(renderer: CliRenderer): void {
  renderPanels()
  renderStatus(renderer)
}

function setStatus(renderer: CliRenderer, message: string): void {
  lastAction = message
  addLog(message)
  renderAll(renderer)
}

function clearLeaderTimer(): void {
  if (!leaderTimeout) {
    return
  }

  clearTimeout(leaderTimeout)
  leaderTimeout = undefined
}

function armLeader(renderer: CliRenderer): void {
  clearLeaderTimer()
  leaderArmed = true
  lastAction = "Leader armed: press s or h"
  renderStatus(renderer)

  leaderTimeout = setTimeout(() => {
    leaderArmed = false
    leaderTimeout = undefined
    renderStatus(renderer)
  }, 1500)
}

function moveFocus(renderer: CliRenderer, direction: 1 | -1): void {
  const panels = [alphaPanel, betaPanel].filter((panel): panel is BoxRenderable => panel !== null)
  if (panels.length === 0) {
    return
  }

  const currentIndex = panels.findIndex((panel) => panel === renderer.currentFocusedRenderable)
  const startIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = (startIndex + direction + panels.length) % panels.length
  panels[nextIndex]?.focus()
  setStatus(renderer, `Focused ${nextIndex === 0 ? "Alpha" : "Beta"} panel`)
}

function registerKeymaps(renderer: CliRenderer): void {
  const manager = useKeymappings(renderer)

  disposers.push(
    registerActionCommands(manager, [
      {
        name: "focus-next",
        run() {
          moveFocus(renderer, 1)
        },
      },
      {
        name: "focus-prev",
        run() {
          moveFocus(renderer, -1)
        },
      },
      {
        name: "toggle-help",
        run() {
          helpVisible = !helpVisible
          setStatus(renderer, helpVisible ? "Help shown" : "Help hidden")
        },
      },
      {
        name: "alpha-up",
        run() {
          alphaCount += 1
          setStatus(renderer, `Alpha increased to ${alphaCount}`)
        },
      },
      {
        name: "alpha-down",
        run() {
          alphaCount -= 1
          setStatus(renderer, `Alpha decreased to ${alphaCount}`)
        },
      },
      {
        name: "beta-up",
        run() {
          betaCount += 5
          setStatus(renderer, `Beta increased to ${betaCount}`)
        },
      },
      {
        name: "beta-down",
        run() {
          betaCount -= 5
          setStatus(renderer, `Beta decreased to ${betaCount}`)
        },
      },
    ]),
  )

  disposers.push(
    registerExCommands(manager, [
      {
        name: "reset",
        aliases: ["r"],
        nargs: "0",
        run() {
          alphaCount = 0
          betaCount = 0
          setStatus(renderer, "Counters reset through :reset")
        },
      },
      {
        name: "announce",
        aliases: ["echo"],
        nargs: "+",
        run({ args }) {
          setStatus(renderer, `Ex command: ${args.join(" ")}`)
        },
      },
    ]),
  )

  disposers.push(
    manager.registerToken({
      token: "<leader>",
      data: { prefix: "leader" },
    }),
  )

  disposers.push(
    manager.onKeyInput(({ event, consume, setData }) => {
      if (!leaderArmed) {
        if (event.ctrl && event.name === "x") {
          armLeader(renderer)
          consume()
        }
        return
      }

      leaderArmed = false
      clearLeaderTimer()
      setData("prefix", "leader")
      renderStatus(renderer)
    }),
  )

  disposers.push(
    useKeymap(manager, {
      scope: "global",
      bindings: [
        { key: "tab", cmd: "focus-next" },
        { key: "shift+tab", cmd: "focus-prev" },
        { key: "?", cmd: "toggle-help" },
        { key: "ctrl+r", cmd: ":reset" },
        { key: "<leader>s", cmd: ":announce Saved via leader" },
        { key: "<leader>h", cmd: "toggle-help" },
      ],
    }),
  )

  if (alphaPanel) {
    disposers.push(
      useKeymap(manager, {
        target: alphaPanel,
        bindings: [
          { key: "j", cmd: "alpha-up" },
          { key: "k", cmd: "alpha-down" },
          { key: "enter", cmd: ":announce Alpha confirmed" },
        ],
      }),
    )
  }

  if (betaPanel) {
    disposers.push(
      useKeymap(manager, {
        target: betaPanel,
        bindings: [
          { key: "j", cmd: "beta-up" },
          { key: "k", cmd: "beta-down" },
          { key: "enter", cmd: ":announce Beta confirmed" },
        ],
      }),
    )
  }
}

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#0f172a")

  alphaCount = 0
  betaCount = 0
  helpVisible = true
  leaderArmed = false
  lastAction = "Click a panel or press Tab to start."
  logLines = []
  clearLeaderTimer()

  root = new BoxRenderable(renderer, {
    id: "keymap-demo-root",
    flexDirection: "column",
    padding: 1,
  })
  renderer.root.add(root)

  const title = new TextRenderable(renderer, {
    id: "keymap-demo-title",
    content: "Keymap Demo",
    fg: "#f8fafc",
    height: 1,
  })
  root.add(title)

  const subtitle = new TextRenderable(renderer, {
    id: "keymap-demo-subtitle",
    content: "Shows global layers, focused layers, action commands, ex commands, and a ctrl+x leader extension.",
    fg: "#94a3b8",
    height: 2,
  })
  root.add(subtitle)

  const panels = new BoxRenderable(renderer, {
    id: "keymap-demo-panels",
    flexDirection: "row",
    gap: 1,
    height: 7,
  })
  root.add(panels)

  alphaPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-alpha",
    border: true,
    focusable: true,
    focusedBorderColor: "#38bdf8",
    borderColor: "#475569",
    padding: 1,
    flexDirection: "column",
    flexGrow: 1,
  })
  panels.add(alphaPanel)

  alphaText = new TextRenderable(renderer, {
    id: "keymap-demo-alpha-text",
    content: "",
    fg: "#e2e8f0",
    height: 5,
  })
  alphaPanel.add(alphaText)

  betaPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-beta",
    border: true,
    focusable: true,
    focusedBorderColor: "#34d399",
    borderColor: "#475569",
    padding: 1,
    flexDirection: "column",
    flexGrow: 1,
  })
  panels.add(betaPanel)

  betaText = new TextRenderable(renderer, {
    id: "keymap-demo-beta-text",
    content: "",
    fg: "#e2e8f0",
    height: 5,
  })
  betaPanel.add(betaText)

  const footer = new BoxRenderable(renderer, {
    id: "keymap-demo-footer",
    border: true,
    borderColor: "#475569",
    padding: 1,
    marginTop: 1,
    flexGrow: 1,
  })
  root.add(footer)

  detailsText = new TextRenderable(renderer, {
    id: "keymap-demo-details",
    content: "",
    fg: "#f8fafc",
    height: 9,
  })
  footer.add(detailsText)

  alphaPanel.on(RenderableEvents.FOCUSED, () => {
    renderStatus(renderer)
  })
  alphaPanel.on(RenderableEvents.BLURRED, () => {
    renderStatus(renderer)
  })
  betaPanel.on(RenderableEvents.FOCUSED, () => {
    renderStatus(renderer)
  })
  betaPanel.on(RenderableEvents.BLURRED, () => {
    renderStatus(renderer)
  })

  registerKeymaps(renderer)
  addLog("Tab switches focus. j/k act on the focused panel.")
  addLog("ctrl+x arms the leader extension.")
  renderAll(renderer)
  alphaPanel.focus()
}

export function destroy(_renderer: CliRenderer): void {
  clearLeaderTimer()
  leaderArmed = false

  while (disposers.length > 0) {
    const dispose = disposers.pop()
    dispose?.()
  }

  root?.destroyRecursively()

  root = null
  alphaPanel = null
  betaPanel = null
  alphaText = null
  betaText = null
  detailsText = null
  logLines = []
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
