import { ConsolePosition } from "@opentui/core"
import { registerExCommands, registerTimedLeader, stringifyKeySequence, stringifyKeyStroke } from "@opentui/core/extras"
import { render, useKeymap, useKeymappings, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"

type PanelId = "alpha" | "beta"

interface FocusableRenderable {
  focus(): void
}

function CounterPanel(props: {
  id: PanelId
  label: string
  saveTarget: string
  step: number
  color: string
  setRef?: (value: FocusableRenderable) => void
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
      run() {
        const next = props.count() + props.step
        props.setCount(next)
        props.announce(`${props.label} increased to ${next}`)
      },
    },
    {
      name: decrementCommand,
      run() {
        const next = props.count() - props.step
        props.setCount(next)
        props.announce(`${props.label} decreased to ${next}`)
      },
    },
  ])

  const keymapRef = useKeymap({
    bindings: {
      j: incrementCommand,
      k: decrementCommand,
      enter: `:w ${props.saveTarget}`,
    },
  })

  onCleanup(() => {
    offCommands()
  })

  return (
    <box
      ref={(value: FocusableRenderable) => {
        keymapRef(value)
        props.setRef?.(value)
      }}
      border
      focusable
      focused={props.focused()}
      borderColor="#475569"
      focusedBorderColor={props.color}
      padding={1}
      flexGrow={1}
      flexDirection="column"
      on:focused={() => props.setFocused(props.id)}
    >
      <text fg="#e2e8f0" height={5}>
        {[
          `${props.label} Panel`,
          `Count: ${props.count()}`,
          `j: +${props.step}`,
          `k: -${props.step}`,
          `enter: :w ${props.saveTarget}`,
        ].join("\n")}
      </text>
    </box>
  )
}

export default function KeymapDemo() {
  const renderer = useRenderer()
  const manager = useKeymappings()
  let alphaPanelRef: FocusableRenderable | undefined

  const [activePanel, setActivePanel] = createSignal<PanelId>("alpha")
  const [alphaCount, setAlphaCount] = createSignal(0)
  const [betaCount, setBetaCount] = createSignal(0)
  const [helpVisible, setHelpVisible] = createSignal(true)
  const [leaderArmed, setLeaderArmed] = createSignal(false)
  const [lastAction, setLastAction] = createSignal("Press Tab to start.")
  const [sequenceVersion, setSequenceVersion] = createSignal(0)
  const [logs, setLogs] = createSignal<string[]>([
    "Tab switches focus. j/k act on the focused panel.",
    "ctrl+x arms the leader extension.",
  ])

  const announce = (message: string) => {
    setLastAction(message)
    setLogs((current) => [message, ...current].slice(0, 6))
    setSequenceVersion((value) => value + 1)
  }

  const setFocusedPanel = (id: PanelId) => {
    setActivePanel(id)
    setSequenceVersion((value) => value + 1)
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
      run() {
        moveFocus(1)
      },
    },
    {
      name: "focus-prev",
      run() {
        moveFocus(-1)
      },
    },
    {
      name: "toggle-help",
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

  const offPendingSequence = manager.onPendingSequenceChange(() => {
    setSequenceVersion((value) => value + 1)
  })

  useKeymap({
    scope: "global",
    bindings: {
      tab: "focus-next",
      "shift+tab": "focus-prev",
      "?": "toggle-help",
      "ctrl+r": ":reset",
      "<leader>s": ":w session.log",
      "<leader>h": "toggle-help",
    },
  })

  const whichKeyText = createMemo(() => {
    activePanel()
    sequenceVersion()

    const activeKeys = [...manager.getActiveKeys()].sort((left, right) => {
      return stringifyKeyStroke(left, { preferDisplay: true }).localeCompare(
        stringifyKeyStroke(right, { preferDisplay: true }),
      )
    })

    const prefix = stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
    const lines = ["Which Key", `Prefix: ${prefix}`]

    if (activeKeys.length === 0) {
      lines.push("(no active keys)")
    } else {
      for (const activeKey of activeKeys.slice(0, 8)) {
        const commandList = activeKey.commands.map((command) => command.input).join(" | ")
        lines.push(`${stringifyKeyStroke(activeKey, { preferDisplay: true })} -> ${commandList}`)
      }
    }

    lines.push("", "Ex commands", ":reset / :r", ":write <file> / :w <file>")

    return lines.join("\n")
  })

  const detailsText = createMemo(() => {
    const lines = [
      `Focused: ${activePanel() === "alpha" ? "Alpha" : "Beta"}`,
      `Leader: ${leaderArmed() ? "armed (ctrl+x)" : "idle"}`,
      `Last action: ${lastAction()}`,
    ]

    if (helpVisible()) {
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

    const recentLogs = logs().slice(0, 4)
    if (recentLogs.length > 0) {
      lines.push("", "Recent log:", ...recentLogs)
    }

    return lines.join("\n")
  })

  onMount(() => {
    renderer.setBackgroundColor("#0f172a")
    alphaPanelRef?.focus()
    announce("Focused Alpha panel")
  })

  onCleanup(() => {
    offPendingSequence()
    offLeader()
    offEx()
    offActions()
  })

  return (
    <box flexDirection="column" flexGrow={1} padding={1} backgroundColor="#0f172a">
      <text fg="#f8fafc" height={1}>
        Keymap Demo
      </text>
      <text fg="#94a3b8" height={2}>
        Shows useKeymappings + useKeymap with global bindings, local panel bindings, which-key hints, and a ctrl+x
        leader extension.
      </text>

      <box flexDirection="row" gap={1} height={7}>
        <CounterPanel
          id="alpha"
          label="Alpha"
          saveTarget="alpha-panel.txt"
          step={1}
          color="#38bdf8"
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
          color="#34d399"
          count={betaCount}
          focused={() => activePanel() === "beta"}
          setFocused={setFocusedPanel}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      <box border borderColor="#475569" padding={1} marginTop={1} flexGrow={1} flexDirection="row" gap={2}>
        <box flexGrow={1} flexDirection="column">
          <text fg="#f8fafc" height={12}>
            {detailsText()}
          </text>
        </box>
        <box width={28}>
          <text fg="#cbd5e1" height={12}>
            {whichKeyText()}
          </text>
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
