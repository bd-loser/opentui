import { CliRenderEvents, createCliRenderer, TextAttributes, type Renderable, type TextareaRenderable } from "@opentui/core"
import {
  registerEnabledField,
  registerExCommands,
  registerManagedTextareaLayer,
  registerMetadataFields,
  registerTimedLeader,
  stringifyKeySequence,
  stringifyKeyStroke,
  type KeymapActiveKey,
  type KeymapBindingInput,
  type KeymapCommand,
} from "@opentui/core/extras"
import { createRoot, useActiveKeys, useKeymap, useKeymappings, usePendingSequenceParts, useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"

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
  leader: "#fb923c",
  key: "#fbbf24",
  command: "#67e8f9",
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

function KeyLabel({ children }: { children: ReactNode }) {
  return <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{children}</span>
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

function CounterPanel(props: {
  id: PanelId
  label: string
  saveTarget: string
  step: number
  color: string
  count: number
  setRef?: (value: Renderable | null) => void
  setCount: Dispatch<SetStateAction<number>>
  announce: (message: string) => void
}) {
  const manager = useKeymappings()

  const incrementCommand = useMemo(() => `${props.id}-up`, [props.id])
  const decrementCommand = useMemo(() => `${props.id}-down`, [props.id])

  const commands = useMemo<KeymapCommand[]>(
    () => [
      {
        name: incrementCommand,
        title: `${props.label} +${props.step}`,
        desc: `${props.label} +${props.step}`,
        category: props.label,
        run() {
          props.setCount((value) => {
            const next = value + props.step
            props.announce(`${props.label} increased to ${next}`)
            return next
          })
        },
      },
      {
        name: decrementCommand,
        title: `${props.label} -${props.step}`,
        desc: `${props.label} -${props.step}`,
        category: props.label,
        run() {
          props.setCount((value) => {
            const next = value - props.step
            props.announce(`${props.label} decreased to ${next}`)
            return next
          })
        },
      },
    ],
    [decrementCommand, incrementCommand, props.announce, props.label, props.setCount, props.step],
  )

  useEffect(() => {
    return manager.registerCommands(commands)
  }, [commands, manager])

  const layer = useMemo(
    () => ({
      bindings: [
        { key: "j", cmd: incrementCommand, desc: `${props.label} +${props.step}` },
        { key: "k", cmd: decrementCommand, desc: `${props.label} -${props.step}` },
        { key: "return", cmd: `:w ${props.saveTarget}`, desc: `Write ${props.label.toLowerCase()} panel` },
      ] satisfies KeymapBindingInput[],
    }),
    [decrementCommand, incrementCommand, props.label, props.saveTarget, props.step],
  )

  const keymapRef = useKeymap(layer)
  const combinedRef = useCallback(
    (value: Renderable | null) => {
      keymapRef(value)
      props.setRef?.(value)
    },
    [keymapRef, props.setRef],
  )

  return (
    <box
      id={`keymap-demo-${props.id}`}
      ref={combinedRef}
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
        <span style={{ fg: props.color, attributes: TextAttributes.BOLD }}>{String(props.count)}</span>
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

export const App = () => {
  const renderer = useRenderer()
  const manager = useKeymappings()

  const alphaPanelRef = useRef<Renderable | null>(null)
  const betaPanelRef = useRef<Renderable | null>(null)
  const editorRefs = useRef<Array<TextareaRenderable | undefined>>([])

  const [alphaCount, setAlphaCount] = useState(0)
  const [betaCount, setBetaCount] = useState(0)
  const [helpVisible, setHelpVisible] = useState(true)
  const [leaderArmed, setLeaderArmed] = useState(false)
  const [lastAction, setLastAction] = useState("Click a panel or press Tab to start.")
  const [logs, setLogs] = useState<string[]>([])
  const [statusVersion, setStatusVersion] = useState(0)

  const bumpStatus = useCallback(() => {
    setStatusVersion((value) => value + 1)
  }, [])

  const addLog = useCallback((message: string) => {
    setLogs((current) => {
      if (current[0] === message) {
        return current
      }

      return [message, ...current].slice(0, 8)
    })
  }, [])

  const announce = useCallback(
    (message: string) => {
      setLastAction(message)
      addLog(message)
    },
    [addLog],
  )

  const setAlphaPanelRef = useCallback((value: Renderable | null) => {
    alphaPanelRef.current = value
  }, [])

  const setBetaPanelRef = useCallback((value: Renderable | null) => {
    betaPanelRef.current = value
  }, [])

  const editorRefCallbacks = useMemo(
    () =>
      editorSpecs.map((_, index) => {
        return (value: TextareaRenderable | null) => {
          editorRefs.current[index] = value ?? undefined
        }
      }),
    [],
  )

  const getFocusableTargets = useCallback((): Renderable[] => {
    return [alphaPanelRef.current, betaPanelRef.current, ...editorRefs.current].filter(
      (target): target is Renderable => target !== null && target !== undefined,
    )
  }, [])

  const getFocusableLabel = useCallback((target: Renderable): string => {
    if (target === alphaPanelRef.current) {
      return "Alpha panel"
    }

    if (target === betaPanelRef.current) {
      return "Beta panel"
    }

    const editorIndex = editorRefs.current.findIndex((editor) => editor === target)
    if (editorIndex !== -1) {
      return `${editorSpecs[editorIndex]!.label} editor`
    }

    return "target"
  }, [])

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
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
    },
    [announce, getFocusableLabel, getFocusableTargets, renderer],
  )

  useEffect(() => {
    const offEnabled = registerEnabledField(manager)
    const offMetadata = registerMetadataFields(manager)

    return () => {
      offMetadata()
      offEnabled()
    }
  }, [manager])

  const actions = useMemo<KeymapCommand[]>(
    () => [
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
    ],
    [announce, moveFocus],
  )

  useEffect(() => {
    return manager.registerCommands(actions)
  }, [actions, manager])

  const exCommands = useMemo<KeymapCommand[]>(
    () => [
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
    ],
    [announce],
  )

  useEffect(() => {
    return registerExCommands(manager, exCommands)
  }, [exCommands, manager])

  useEffect(() => {
    return registerTimedLeader(manager, {
      trigger: { name: "x", ctrl: true },
      onArm() {
        setLeaderArmed(true)
        announce("Leader armed: press s or h")
      },
      onDisarm() {
        setLeaderArmed(false)
      },
    })
  }, [announce, manager])

  const managedTextareaLayer = useMemo(
    () => ({
      scope: "global" as const,
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
      ] satisfies KeymapBindingInput[],
    }),
    [manager.renderer],
  )

  useEffect(() => {
    return registerManagedTextareaLayer(manager, managedTextareaLayer)
  }, [managedTextareaLayer, manager])

  const globalLayer = useMemo(
    () => ({
      scope: "global" as const,
      bindings: [
        { key: "tab", cmd: "focus-next", desc: "Next target" },
        { key: "shift+tab", cmd: "focus-prev", desc: "Previous target" },
        { key: "?", cmd: "toggle-help", desc: "Toggle help" },
        { key: "ctrl+r", cmd: ":reset", desc: "Reset counters" },
        { key: "<leader>", group: "Leader" },
        { key: "<leader>s", cmd: ":w session.log", desc: "Write session log", group: "Leader" },
        { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help", group: "Leader" },
      ] satisfies KeymapBindingInput[],
    }),
    [],
  )

  useKeymap(globalLayer)

  const activeKeys = useActiveKeys({ includeMetadata: true })
  const pendingSequenceParts = usePendingSequenceParts()

  const focusedEditorIndex = useMemo(() => {
    void statusVersion
    return editorRefs.current.findIndex((editor) => editor === renderer.currentFocusedEditor)
  }, [renderer, statusVersion])

  const focusedLabel = useMemo(() => {
    void statusVersion

    if (renderer.currentFocusedRenderable === alphaPanelRef.current) {
      return "Alpha panel"
    }

    if (renderer.currentFocusedRenderable === betaPanelRef.current) {
      return "Beta panel"
    }

    if (focusedEditorIndex !== -1) {
      return `${editorSpecs[focusedEditorIndex]!.label} editor`
    }

    return "None"
  }, [focusedEditorIndex, renderer, statusVersion])

  const focusedColor = useMemo(() => {
    void statusVersion

    if (renderer.currentFocusedRenderable === alphaPanelRef.current) {
      return palette.alpha
    }

    if (renderer.currentFocusedRenderable === betaPanelRef.current) {
      return palette.beta
    }

    if (focusedEditorIndex !== -1) {
      return editorSpecs[focusedEditorIndex]!.color
    }

    return palette.textMuted
  }, [focusedEditorIndex, renderer, statusVersion])

  const focusedEditor = useMemo(() => {
    void statusVersion
    return renderer.currentFocusedEditor
  }, [renderer, statusVersion])

  const whichKeyEntries = useMemo(() => {
    const sortedActiveKeys = [...activeKeys].sort((left, right) => {
      return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
        stringifyKeyStroke(right, { preferDisplay: true }),
      )
    })

    return sortedActiveKeys.map((activeKey) => ({
      key: stringifyKeyStroke(activeKey, { preferDisplay: true }),
      command: getActiveKeyLabel(activeKey),
    }))
  }, [activeKeys])

  const whichKeyPrefix = useMemo(() => {
    return stringifyKeySequence(pendingSequenceParts, { preferDisplay: true }) || "<root>"
  }, [pendingSequenceParts])

  useEffect(() => {
    const onFocusedRenderable = () => {
      bumpStatus()
    }

    const onFocusedEditor = () => {
      bumpStatus()
    }

    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
    renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)

    return () => {
      renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
      renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    }
  }, [bumpStatus, renderer])

  useEffect(() => {
    renderer.setBackgroundColor(palette.bg)
    addLog("Tab switches focus across panels and editors.")
    addLog("ctrl+x arms the leader extension.")
    alphaPanelRef.current?.focus()
    announce("Focused Alpha panel")
  }, [addLog, announce, renderer])

  return (
    <box id="keymap-demo-root" flexDirection="column" flexGrow={1} padding={1} backgroundColor={palette.bg}>
      <text id="keymap-demo-title" style={{ fg: palette.title, attributes: TextAttributes.BOLD }} height={1}>
        Keymap Demo
      </text>
      <text id="keymap-demo-subtitle" fg={palette.textMuted} height={1}>
        Original Alpha/Beta panels plus three switchable textareas.
      </text>

      <box id="keymap-demo-panels" flexDirection="row" gap={1} height={4} marginTop={1}>
        <CounterPanel
          id="alpha"
          label="Alpha"
          saveTarget="alpha-panel.txt"
          step={1}
          color={palette.alpha}
          setRef={setAlphaPanelRef}
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
          setRef={setBetaPanelRef}
          count={betaCount}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      <box id="keymap-demo-editors" flexDirection="row" gap={1} height={5} marginTop={1}>
        {editorSpecs.map((spec, index) => {
          return (
            <box
              key={spec.id}
              id={`keymap-demo-editor-frame-${spec.id}`}
              border
              borderStyle="rounded"
              borderColor={focusedEditorIndex === index ? spec.color : palette.border}
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              minWidth={0}
              title={` ${index + 1}. ${spec.label}${focusedEditorIndex === index ? " *" : ""} `}
              titleAlignment="left"
            >
              <textarea
                id={`keymap-demo-editor-${index + 1}`}
                ref={editorRefCallbacks[index]}
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
                onContentChange={bumpStatus}
                onCursorChange={bumpStatus}
              />
            </box>
          )
        })}
      </box>

      <box
        id="keymap-demo-footer"
        border
        borderStyle="rounded"
        borderColor={palette.border}
        paddingX={1}
        marginTop={1}
        gap={2}
        flexDirection="row"
        flexGrow={1}
        minHeight={4}
      >
        <box id="keymap-demo-details-column" flexGrow={1} minWidth={0} flexDirection="column">
          <text id="keymap-demo-status-focused" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Focused: </span>
            <span style={{ fg: focusedColor, attributes: TextAttributes.BOLD }}>{focusedLabel}</span>
          </text>

          <text id="keymap-demo-status-info" fg={palette.text} height={1}>
            {focusedEditor ? (
              <>
                <span style={{ fg: palette.textDim }}>Cursor: </span>
                <span style={{ fg: palette.text }}>{`${focusedEditor.logicalCursor.row + 1}:${focusedEditor.logicalCursor.col + 1}`}</span>
                <span style={{ fg: palette.separator }}>{"  |  "}</span>
                <span style={{ fg: palette.textDim }}>Lines: </span>
                <span style={{ fg: palette.text }}>{String(focusedEditor.lineCount)}</span>
                <span style={{ fg: palette.separator }}>{"  |  "}</span>
                <span style={{ fg: palette.textDim }}>Chars: </span>
                <span style={{ fg: palette.text }}>{String(focusedEditor.plainText.length)}</span>
                <span style={{ fg: palette.separator }}>{"  |  "}</span>
                <span style={{ fg: palette.textDim }}>Keys: </span>
                <span style={{ fg: palette.command }}>{focusedEditor.traits.suspend === true ? "keymap" : "local"}</span>
              </>
            ) : (
              <>
                <span style={{ fg: palette.textDim }}>Alpha: </span>
                <span style={{ fg: palette.text }}>{String(alphaCount)}</span>
                <span style={{ fg: palette.separator }}>{"  |  "}</span>
                <span style={{ fg: palette.textDim }}>Beta: </span>
                <span style={{ fg: palette.text }}>{String(betaCount)}</span>
              </>
            )}
          </text>

          <text id="keymap-demo-status-leader" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Leader: </span>
            {leaderArmed ? (
              <span style={{ fg: palette.leader, attributes: TextAttributes.BOLD }}>armed (ctrl+x)</span>
            ) : (
              <span style={{ fg: palette.textMuted }}>idle</span>
            )}
          </text>

          <text id="keymap-demo-status-last" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Last: </span>
            <span style={{ fg: palette.text }}>{lastAction}</span>
          </text>

          <box id="keymap-demo-help" flexDirection="column" marginTop={1} visible={helpVisible}>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>tab</span>
              <span style={{ fg: palette.textMuted }}>{" / "}</span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>shift+tab</span>
              <span style={{ fg: palette.textDim }}>: switch panels and editors</span>
            </text>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.textDim }}>
                Panels use local j/k/enter. Focused textareas route default shortcuts through keymap; plain typing still inserts directly.
              </span>
            </text>
          </box>

          <box id="keymap-demo-log" flexDirection="column" marginTop={1}>
            <text style={{ fg: palette.textDim, attributes: TextAttributes.BOLD }} height={1}>
              Log
            </text>
            {logs.length > 0 ? logs.map((entry, index) => <text key={`${index}-${entry}`} fg={palette.textMuted}>{entry}</text>) : <text fg={palette.textMuted}>(no events yet)</text>}
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
            <span style={{ fg: palette.textDim }}>{`  ${whichKeyPrefix}`}</span>
          </text>

          <scrollbox
            id="keymap-demo-wk-scrollbox"
            flexGrow={1}
            flexShrink={1}
            contentOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{ visible: true }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            {whichKeyEntries.length > 0 ? (
              whichKeyEntries.map((entry) => {
                return (
                  <text key={`${entry.key}-${entry.command}`} fg={palette.text} width="100%" wrapMode="word">
                    <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{entry.key}</span>
                    <span style={{ fg: palette.textMuted }}>{" -> "}</span>
                    <span style={{ fg: palette.command }}>{entry.command}</span>
                  </text>
                )
              })
            ) : (
              <text fg={palette.textMuted}>(no active keys)</text>
            )}
          </scrollbox>
        </box>
      </box>
    </box>
  )
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  createRoot(renderer).render(<App />)
}

export default App
