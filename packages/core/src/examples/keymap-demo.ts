import { BoxRenderable, createCliRenderer, RenderableEvents, TextRenderable, type CliRenderer } from "../index.js"
import {
  getKeymapManager,
  registerExCommands,
  registerMetadataFields,
  registerTimedLeader,
  type KeymapActiveBinding,
  type KeymapManager,
  type KeymapResolvedCommand,
  stringifyKeySequence,
  stringifyKeyStroke,
} from "../extras.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let root: BoxRenderable | null = null
let alphaPanel: BoxRenderable | null = null
let betaPanel: BoxRenderable | null = null
let alphaText: TextRenderable | null = null
let betaText: TextRenderable | null = null
let detailsText: TextRenderable | null = null
let whichKeyText: TextRenderable | null = null
let keymapManager: KeymapManager | null = null

let alphaCount = 0
let betaCount = 0
let helpVisible = true
let leaderArmed = false
let lastAction = "Click a panel or press Tab to start."
let logLines: string[] = []
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

function getMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed
}

function getCommandLabel(command: KeymapResolvedCommand): string {
  return getMetadataText(command.attrs?.desc) ?? getMetadataText(command.attrs?.title) ?? command.input
}

function getBindingLabel(binding: KeymapActiveBinding): string {
  return getMetadataText(binding.attrs?.desc) ?? getCommandLabel(binding.command)
}

function getSharedBindingText(bindings: readonly KeymapActiveBinding[], name: string): string | undefined {
  let shared: string | undefined

  for (const binding of bindings) {
    const value = getMetadataText(binding.attrs?.[name])
    if (!value) {
      return undefined
    }

    if (shared === undefined) {
      shared = value
      continue
    }

    if (shared !== value) {
      return undefined
    }
  }

  return shared
}

function uniqueLabels(labels: Iterable<string>): string[] {
  const unique: string[] = []
  const seen = new Set<string>()

  for (const label of labels) {
    if (seen.has(label)) {
      continue
    }

    seen.add(label)
    unique.push(label)
  }

  return unique
}

function getActiveKeyLabel(activeKey: ReturnType<KeymapManager["getActiveKeys"]>[number]): string {
  const bindings = activeKey.bindings ?? []
  const group = activeKey.continues ? getSharedBindingText(bindings, "group") : undefined
  if (group) {
    return `+${group}`
  }

  const labels =
    bindings.length > 0
      ? uniqueLabels(bindings.map(getBindingLabel))
      : uniqueLabels(activeKey.commands.map(getCommandLabel))
  if (labels.length > 0) {
    return labels.join(" | ")
  }

  return activeKey.commands.map((command) => command.input).join(" | ")
}

function buildWhichKeyLines(): string[] {
  if (!keymapManager) {
    return ["Which Key", "manager unavailable"]
  }

  const activeKeys = [...keymapManager.getActiveKeys({ includeBindings: true })].sort((left, right) => {
    return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
      stringifyKeyStroke(right, { preferDisplay: true }),
    )
  })

  const prefix = stringifyKeySequence(keymapManager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
  const lines = ["Which Key", `Prefix: ${prefix}`]

  if (activeKeys.length === 0) {
    lines.push("(no active keys)")
  } else {
    for (const activeKey of activeKeys.slice(0, 8)) {
      lines.push(`${stringifyKeyStroke(activeKey, { preferDisplay: true })} -> ${getActiveKeyLabel(activeKey)}`)
    }
  }

  lines.push("", "Ex commands", ":reset / :r", ":write <file> / :w <file>")

  return lines
}

function renderPanels(): void {
  if (!alphaText || !betaText) {
    return
  }

  alphaText.content = ["Alpha Panel", `Count: ${alphaCount}`, "j: +1", "k: -1", "enter: :w alpha-panel.txt"].join("\n")

  betaText.content = ["Beta Panel", `Count: ${betaCount}`, "j: +5", "k: -5", "enter: :w beta-panel.txt"].join("\n")
}

