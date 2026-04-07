import { ConsolePosition } from "@opentui/core"
import { registerExCommands, registerTimedLeader } from "@opentui/core/extras"
import { render, useKeymap, useKeymappings, useRenderer } from "@opentui/solid"
import { Show, createSignal, onCleanup, onMount, type Accessor } from "solid-js"

type PanelId = "alpha" | "beta"

function CounterPanel(props: {
  id: PanelId
  label: string
  step: number
  color: string
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
      enter: `:announce ${props.label} confirmed`,
    },
  })

  onCleanup(() => {
    offCommands()
  })

  return (
    <box
      ref={keymapRef}
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
      <text fg="#e2e8f0">
        {[
          `${props.label} Panel`,
          `Count: ${props.count()}`,
          `j: +${props.step}`,
          `k: -${props.step}`,
          `enter: :announce ${props.label} confirmed`,
        ].join("\n")}
      </text>
    </box>
  )
}

export default function KeymapDemo() {
  const renderer = useRenderer()
  const manager = useKeymappings()

  const [activePanel, setActivePanel] = createSignal<PanelId>("alpha")
  const [alphaCount, setAlphaCount] = createSignal(0)
  const [betaCount, setBetaCount] = createSignal(0)
  const [helpVisible, setHelpVisible] = createSignal(true)
  const [leaderArmed, setLeaderArmed] = createSignal(false)
  const [lastAction, setLastAction] = createSignal("Press Tab to start.")
  const [logs, setLogs] = createSignal<string[]>([
    "Tab switches focus. j/k act on the focused panel.",
    "ctrl+x arms the leader extension.",
  ])

  const announce = (message: string) => {
    setLastAction(message)
    setLogs((current) => [message, ...current].slice(0, 4))
  }

  const focusPanel = (id: PanelId) => {
    setActivePanel(id)
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
      name: "announce",
      aliases: ["echo"],
      nargs: "+",
      run({ args }) {
        announce(`Ex command: ${args.join(" ")}`)
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
    bindings: {
      tab: "focus-next",
      "shift+tab": "focus-prev",
      "?": "toggle-help",
      "ctrl+r": ":reset",
      "<leader>s": ":announce Saved via leader",
      "<leader>h": "toggle-help",
    },
  })

  onMount(() => {
    renderer.setBackgroundColor("#0f172a")
  })

  onCleanup(() => {
    offLeader()
    offEx()
    offActions()
  })

  return (
    <box flexDirection="column" flexGrow={1} padding={1} backgroundColor="#0f172a">
      <text fg="#f8fafc">Keymap Demo</text>
      <text fg="#94a3b8">
        Shows useKeymappings + useKeymap with global bindings, local panel bindings, and a ctrl+x leader extension.
      </text>

      <box flexDirection="row" gap={1} height={7}>
        <CounterPanel
          id="alpha"
          label="Alpha"
          step={1}
          color="#38bdf8"
          count={alphaCount}
          focused={() => activePanel() === "alpha"}
          setFocused={setActivePanel}
          setCount={setAlphaCount}
          announce={announce}
        />
        <CounterPanel
          id="beta"
          label="Beta"
          step={5}
          color="#34d399"
          count={betaCount}
          focused={() => activePanel() === "beta"}
          setFocused={setActivePanel}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      <box border borderColor="#475569" padding={1} marginTop={1} flexGrow={1} flexDirection="column">
        <text fg="#f8fafc">
          Focused: {activePanel() === "alpha" ? "Alpha" : "Beta"} | Leader: {leaderArmed() ? "armed (ctrl+x)" : "idle"}
        </text>
        <text fg="#f8fafc">Last action: {lastAction()}</text>
        <Show when={helpVisible()}>
          <text fg="#cbd5e1">
            {[
              "",
              "Global keymaps:",
              "tab / shift+tab: move focus",
              "?: toggle help | ctrl+r: :reset",
              "ctrl+x then s: :announce Saved via leader",
              "ctrl+x then h: toggle help",
            ].join("\n")}
          </text>
        </Show>
        <text fg="#fbbf24">{"\nRecent log:\n" + logs().join("\n")}</text>
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
