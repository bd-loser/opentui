import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  StyledText,
  createCliRenderer,
  RenderableEvents,
  bold,
  fg,
  type CliRenderer,
  type TextChunk,
} from "../index.js"
import {
  getKeymapManager,
  registerExCommands,
  registerMetadataFields,
  registerTimedLeader,
  type KeymapActiveMetadata,
  type KeymapManager,
  stringifyKeySequence,
  stringifyKeyStroke,
} from "../extras.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

// -- palette ---------------------------------------------------------------

const P = {
  bg: "#0f172a",
  surface: "#1e293b",
  border: "#334155",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  title: "#f1f5f9",
  alpha: "#38bdf8",
  beta: "#34d399",
  accent: "#a78bfa",
  key: "#fbbf24",
  command: "#67e8f9",
  leader: "#fb923c",
  separator: "#475569",
} as const

// -- state -----------------------------------------------------------------

let root: BoxRenderable | null = null
let alphaPanel: BoxRenderable | null = null
let betaPanel: BoxRenderable | null = null
let alphaText: TextRenderable | null = null
let betaText: TextRenderable | null = null
// details column
let statusFocusedText: TextRenderable | null = null
let statusLeaderText: TextRenderable | null = null
let statusLastText: TextRenderable | null = null
let helpBox: BoxRenderable | null = null
let logBox: BoxRenderable | null = null
let logText: TextRenderable | null = null
// which-key column
let whichKeyHeaderText: TextRenderable | null = null
let whichKeyEntriesText: TextRenderable | null = null
let keymapManager: KeymapManager | null = null

let alphaCount = 0
let betaCount = 0
let helpVisible = true
let leaderArmed = false
let lastAction = "Click a panel or press Tab to start."
let logLines: string[] = []
let disposers: Array<() => void> = []

// -- helpers ---------------------------------------------------------------

function addLog(message: string): void {
  logLines = [message, ...logLines].slice(0, 6)
}

function getFocusedPanelName(renderer: CliRenderer): string {
  if (renderer.currentFocusedRenderable === alphaPanel) return "Alpha"
  if (renderer.currentFocusedRenderable === betaPanel) return "Beta"
  return "None"
}

function getFocusedColor(renderer: CliRenderer): string {
  if (renderer.currentFocusedRenderable === alphaPanel) return P.alpha
  if (renderer.currentFocusedRenderable === betaPanel) return P.beta
  return P.textMuted
}

function getMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function getActiveKeyLabel(activeKey: ReturnType<KeymapManager["getActiveKeys"]>[number]): string {
  const firstMetadata = activeKey.metadata?.[0]
  if (activeKey.continues) {
    const group = getMetadataText(firstMetadata?.bindingAttrs?.group)
    if (group) {
      return `+${group}`
    }
  }

  return (
    getMetadataText(firstMetadata?.bindingAttrs?.desc) ??
    getMetadataText(firstMetadata?.commandAttrs?.desc) ??
    getMetadataText(firstMetadata?.commandAttrs?.title) ??
    firstMetadata?.command.input ??
    activeKey.commands[0]?.input ??
    ""
  )
}

// -- styled text builders --------------------------------------------------

function styledLine(chunks: TextChunk[]): TextChunk[] {
  return chunks
}

function joinLines(lines: TextChunk[][]): StyledText {
  const allChunks: TextChunk[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) allChunks.push({ __isChunk: true, text: "\n" })
    for (const chunk of lines[i]) allChunks.push(chunk)
  }
  return new StyledText(allChunks)
}

function buildPanelContent(label: string, count: number, step: number, saveTarget: string, color: string): StyledText {
  return joinLines([
    styledLine([bold(fg(color)(`${label} Panel`))]),
    styledLine([fg(P.textDim)("Count: "), bold(fg(color)(String(count)))]),
    styledLine([bold(fg(P.key)("j")), fg(P.textDim)(` +${step}  `), bold(fg(P.key)("k")), fg(P.textDim)(` -${step}`)]),
    styledLine([bold(fg(P.key)("enter")), fg(P.textDim)(` :w ${saveTarget}`)]),
  ])
}