function renderStatus(renderer: CliRenderer): void {
  if (!detailsText || !whichKeyText) {
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
      "enter on a panel: :w alpha-panel.txt / beta-panel.txt",
      "ctrl+x then s: :w session.log",
      "ctrl+x then h: toggle help",
    )
  }

  if (logLines.length > 0) {
    lines.push("", "Recent log:", ...logLines)
  }

  detailsText.content = lines.join("\n")
  whichKeyText.content = buildWhichKeyLines().join("\n")
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
  const manager = getKeymapManager(renderer)
  keymapManager = manager

  disposers.push(registerMetadataFields(manager))

  disposers.push(
    manager.registerCommands([
      {
        name: "focus-next",
        title: "Next panel",
        desc: "Next panel",
        category: "Navigation",
        run() {
          moveFocus(renderer, 1)
        },
      },
      {
        name: "focus-prev",
        title: "Prev panel",
        desc: "Prev panel",
        category: "Navigation",
        run() {
          moveFocus(renderer, -1)
        },
      },
      {
        name: "toggle-help",
        title: "Toggle help",
        desc: "Toggle help",
        category: "View",
        run() {
          helpVisible = !helpVisible
          setStatus(renderer, helpVisible ? "Help shown" : "Help hidden")
        },
      },
      {
        name: "alpha-up",
        title: "Alpha +1",
        desc: "Alpha +1",
        category: "Alpha",
        run() {
          alphaCount += 1
          setStatus(renderer, `Alpha increased to ${alphaCount}`)
        },
      },
      {
        name: "alpha-down",
        title: "Alpha -1",
        desc: "Alpha -1",
        category: "Alpha",
        run() {
          alphaCount -= 1
          setStatus(renderer, `Alpha decreased to ${alphaCount}`)
        },
      },
      {
        name: "beta-up",
        title: "Beta +5",
        desc: "Beta +5",
        category: "Beta",
        run() {
          betaCount += 5
          setStatus(renderer, `Beta increased to ${betaCount}`)
        },
      },
      {
        name: "beta-down",
        title: "Beta -5",
        desc: "Beta -5",
        category: "Beta",
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
        title: "Reset counters",
        desc: "Reset counters",
        category: "Session",
        run() {
          alphaCount = 0
          betaCount = 0
          setStatus(renderer, "Counters reset through :reset")
        },
      },
      {
        name: "write",
        aliases: ["w"],
        nargs: "1",
        title: "Write file",
        desc: "Write file",
        category: "File",
        run({ raw, args }) {
          setStatus(renderer, `Ex command: ${raw} -> wrote ${args[0]}`)
        },
      },
    ]),
  )

  disposers.push(
    registerTimedLeader(manager, {
      trigger: { name: "x", ctrl: true },
      onArm() {
        leaderArmed = true
        lastAction = "Leader armed: press s or h"
        renderStatus(renderer)
      },
      onDisarm() {
        leaderArmed = false
        renderStatus(renderer)
      },
    }),
  )

  disposers.push(
    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "tab", cmd: "focus-next" },
        { key: "shift+tab", cmd: "focus-prev" },
        { key: "?", cmd: "toggle-help" },
        { key: "ctrl+r", cmd: ":reset" },
        { key: "<leader>s", cmd: ":w session.log", desc: "Write session log", group: "Leader" },
        { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help", group: "Leader" },
      ],
    }),
  )

  disposers.push(
    manager.onPendingSequenceChange(() => {
      renderStatus(renderer)
    }),
  )

  if (alphaPanel) {
    disposers.push(
      manager.registerLayer({
        target: alphaPanel,
        bindings: [
          { key: "j", cmd: "alpha-up" },
          { key: "k", cmd: "alpha-down" },
          { key: "enter", cmd: ":w alpha-panel.txt", desc: "Write alpha panel" },
        ],
      }),
    )
  }

  if (betaPanel) {
    disposers.push(
      manager.registerLayer({
        target: betaPanel,
        bindings: [
          { key: "j", cmd: "beta-up" },
          { key: "k", cmd: "beta-down" },
          { key: "enter", cmd: ":w beta-panel.txt", desc: "Write beta panel" },
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
    content:
      "Shows global layers, focused layers, which-key hints from metadata, ex commands, and a ctrl+x leader extension.",
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
    gap: 2,
    flexDirection: "row",
    flexGrow: 1,
  })
  root.add(footer)

  const detailsPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-details-panel",
    flexGrow: 1,
  })
  footer.add(detailsPanel)

  detailsText = new TextRenderable(renderer, {
    id: "keymap-demo-details",
    content: "",
    fg: "#f8fafc",
    height: 12,
  })
  detailsPanel.add(detailsText)

  const whichKeyPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-which-key-panel",
    width: 28,
  })
  footer.add(whichKeyPanel)

  whichKeyText = new TextRenderable(renderer, {
    id: "keymap-demo-which-key",
    content: "",
    fg: "#cbd5e1",
    height: 12,
  })
  whichKeyPanel.add(whichKeyText)

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
  leaderArmed = false

  while (disposers.length > 0) {
    const dispose = disposers.pop()
    dispose?.()
  }

  root?.destroyRecursively()

  keymapManager = null
  root = null
  alphaPanel = null
  betaPanel = null
  alphaText = null
  betaText = null
  detailsText = null
  whichKeyText = null
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
