import { ConsolePosition, TextAttributes, type Renderable } from "@opentui/core"
import {
  registerExCommands,
  registerMetadataFields,
  registerTimedLeader,
  stringifyKeySequence,
  stringifyKeyStroke,
  type KeymapActiveKey,
} from "@opentui/core/extras"
import { render, useActiveKeys, useKeymap, useKeymappings, usePendingSequenceParts, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"

// -- palette ---------------------------------------------------------------

const palette = {
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

type PanelId = "alpha" | "beta"

// -- small helpers ---------------------------------------------------------

function KeyLabel(props: { children: JSX.Element }) {
  return <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{props.children}</span>
}

function getMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

function getActiveKeyLabel(activeKey: KeymapActiveKey): string {
  if (activeKey.continues) {
    const group = getMetadataText(activeKey.bindingAttrs?.group)
    if (group) {
      return `+${group}`
    }
  }

  return (
    getMetadataText(activeKey.bindingAttrs?.desc) ??
    getMetadataText(activeKey.commandAttrs?.desc) ??
    getMetadataText(activeKey.commandAttrs?.title) ??
    (typeof activeKey.command === "string" ? activeKey.command : undefined) ??
    ""
  )
}

// -- CounterPanel ----------------------------------------------------------

function CounterPanel(props: {
  id: PanelId
  label: string
  saveTarget: string
  step: number
  color: string
  setRef?: (value: Renderable) => void
  count: Accessor<number>
  focused: Accessor<boolean>
  setFocused: (id: PanelId) => void
  setCount: (value: number) => void
  announce: (message: string) => void
}) {
  const manager = useKeymappings()
  const incrementCommand = `${props.id}.increment`
  const decrementCommand = `${props.id}.decrement`

  const offCommands = manager.registerCommands([
    {
      name: incrementCommand,
      title: `${props.label} +${props.step}`,
      desc: `${props.label} +${props.step}`,
      run() {
        const next = props.count() + props.step
        props.setCount(next)
        props.announce(`${props.label} increased to ${next}`)
      },
    },
    {
      name: decrementCommand,
      title: `${props.label} -${props.step}`,
      desc: `${props.label} -${props.step}`,
      run() {
        const next = props.count() - props.step
        props.setCount(next)
        props.announce(`${props.label} decreased to ${next}`)
      },
    },
  ])

  const keymapRef = useKeymap({
    scope: "focus-within",
    bindings: [
      { key: "j", cmd: incrementCommand, desc: `${props.label} +${props.step}` },
      { key: "k", cmd: decrementCommand, desc: `${props.label} -${props.step}` },
      { key: "enter", cmd: `:w ${props.saveTarget}`, desc: `Write ${props.label.toLowerCase()} panel` },
    ],
  })

  onCleanup(() => {
    offCommands()
  })

  return (
    <box
      ref={(value: Renderable) => {
        keymapRef(value)
        props.setRef?.(value)
      }}
      border
      focusable
      focused={props.focused()}
      borderColor={palette.border}
      focusedBorderColor={props.color}
      title={` ${props.label} `}
      titleAlignment="left"
      style={{
        borderStyle: "rounded",
        padding: 1,
        flexGrow: 1,
        flexDirection: "column",
      }}
      on:focused={() => props.setFocused(props.id)}
    >
      <text height={1}>
        <span style={{ fg: palette.textDim }}>Count: </span>
        <span style={{ fg: props.color, attributes: TextAttributes.BOLD }}>{String(props.count())}</span>
      </text>
      <box height={1} />
      <text height={1}>
        <KeyLabel>j</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` +${props.step}  `}</span>
        <KeyLabel>k</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` -${props.step}`}</span>
      </text>
      <text height={1}>
        <KeyLabel>enter</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` :w ${props.saveTarget}`}</span>
      </text>
    </box>
  )
}

// -- KeymapDemo (root) -----------------------------------------------------

