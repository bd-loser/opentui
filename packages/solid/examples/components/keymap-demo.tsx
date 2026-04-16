import {
  CliRenderEvents,
  ConsolePosition,
  TextAttributes,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core"
import {
  registerEnabledField,
  registerExCommands,
  registerManagedTextareaLayer,
  registerMetadataFields,
  registerTimedLeader,
  stringifyKeySequence,
  stringifyKeyStroke,
  type KeymapActiveKey,
} from "@opentui/core/extras"
import { render, useActiveKeys, useKeymap, useKeymappings, usePendingSequenceParts, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"

const palette = {
  bg: "#0f172a",
  surface: "#1e293b",
  surfaceFocus: "#24324d",
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
type EditorId = "notes" | "draft" | "scratch"

interface EditorSpec {
  id: EditorId
  label: string
  color: string
  initialValue?: string
  placeholder?: string
}

const editorSpecs: readonly EditorSpec[] = [
  {
    id: "notes",
    label: "Notes",
    color: palette.alpha,
    initialValue: "Notes editor\nTab/Shift+Tab switches focus.",
  },
  {
    id: "draft",
    label: "Draft",
    color: palette.beta,
    initialValue: "Draft editor\nPress dd here to delete the current line.",
  },
  {
    id: "scratch",
    label: "Scratch",
    color: palette.accent,
    placeholder: "Scratch editor. Unmapped text still inserts directly.",
  },
] as const

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
  setCount: (value: number) => void
  announce: (message: string) => void
}) {
  const manager = useKeymappings()
  const incrementCommand = `${props.id}-up`
  const decrementCommand = `${props.id}-down`

  const offCommands = manager.registerCommands([
    {
      name: incrementCommand,
      title: `${props.label} +${props.step}`,
      desc: `${props.label} +${props.step}`,
      category: props.label,
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
      category: props.label,
      run() {
        const next = props.count() - props.step
        props.setCount(next)
        props.announce(`${props.label} decreased to ${next}`)
      },
    },
  ])

  const keymapRef = useKeymap({
    bindings: [
      { key: "j", cmd: incrementCommand, desc: `${props.label} +${props.step}` },
      { key: "k", cmd: decrementCommand, desc: `${props.label} -${props.step}` },
      { key: "return", cmd: `:w ${props.saveTarget}`, desc: `Write ${props.label.toLowerCase()} panel` },
    ],
  })

  onCleanup(() => {
    offCommands()
  })

  return (
    <box
      id={`keymap-demo-${props.id}`}
      ref={(value: Renderable) => {
        keymapRef(value)
        props.setRef?.(value)
      }}
      border
      borderStyle="rounded"
      focusable
      borderColor={palette.border}
      focusedBorderColor={props.color}
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      title={` ${props.label} `}
      titleAlignment="left"
    >
      <text height={1}>
        <span style={{ fg: palette.textDim }}>Count: </span>
        <span style={{ fg: props.color, attributes: TextAttributes.BOLD }}>{String(props.count())}</span>
      </text>
      <text height={1}>
        <KeyLabel>j</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` +${props.step}  `}</span>
        <KeyLabel>k</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` -${props.step}`}</span>
        <span style={{ fg: palette.separator }}>{"  |  "}</span>
        <KeyLabel>enter</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` save ${props.label.toLowerCase()}`}</span>
      </text>
    </box>
  )
}

// -- KeymapDemo (root) -----------------------------------------------------