function buildWhichKeyEntries(): StyledText {
  if (!keymapManager) return joinLines([styledLine([fg(P.textMuted)("(unavailable)")])])

  const activeKeys = [...keymapManager.getActiveKeys({ includeMetadata: true })].sort((left, right) => {
    return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
      stringifyKeyStroke(right, { preferDisplay: true }),
    )
  })

  if (activeKeys.length === 0) return joinLines([styledLine([fg(P.textMuted)("(no active keys)")])])

  const lines: TextChunk[][] = []
  for (const activeKey of activeKeys.slice(0, 10)) {
    const keyStr = stringifyKeyStroke(activeKey, { preferDisplay: true })
    const label = getActiveKeyLabel(activeKey)
    lines.push(styledLine([bold(fg(P.key)(keyStr)), fg(P.textMuted)(" -> "), fg(P.command)(label)]))
  }
  return joinLines(lines)
}

function buildHelpContent(): StyledText {
  return joinLines([
    styledLine([bold(fg(P.textDim)("Keybindings"))]),
    styledLine([
      bold(fg(P.key)("tab")),
      fg(P.textMuted)(" / "),
      bold(fg(P.key)("shift+tab")),
      fg(P.textDim)(": move focus"),
    ]),
    styledLine([
      bold(fg(P.key)("?")),
      fg(P.textDim)(": toggle help"),
      fg(P.separator)(" | "),
      bold(fg(P.key)("ctrl+r")),
      fg(P.textDim)(": :reset"),
    ]),
    styledLine([bold(fg(P.key)("enter")), fg(P.textDim)(": :w alpha-panel.txt / beta-panel.txt")]),
    styledLine([
      bold(fg(P.key)("ctrl+x")),
      fg(P.textMuted)(" then "),
      bold(fg(P.key)("s")),
      fg(P.textDim)(": :w session.log"),
    ]),
    styledLine([
      bold(fg(P.key)("ctrl+x")),
      fg(P.textMuted)(" then "),
      bold(fg(P.key)("h")),
      fg(P.textDim)(": toggle help"),
    ]),
  ])
}

function buildExCommandsContent(): StyledText {
  return joinLines([
    styledLine([bold(fg(P.accent)("Ex commands"))]),
    styledLine([fg(P.key)(":reset"), fg(P.textMuted)(" / "), fg(P.key)(":r")]),
    styledLine([fg(P.key)(":write <file>"), fg(P.textMuted)(" / "), fg(P.key)(":w <file>")]),
  ])
}

// -- render functions ------------------------------------------------------

function renderPanels(): void {
  if (alphaText) alphaText.content = buildPanelContent("Alpha", alphaCount, 1, "alpha-panel.txt", P.alpha)
  if (betaText) betaText.content = buildPanelContent("Beta", betaCount, 5, "beta-panel.txt", P.beta)
}