export default function KeymapDemo() {
  const renderer = useRenderer()
  const manager = useKeymappings()
  let alphaPanelRef: Renderable | undefined

  const [activePanel, setActivePanel] = createSignal<PanelId>("alpha")
  const [alphaCount, setAlphaCount] = createSignal(0)
  const [betaCount, setBetaCount] = createSignal(0)
  const [helpVisible, setHelpVisible] = createSignal(true)
  const [leaderArmed, setLeaderArmed] = createSignal(false)
  const [lastAction, setLastAction] = createSignal("Press Tab to start.")
  const [logs, setLogs] = createSignal<string[]>([])
  const offMetadata = registerMetadataFields(manager)
  const activeKeys = useActiveKeys({ includeMetadata: true })
  const pendingSequenceParts = usePendingSequenceParts()

  const announce = (message: string) => {
    setLastAction(message)
    setLogs((current) => [message, ...current].slice(0, 6))
  }

  const setFocusedPanel = (id: PanelId) => {
    setActivePanel(id)
  }

  const focusPanel = (id: PanelId) => {
    setFocusedPanel(id)
    announce(`Focused ${id === "alpha" ? "Alpha" : "Beta"} panel`)
  }

  const moveFocus = (direction: 1 | -1) => {
    if (direction === 1) {
      focusPanel(activePanel() === "alpha" ? "beta" : "alpha")
      return
    }

    focusPanel(activePanel() === "beta" ? "alpha" : "beta")
  }

  const offActions = manager.registerCommands([
    {
      name: "focus-next",
      title: "Next panel",
      desc: "Next panel",
      run() {
        moveFocus(1)
      },
    },
    {
      name: "focus-prev",
      title: "Prev panel",
      desc: "Prev panel",
      run() {
        moveFocus(-1)
      },
    },
    {
      name: "toggle-help",
      title: "Toggle help",
      desc: "Toggle help",
      run() {
        setHelpVisible((value) => {
          const next = !value
          announce(next ? "Help shown" : "Help hidden")
          return next
        })
      },
    },
  ])

  const offEx = registerExCommands(manager, [
    {
      name: "reset",
      aliases: ["r"],
      nargs: "0",
      title: "Reset counters",
      desc: "Reset counters",
      run() {
        setAlphaCount(0)
        setBetaCount(0)
        announce("Counters reset through :reset")
      },
    },
    {
      name: "write",
      aliases: ["w"],
      nargs: "1",
      title: "Write file",
      desc: "Write file",
      run({ raw, args }) {
        announce(`Ex command: ${raw} -> wrote ${args[0]}`)
      },
    },
  ])

  const offLeader = registerTimedLeader(manager, {
    trigger: { name: "x", ctrl: true },
    onArm() {
      setLeaderArmed(true)
      setLastAction("Leader armed: press s or h")
    },
    onDisarm() {
      setLeaderArmed(false)
    },
  })

  useKeymap({
    scope: "global",
    bindings: [
      { key: "tab", cmd: "focus-next" },
      { key: "shift+tab", cmd: "focus-prev" },
      { key: "?", cmd: "toggle-help" },
      { key: "ctrl+r", cmd: ":reset" },
      { key: "<leader>", group: "Leader" },
      { key: "<leader>s", cmd: ":w session.log", desc: "Write session log", group: "Leader" },
      { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help", group: "Leader" },
    ],
  })

  // -- computed content -----------------------------------------------------

  const focusedName = createMemo(() => (activePanel() === "alpha" ? "Alpha" : "Beta"))
  const focusedColor = createMemo(() => (activePanel() === "alpha" ? palette.alpha : palette.beta))

  const whichKeyEntries = createMemo(() => {
    const sortedActiveKeys = [...activeKeys()].sort((left, right) => {
      return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
        stringifyKeyStroke(right, { preferDisplay: true }),
      )
    })

    return sortedActiveKeys.slice(0, 8).map((activeKey) => ({
      key: stringifyKeyStroke(activeKey, { preferDisplay: true }),
      commands: getActiveKeyLabel(activeKey),
    }))
  })

  const whichKeyPrefix = createMemo(() => {
    return stringifyKeySequence(pendingSequenceParts(), { preferDisplay: true }) || "<root>"
  })

  onMount(() => {
    renderer.setBackgroundColor(palette.bg)
    alphaPanelRef?.focus()
    announce("Focused Alpha panel")
  })

  onCleanup(() => {
    offLeader()
    offEx()
    offActions()
    offMetadata()
  })

  return (
    <box flexDirection="column" flexGrow={1} padding={1} backgroundColor={palette.bg}>
      {/* Header */}
      <text style={{ fg: palette.title, attributes: TextAttributes.BOLD }} height={1}>
        Keymap Demo
      </text>
      <text fg={palette.textMuted} height={2}>
        useKeymappings + useKeymap with global bindings, local panel bindings, which-key hints, and a ctrl+x leader
        extension.
      </text>

      {/* Counter panels */}
      <box flexDirection="row" gap={1} height={7}>
        <CounterPanel
          id="alpha"
          label="Alpha"
          saveTarget="alpha-panel.txt"
          step={1}
          color={palette.alpha}
          setRef={(value) => {
            alphaPanelRef = value
          }}
          count={alphaCount}
          focused={() => activePanel() === "alpha"}
          setFocused={setFocusedPanel}
          setCount={setAlphaCount}
          announce={announce}
        />
        <CounterPanel
          id="beta"
          label="Beta"
          saveTarget="beta-panel.txt"
          step={5}
          color={palette.beta}
          count={betaCount}
          focused={() => activePanel() === "beta"}
          setFocused={setFocusedPanel}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      {/* Footer: status + which-key in one bordered box */}
      <box
        border
        style={{
          borderStyle: "rounded",
          borderColor: palette.border,
          padding: 1,
          marginTop: 1,
          flexGrow: 1,
          flexDirection: "row",
          gap: 2,
        }}
      >
        {/* Details column — box layout, each section isolated so Show/For ordering is stable */}
        <box flexGrow={1} flexDirection="column">
          <box flexDirection="column" flexShrink={0}>
            <text height={1}>
              <span style={{ fg: palette.textDim }}>Focused: </span>
              <span style={{ fg: focusedColor(), attributes: TextAttributes.BOLD }}>{focusedName()}</span>
            </text>
            <text height={1}>
              <span style={{ fg: palette.textDim }}>Leader: </span>
              <Show when={leaderArmed()} fallback={<span style={{ fg: palette.textMuted }}>idle</span>}>
                <span style={{ fg: palette.leader, attributes: TextAttributes.BOLD }}>armed (ctrl+x)</span>
              </Show>
            </text>
            <text>
              <span style={{ fg: palette.textDim }}>Last action: </span>
              <span style={{ fg: palette.text }}>{lastAction()}</span>
            </text>
          </box>
          <Show when={helpVisible()}>
            <box flexDirection="column" flexShrink={0} marginTop={1}>
              <text style={{ fg: palette.textDim, attributes: TextAttributes.BOLD }} height={1}>
                Keybindings
              </text>
              <text height={1}>
                <KeyLabel>tab</KeyLabel>
                <span style={{ fg: palette.textMuted }}>{" / "}</span>
                <KeyLabel>shift+tab</KeyLabel>
                <span style={{ fg: palette.textDim }}>: move focus</span>
              </text>
              <text height={1}>
                <KeyLabel>?</KeyLabel>
                <span style={{ fg: palette.textDim }}>: toggle help</span>
                <span style={{ fg: palette.separator }}>{" | "}</span>
                <KeyLabel>ctrl+r</KeyLabel>
                <span style={{ fg: palette.textDim }}>: :reset</span>
              </text>
              <text height={1}>
                <KeyLabel>enter</KeyLabel>
                <span style={{ fg: palette.textDim }}>: :w alpha-panel.txt / beta-panel.txt</span>
              </text>
              <text height={1}>
                <KeyLabel>ctrl+x</KeyLabel>
                <span style={{ fg: palette.textMuted }}>{" then "}</span>
                <KeyLabel>s</KeyLabel>
                <span style={{ fg: palette.textDim }}>: :w session.log</span>
              </text>
              <text height={1}>
                <KeyLabel>ctrl+x</KeyLabel>
                <span style={{ fg: palette.textMuted }}>{" then "}</span>
                <KeyLabel>h</KeyLabel>
                <span style={{ fg: palette.textDim }}>: toggle help</span>
              </text>
            </box>
          </Show>
          <box flexGrow={1} />
          <Show when={logs().length > 0}>
            <box flexDirection="column" flexShrink={0}>
              <text style={{ fg: palette.textDim, attributes: TextAttributes.BOLD }} height={1}>
                Log:
              </text>
              <box flexDirection="column">
                <For each={logs().slice(0, 4)}>
                  {(log) => (
                    <text fg={palette.textMuted} height={1} truncate>
                      {log}
                    </text>
                  )}
                </For>
              </box>
            </box>
          </Show>
        </box>

        {/* Which-key column — each group in its own box so <For> is never mixed with static siblings */}
        <box width={28} flexDirection="column">
          <box flexDirection="column" flexShrink={0}>
            <text style={{ fg: palette.accent, attributes: TextAttributes.BOLD }} height={1}>
              Which Key
            </text>
            <text height={1}>
              <span style={{ fg: palette.textDim }}>Prefix: </span>
              <span style={{ fg: palette.accent, attributes: TextAttributes.BOLD }}>{whichKeyPrefix()}</span>
            </text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <For each={whichKeyEntries()}>
              {(entry) => (
                <text height={1}>
                  <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{entry.key}</span>
                  <span style={{ fg: palette.textMuted }}>{" -> "}</span>
                  <span style={{ fg: palette.command }}>{entry.commands}</span>
                </text>
              )}
            </For>
          </box>
          <box flexGrow={1} />
          <box flexDirection="column" flexShrink={0}>
            <text style={{ fg: palette.accent, attributes: TextAttributes.BOLD }} height={1}>
              Ex commands
            </text>
            <text height={1}>
              <span style={{ fg: palette.key }}>{":reset"}</span>
              <span style={{ fg: palette.textMuted }}>{" / "}</span>
              <span style={{ fg: palette.key }}>{":r"}</span>
            </text>
            <text height={1}>
              <span style={{ fg: palette.key }}>{":write <file>"}</span>
              <span style={{ fg: palette.textMuted }}>{" / "}</span>
              <span style={{ fg: palette.key }}>{":w <file>"}</span>
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

if (import.meta.main) {
  render(KeymapDemo, {
    exitOnCtrlC: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      maxStoredLogs: 1000,
      sizePercent: 40,
    },
  })
}