export default function KeymapDemo() {
  const renderer = useRenderer()
  const manager = useKeymappings()
  let alphaPanelRef: Renderable | undefined
  let betaPanelRef: Renderable | undefined
  const editorRefs: Array<TextareaRenderable | undefined> = []

  const [alphaCount, setAlphaCount] = createSignal(0)
  const [betaCount, setBetaCount] = createSignal(0)
  const [helpVisible, setHelpVisible] = createSignal(true)
  const [leaderArmed, setLeaderArmed] = createSignal(false)
  const [lastAction, setLastAction] = createSignal("Click a panel or press Tab to start.")
  const [logs, setLogs] = createSignal<string[]>([])
  const [statusVersion, setStatusVersion] = createSignal(0)

  const offEnabled = registerEnabledField(manager)
  const offMetadata = registerMetadataFields(manager)
  const activeKeys = useActiveKeys({ includeMetadata: true })
  const pendingSequenceParts = usePendingSequenceParts()

  const bumpStatus = () => {
    setStatusVersion((value) => value + 1)
  }

  const addLog = (message: string) => {
    setLogs((current) => {
      if (current[0] === message) {
        return current
      }

      return [message, ...current].slice(0, 8)
    })
  }

  const announce = (message: string) => {
    setLastAction(message)
    addLog(message)
  }

  const getFocusableTargets = (): Renderable[] => {
    return [alphaPanelRef, betaPanelRef, ...editorRefs].filter((target): target is Renderable => target !== undefined)
  }

  const getFocusableLabel = (target: Renderable): string => {
    if (target === alphaPanelRef) {
      return "Alpha panel"
    }

    if (target === betaPanelRef) {
      return "Beta panel"
    }

    const editorIndex = editorRefs.findIndex((editor) => editor === target)
    if (editorIndex !== -1) {
      return `${editorSpecs[editorIndex]!.label} editor`
    }

    return "target"
  }

  const moveFocus = (direction: 1 | -1) => {
    const targets = getFocusableTargets()
    if (targets.length === 0) {
      return
    }

    const currentIndex = targets.findIndex((target) => target === renderer.currentFocusedRenderable)
    const startIndex = currentIndex === -1 ? 0 : currentIndex
    const nextIndex = (startIndex + direction + targets.length) % targets.length
    const target = targets[nextIndex]
    if (!target) {
      return
    }

    target.focus()
    announce(`Focused ${getFocusableLabel(target)}`)
  }

  const offActions = manager.registerCommands([
    {
      name: "focus-next",
      title: "Next target",
      desc: "Next target",
      category: "Navigation",
      run() {
        moveFocus(1)
      },
    },
    {
      name: "focus-prev",
      title: "Previous target",
      desc: "Previous target",
      category: "Navigation",
      run() {
        moveFocus(-1)
      },
    },
    {
      name: "toggle-help",
      title: "Toggle help",
      desc: "Toggle help",
      category: "View",
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
      category: "Session",
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
      category: "File",
      run({ args }) {
        announce(`Wrote ${args[0]}`)
      },
    },
  ])

  const offLeader = registerTimedLeader(manager, {
    trigger: { name: "x", ctrl: true },
    onArm() {
      setLeaderArmed(true)
      announce("Leader armed: press s or h")
    },
    onDisarm() {
      setLeaderArmed(false)
    },
  })

  const offManagedTextareas = registerManagedTextareaLayer(manager, {
    scope: "global",
    enabled: () => manager.renderer.currentFocusedEditor !== null,
    bindings: [
      { key: "left", cmd: "move-left", desc: "Cursor left" },
      { key: "right", cmd: "move-right", desc: "Cursor right" },
      { key: "up", cmd: "move-up", desc: "Cursor up" },
      { key: "down", cmd: "move-down", desc: "Cursor down" },
      { key: "backspace", cmd: "backspace", desc: "Delete backward" },
      { key: "delete", cmd: "delete", desc: "Delete forward" },
      { key: "return", cmd: "newline", desc: "New line" },
      { key: "ctrl+a", cmd: "line-home", desc: "Line start" },
      { key: "ctrl+e", cmd: "line-end", desc: "Line end" },
      { key: "d", group: "Delete" },
      { key: "dd", cmd: "delete-line", desc: "Delete line" },
    ],
  })

  useKeymap({
    scope: "global",
    bindings: [
      { key: "tab", cmd: "focus-next", desc: "Next target" },
      { key: "shift+tab", cmd: "focus-prev", desc: "Previous target" },
      { key: "?", cmd: "toggle-help", desc: "Toggle help" },
      { key: "ctrl+r", cmd: ":reset", desc: "Reset counters" },
      { key: "<leader>", group: "Leader" },
      { key: "<leader>s", cmd: ":w session.log", desc: "Write session log", group: "Leader" },
      { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help", group: "Leader" },
    ],
  })

  const focusedEditorIndex = createMemo(() => {
    statusVersion()
    return editorRefs.findIndex((editor) => editor === renderer.currentFocusedEditor)
  })

  const focusedLabel = createMemo(() => {
    statusVersion()

    if (renderer.currentFocusedRenderable === alphaPanelRef) {
      return "Alpha panel"
    }

    if (renderer.currentFocusedRenderable === betaPanelRef) {
      return "Beta panel"
    }

    const editorIndex = focusedEditorIndex()
    if (editorIndex !== -1) {
      return `${editorSpecs[editorIndex]!.label} editor`
    }

    return "None"
  })

  const focusedColor = createMemo(() => {
    statusVersion()

    if (renderer.currentFocusedRenderable === alphaPanelRef) {
      return palette.alpha
    }

    if (renderer.currentFocusedRenderable === betaPanelRef) {
      return palette.beta
    }

    const editorIndex = focusedEditorIndex()
    if (editorIndex !== -1) {
      return editorSpecs[editorIndex]!.color
    }

    return palette.textMuted
  })

  const focusedEditor = createMemo(() => {
    statusVersion()
    return renderer.currentFocusedEditor
  })

  const whichKeyEntries = createMemo(() => {
    const sortedActiveKeys = [...activeKeys()].sort((left, right) => {
      return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
        stringifyKeyStroke(right, { preferDisplay: true }),
      )
    })

    return sortedActiveKeys.map((activeKey) => ({
      key: stringifyKeyStroke(activeKey, { preferDisplay: true }),
      command: getActiveKeyLabel(activeKey),
    }))
  })

  const whichKeyPrefix = createMemo(() => {
    return stringifyKeySequence(pendingSequenceParts(), { preferDisplay: true }) || "<root>"
  })

  const onFocusedRenderable = () => {
    bumpStatus()
  }

  const onFocusedEditor = () => {
    bumpStatus()
  }

  onMount(() => {
    renderer.setBackgroundColor(palette.bg)
    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
    renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    addLog("Tab switches focus across panels and editors.")
    addLog("ctrl+x arms the leader extension.")
    alphaPanelRef?.focus()
    announce("Focused Alpha panel")
  })

  onCleanup(() => {
    renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
    renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    offManagedTextareas()
    offLeader()
    offEx()
    offActions()
    offMetadata()
    offEnabled()
  })

  return (
    <box id="keymap-demo-root" flexDirection="column" flexGrow={1} padding={1} backgroundColor={palette.bg}>
      <text id="keymap-demo-title" style={{ fg: palette.title, attributes: TextAttributes.BOLD }} height={1}>
        Keymap Demo
      </text>
      <text id="keymap-demo-subtitle" fg={palette.textMuted} height={1}>
        Original Alpha/Beta panels plus three switchable textareas.
      </text>

      <box id="keymap-demo-panels" flexDirection="row" gap={1} height={4}>
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
          setCount={setAlphaCount}
          announce={announce}
        />
        <CounterPanel
          id="beta"
          label="Beta"
          saveTarget="beta-panel.txt"
          step={5}
          color={palette.beta}
          setRef={(value) => {
            betaPanelRef = value
          }}
          count={betaCount}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      <box id="keymap-demo-editors" flexDirection="row" gap={1} height={5}>
        <For each={editorSpecs}>
          {(spec, index) => (
            <box
              id={`keymap-demo-editor-frame-${spec.id}`}
              border
              borderStyle="rounded"
              borderColor={focusedEditorIndex() === index() ? spec.color : palette.border}
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              minWidth={0}
              title={` ${index() + 1}. ${spec.label}${focusedEditorIndex() === index() ? " *" : ""} `}
              titleAlignment="left"
            >
              <textarea
                id={`keymap-demo-editor-${index() + 1}`}
                ref={(value: TextareaRenderable) => {
                  editorRefs[index()] = value
                }}
                width="100%"
                height="100%"
                initialValue={spec.initialValue}
                placeholder={spec.placeholder ?? null}
                backgroundColor={palette.surface}
                focusedBackgroundColor={palette.surfaceFocus}
                textColor={palette.text}
                focusedTextColor={palette.title}
                placeholderColor={palette.textMuted}
                selectionBg="#264F78"
                selectionFg="#FFFFFF"
                wrapMode="word"
                onContentChange={() => {
                  bumpStatus()
                }}
                onCursorChange={() => {
                  bumpStatus()
                }}
              />
            </box>
          )}
        </For>
      </box>

      <box
        id="keymap-demo-footer"
        border
        borderStyle="rounded"
        borderColor={palette.border}
        paddingX={1}
        gap={2}
        flexDirection="row"
        flexGrow={1}
        minHeight={4}
      >
        <box id="keymap-demo-details-column" flexGrow={1} minWidth={0} flexDirection="column">
          <text id="keymap-demo-status-focused" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Focused: </span>
            <span style={{ fg: focusedColor(), attributes: TextAttributes.BOLD }}>{focusedLabel()}</span>
          </text>

          <text id="keymap-demo-status-info" fg={palette.text} height={1}>
            <Show
              when={focusedEditor()}
              fallback={
                <>
                  <span style={{ fg: palette.textDim }}>Alpha: </span>
                  <span style={{ fg: palette.text }}>{String(alphaCount())}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Beta: </span>
                  <span style={{ fg: palette.text }}>{String(betaCount())}</span>
                </>
              }
            >
              {(editor) => (
                <>
                  <span style={{ fg: palette.textDim }}>Cursor: </span>
                  <span
                    style={{ fg: palette.text }}
                  >{`${editor().logicalCursor.row + 1}:${editor().logicalCursor.col + 1}`}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Lines: </span>
                  <span style={{ fg: palette.text }}>{String(editor().lineCount)}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Chars: </span>
                  <span style={{ fg: palette.text }}>{String(editor().plainText.length)}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Keys: </span>
                  <span style={{ fg: palette.command }}>{editor().traits.suspend === true ? "keymap" : "local"}</span>
                </>
              )}
            </Show>
          </text>

          <text id="keymap-demo-status-leader" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Leader: </span>
            <Show when={leaderArmed()} fallback={<span style={{ fg: palette.textMuted }}>idle</span>}>
              <span style={{ fg: palette.leader, attributes: TextAttributes.BOLD }}>armed (ctrl+x)</span>
            </Show>
          </text>

          <text id="keymap-demo-status-last" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Last: </span>
            <span style={{ fg: palette.text }}>{lastAction()}</span>
          </text>

          <box id="keymap-demo-help" flexDirection="column" marginTop={1} visible={helpVisible()}>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>tab</span>
              <span style={{ fg: palette.textMuted }}>{" / "}</span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>shift+tab</span>
              <span style={{ fg: palette.textDim }}>: switch panels and editors</span>
            </text>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.textDim }}>
                Panels use local j/k/enter. Focused textareas route default shortcuts through keymap; plain typing still
                inserts directly.
              </span>
            </text>
          </box>

          <box id="keymap-demo-log" flexDirection="column" marginTop={1}>
            <text style={{ fg: palette.textDim, attributes: TextAttributes.BOLD }} height={1}>
              Log
            </text>
            <Show when={logs().length > 0} fallback={<text fg={palette.textMuted}>(no events yet)</text>}>
              <For each={logs()}>{(entry) => <text fg={palette.textMuted}>{entry}</text>}</For>
            </Show>
          </box>
        </box>

        <box
          id="keymap-demo-which-key-column"
          width="40%"
          minWidth={30}
          maxWidth={48}
          flexShrink={0}
          flexDirection="column"
        >
          <text id="keymap-demo-wk-header-text" fg={palette.text} height={1}>
            <span style={{ fg: palette.accent, attributes: TextAttributes.BOLD }}>Which Key</span>
            <span style={{ fg: palette.textDim }}>{`  ${whichKeyPrefix()}`}</span>
          </text>

          <scrollbox
            id="keymap-demo-wk-scrollbox"
            flexGrow={1}
            flexShrink={1}
            contentOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{ visible: true }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            <Show when={whichKeyEntries().length > 0} fallback={<text fg={palette.textMuted}>(no active keys)</text>}>
              <For each={whichKeyEntries()}>
                {(entry) => (
                  <text fg={palette.text} width="100%" wrapMode="word">
                    <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{entry.key}</span>
                    <span style={{ fg: palette.textMuted }}>{" -> "}</span>
                    <span style={{ fg: palette.command }}>{entry.command}</span>
                  </text>
                )}
              </For>
            </Show>
          </scrollbox>
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