function renderStatus(renderer: CliRenderer): void {
  const name = getFocusedPanelName(renderer)
  const color = getFocusedColor(renderer)

  if (statusFocusedText) {
    statusFocusedText.content = joinLines([styledLine([fg(P.textDim)("Focused: "), bold(fg(color)(name))])])
  }
  if (statusLeaderText) {
    statusLeaderText.content = leaderArmed
      ? joinLines([styledLine([fg(P.textDim)("Leader: "), bold(fg(P.leader)("armed (ctrl+x)"))])])
      : joinLines([styledLine([fg(P.textDim)("Leader: "), fg(P.textMuted)("idle")])])
  }
  if (statusLastText) {
    statusLastText.content = joinLines([styledLine([fg(P.textDim)("Last action: "), fg(P.text)(lastAction)])])
  }
  if (helpBox) helpBox.visible = helpVisible
  if (logBox) logBox.visible = logLines.length > 0
  if (logText && logLines.length > 0) {
    const lines: TextChunk[][] = [styledLine([bold(fg(P.textDim)("Log"))])]
    for (const logLine of logLines) lines.push(styledLine([fg(P.textMuted)(logLine)]))
    logText.content = joinLines(lines)
  }
  if (whichKeyHeaderText && keymapManager) {
    const prefix = stringifyKeySequence(keymapManager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
    whichKeyHeaderText.content = joinLines([
      styledLine([bold(fg(P.accent)("Which Key"))]),
      styledLine([fg(P.textDim)("Prefix: "), bold(fg(P.accent)(prefix))]),
    ])
  }
  if (whichKeyEntriesText) whichKeyEntriesText.content = buildWhichKeyEntries()
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
  if (panels.length === 0) return

  const currentIndex = panels.findIndex((panel) => panel === renderer.currentFocusedRenderable)
  const startIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = (startIndex + direction + panels.length) % panels.length
  panels[nextIndex]?.focus()
  setStatus(renderer, `Focused ${nextIndex === 0 ? "Alpha" : "Beta"} panel`)
}

// -- keymaps ---------------------------------------------------------------

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

// -- build UI tree ---------------------------------------------------------

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor(P.bg)

  alphaCount = 0
  betaCount = 0
  helpVisible = true
  leaderArmed = false
  lastAction = "Click a panel or press Tab to start."
  logLines = []

  root = new BoxRenderable(renderer, {
    id: "keymap-demo-root",
    flexDirection: "column",
    flexGrow: 1,
    padding: 1,
  })
  renderer.root.add(root)

  // -- title ---------------------------------------------------------------

  const title = new TextRenderable(renderer, {
    id: "keymap-demo-title",
    content: "Keymap Demo",
    fg: P.title,
    attributes: TextAttributes.BOLD,
    height: 1,
  })
  root.add(title)

  const subtitle = new TextRenderable(renderer, {
    id: "keymap-demo-subtitle",
    content:
      "Global layers, focused layers, which-key hints from metadata, ex commands, and a ctrl+x leader extension.",
    fg: P.textMuted,
    height: 2,
  })
  root.add(subtitle)

  // -- panels row ----------------------------------------------------------

  const panelsRow = new BoxRenderable(renderer, {
    id: "keymap-demo-panels",
    flexDirection: "row",
    gap: 1,
    height: 7,
  })
  root.add(panelsRow)

  alphaPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-alpha",
    border: true,
    borderStyle: "rounded",
    focusable: true,
    focusedBorderColor: P.alpha,
    borderColor: P.border,
    padding: 1,
    flexDirection: "column",
    flexGrow: 1,
    title: " Alpha ",
    titleAlignment: "left",
  })
  panelsRow.add(alphaPanel)

  alphaText = new TextRenderable(renderer, {
    id: "keymap-demo-alpha-text",
    content: "",
    fg: P.text,
  })
  alphaPanel.add(alphaText)

  betaPanel = new BoxRenderable(renderer, {
    id: "keymap-demo-beta",
    border: true,
    borderStyle: "rounded",
    focusable: true,
    focusedBorderColor: P.beta,
    borderColor: P.border,
    padding: 1,
    flexDirection: "column",
    flexGrow: 1,
    title: " Beta ",
    titleAlignment: "left",
  })
  panelsRow.add(betaPanel)

  betaText = new TextRenderable(renderer, {
    id: "keymap-demo-beta-text",
    content: "",
    fg: P.text,
  })
  betaPanel.add(betaText)

  // -- footer: status + which-key in one bordered box ----------------------

  const footer = new BoxRenderable(renderer, {
    id: "keymap-demo-footer",
    border: true,
    borderStyle: "rounded",
    borderColor: P.border,
    padding: 1,
    marginTop: 1,
    gap: 2,
    flexDirection: "row",
    flexGrow: 1,
  })
  root.add(footer)

  // -- details column (left) -----------------------------------------------

  const detailsColumn = new BoxRenderable(renderer, {
    id: "keymap-demo-details-column",
    flexGrow: 1,
    flexDirection: "column",
  })
  footer.add(detailsColumn)

  const statusGroup = new BoxRenderable(renderer, {
    id: "keymap-demo-status-group",
    flexDirection: "column",
    flexShrink: 0,
  })
  detailsColumn.add(statusGroup)

  statusFocusedText = new TextRenderable(renderer, {
    id: "keymap-demo-status-focused",
    content: "",
    fg: P.text,
    height: 1,
  })
  statusGroup.add(statusFocusedText)

  statusLeaderText = new TextRenderable(renderer, {
    id: "keymap-demo-status-leader",
    content: "",
    fg: P.text,
    height: 1,
  })
  statusGroup.add(statusLeaderText)

  statusLastText = new TextRenderable(renderer, {
    id: "keymap-demo-status-last",
    content: "",
    fg: P.text,
  })
  statusGroup.add(statusLastText)

  helpBox = new BoxRenderable(renderer, {
    id: "keymap-demo-help",
    flexDirection: "column",
    flexShrink: 0,
    marginTop: 1,
  })
  detailsColumn.add(helpBox)

  const helpText = new TextRenderable(renderer, {
    id: "keymap-demo-help-text",
    content: buildHelpContent(),
    fg: P.text,
  })
  helpBox.add(helpText)

  const detailsSpacer = new BoxRenderable(renderer, {
    id: "keymap-demo-details-spacer",
    flexGrow: 1,
  })
  detailsColumn.add(detailsSpacer)

  logBox = new BoxRenderable(renderer, {
    id: "keymap-demo-log",
    flexDirection: "column",
    flexShrink: 0,
  })
  detailsColumn.add(logBox)

  logText = new TextRenderable(renderer, {
    id: "keymap-demo-log-text",
    content: "",
    fg: P.text,
  })
  logBox.add(logText)

  // -- which-key column (right) --------------------------------------------

  const whichKeyColumn = new BoxRenderable(renderer, {
    id: "keymap-demo-which-key-column",
    width: 28,
    flexDirection: "column",
  })
  footer.add(whichKeyColumn)

  const wkHeaderGroup = new BoxRenderable(renderer, {
    id: "keymap-demo-wk-header",
    flexDirection: "column",
    flexShrink: 0,
  })
  whichKeyColumn.add(wkHeaderGroup)

  whichKeyHeaderText = new TextRenderable(renderer, {
    id: "keymap-demo-wk-header-text",
    content: "",
    fg: P.text,
  })
  wkHeaderGroup.add(whichKeyHeaderText)

  const wkEntriesGroup = new BoxRenderable(renderer, {
    id: "keymap-demo-wk-entries",
    flexDirection: "column",
    flexShrink: 0,
  })
  whichKeyColumn.add(wkEntriesGroup)

  whichKeyEntriesText = new TextRenderable(renderer, {
    id: "keymap-demo-wk-entries-text",
    content: "",
    fg: P.text,
  })
  wkEntriesGroup.add(whichKeyEntriesText)

  const wkSpacer = new BoxRenderable(renderer, {
    id: "keymap-demo-wk-spacer",
    flexGrow: 1,
  })
  whichKeyColumn.add(wkSpacer)

  const wkExGroup = new BoxRenderable(renderer, {
    id: "keymap-demo-wk-ex",
    flexDirection: "column",
    flexShrink: 0,
  })
  whichKeyColumn.add(wkExGroup)

  const wkExText = new TextRenderable(renderer, {
    id: "keymap-demo-wk-ex-text",
    content: buildExCommandsContent(),
    fg: P.text,
  })
  wkExGroup.add(wkExText)

  // -- event listeners -----------------------------------------------------

  alphaPanel.on(RenderableEvents.FOCUSED, () => renderStatus(renderer))
  alphaPanel.on(RenderableEvents.BLURRED, () => renderStatus(renderer))
  betaPanel.on(RenderableEvents.FOCUSED, () => renderStatus(renderer))
  betaPanel.on(RenderableEvents.BLURRED, () => renderStatus(renderer))

  // -- init ----------------------------------------------------------------

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
  statusFocusedText = null
  statusLeaderText = null
  statusLastText = null
  helpBox = null
  logBox = null
  logText = null
  whichKeyHeaderText = null
  whichKeyEntriesText = null
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
