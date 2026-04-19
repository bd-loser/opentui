import {
  addons,
  getKeymap,
  stringifyKeySequence,
  type ActiveKey,
} from "/dist/keymap/html.js"

const app = document.getElementById("app") as HTMLElement | null
const alphaPanel = document.getElementById("alpha-panel") as HTMLElement | null
const betaPanel = document.getElementById("beta-panel") as HTMLElement | null
const notesCard = document.getElementById("notes-card") as HTMLElement | null
const draftCard = document.getElementById("draft-card") as HTMLElement | null
const notesField = document.getElementById("notes-field") as HTMLTextAreaElement | null
const draftField = document.getElementById("draft-field") as HTMLTextAreaElement | null
const promptShell = document.getElementById("prompt-shell") as HTMLElement | null
const commandInput = document.getElementById("command-input") as HTMLInputElement | null
const commandHelp = document.getElementById("command-help") as HTMLElement | null
const commandSuggestions = document.getElementById("command-suggestions") as HTMLElement | null
const leaderState = document.getElementById("leader-state") as HTMLElement | null
const pendingSequence = document.getElementById("pending-sequence") as HTMLElement | null
const focusedTarget = document.getElementById("focused-target") as HTMLElement | null
const alphaCount = document.getElementById("alpha-count") as HTMLElement | null
const betaCount = document.getElementById("beta-count") as HTMLElement | null
const activeKeys = document.getElementById("active-keys") as HTMLElement | null
const logLines = document.getElementById("log-lines") as HTMLElement | null
const helpCard = document.getElementById("help-card") as HTMLElement | null
const helpCopy = document.getElementById("help-copy") as HTMLElement | null

if (
  !app ||
  !alphaPanel ||
  !betaPanel ||
  !notesCard ||
  !draftCard ||
  !notesField ||
  !draftField ||
  !promptShell ||
  !commandInput ||
  !commandHelp ||
  !commandSuggestions ||
  !leaderState ||
  !pendingSequence ||
  !focusedTarget ||
  !alphaCount ||
  !betaCount ||
  !activeKeys ||
  !logLines ||
  !helpCard ||
  !helpCopy
) {
  throw new Error("HTML keymap example is missing required DOM nodes")
}

const keymap = getKeymap(app)
const focusableTargets = [alphaPanel, betaPanel, notesField, draftField]

let alphaValue = 0
let betaValue = 0
let helpVisible = true
let promptVisible = false
let leaderArmed = false
let promptRestoreTarget: HTMLElement | null = null
let selectedSuggestion = 0
let lastAction = "Focus a panel or textarea to begin."
let logEntries: Array<{ at: string; message: string }> = []

interface ExSuggestion {
  label: string
  insert: string
  usage: string
  desc: string
}

function appendLog(message: string): void {
  lastAction = message
  logEntries = [{ at: new Date().toLocaleTimeString(), message }, ...logEntries].slice(0, 8)
  renderLog()
}

function getCurrentFocusedTarget(): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) {
    return null
  }

  if (active === app || app.contains(active)) {
    return active
  }

  return null
}

function focusOffset(delta: number): void {
  const current = getCurrentFocusedTarget()
  const currentIndex = focusableTargets.findIndex((target) => target === current)
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + focusableTargets.length) % focusableTargets.length
  focusableTargets[nextIndex]?.focus()
}

function setPromptVisible(visible: boolean): void {
  promptVisible = visible
  promptShell.classList.toggle("is-hidden", !visible)
}

function getText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed
}

function getCommandSuggestions(): ExSuggestion[] {
  const records = keymap.getCommands({ namespace: "excommands" })
  const input = commandInput.value.trim()
  const query = input.includes(" ") ? input.slice(0, input.indexOf(" ")) : input
  const normalizedQuery = query === ":" ? "" : query

  const suggestions = records.map((record) => {
    const label = record.name.startsWith(":") ? record.name : `:${record.name}`
    const usage = getText(record.fields.usage) ?? label
    const desc = getText(record.attrs?.desc) ?? getText(record.fields.desc) ?? ""

    return {
      label,
      insert: label,
      usage,
      desc,
    }
  })

  if (!normalizedQuery) {
    return suggestions.slice(0, 6)
  }

  return suggestions.filter((suggestion) => suggestion.label.startsWith(normalizedQuery)).slice(0, 6)
}

function applySuggestion(delta: number): void {
  const suggestions = getCommandSuggestions()
  if (suggestions.length === 0) {
    return
  }

  selectedSuggestion = (selectedSuggestion + delta + suggestions.length) % suggestions.length
  renderPrompt()
}

function completeSuggestion(): void {
  const suggestions = getCommandSuggestions()
  const suggestion = suggestions[selectedSuggestion]
  if (!suggestion) {
    return
  }

  commandInput.value = suggestion.insert
  commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length)
  renderPrompt()
}

function openPrompt(): void {
  if (promptVisible) {
    commandInput.focus()
    return
  }

  promptRestoreTarget = getCurrentFocusedTarget()
  selectedSuggestion = 0
  commandInput.value = ":"
  setPromptVisible(true)
  commandInput.focus()
  commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length)
  appendLog("Opened ex prompt")
  renderPrompt()
  renderAll()
}

function closePrompt(): void {
  if (!promptVisible) {
    return
  }

  setPromptVisible(false)
  selectedSuggestion = 0
  commandInput.value = ":"

  if (promptRestoreTarget && document.contains(promptRestoreTarget)) {
    promptRestoreTarget.focus()
  }

  promptRestoreTarget = null
  appendLog("Closed ex prompt")
  renderPrompt()
  renderAll()
}

function runPromptCommand(): void {
  const command = commandInput.value.trim()
  if (!command || command === ":") {
    closePrompt()
    return
  }

  const result = keymap.runCommand(command)
  if (result.ok) {
    appendLog(`Ran ${command}`)
    closePrompt()
    return
  }

  appendLog(`Command failed: ${command} (${result.reason})`)
  renderPrompt()
}

function saveSnapshot(label: string): void {
  appendLog(`${label}: alpha=${alphaValue}, beta=${betaValue}, notes=${notesField.value.length} chars, draft=${draftField.value.length} chars`)
}

function resetDemo(): void {
  alphaValue = 0
  betaValue = 0
  renderCounters()
  appendLog("Reset counters")
  renderAll()
}

function toggleHelp(): void {
  helpVisible = !helpVisible
  helpCard.classList.toggle("is-hidden", !helpVisible)
  appendLog(helpVisible ? "Help opened" : "Help hidden")
}

function incrementAlpha(delta: number): void {
  alphaValue += delta
  renderCounters()
  appendLog(`Alpha ${delta > 0 ? "incremented" : "decremented"} to ${alphaValue}`)
}

function incrementBeta(delta: number): void {
  betaValue += delta
  renderCounters()
  appendLog(`Beta ${delta > 0 ? "incremented" : "decremented"} to ${betaValue}`)
}

function captureTextarea(name: string, field: HTMLTextAreaElement): void {
  appendLog(`${name}: ${field.value.split(/\n+/)[0] ?? ""}`)
}

function renderCounters(): void {
  alphaCount.textContent = String(alphaValue)
  betaCount.textContent = String(betaValue)
}

function renderStatus(): void {
  leaderState.textContent = leaderArmed ? "Armed" : "Idle"

  const pending = keymap.getPendingSequence()
  pendingSequence.textContent = pending.length === 0 ? "None" : stringifyKeySequence(pending, { preferDisplay: true })

  const focused = getCurrentFocusedTarget()
  focusedTarget.textContent = focused?.id ?? "None"
}

function getActiveKeyDescription(activeKey: ActiveKey): string {
  const fromBinding = getText(activeKey.bindingAttrs?.desc)
  if (fromBinding) {
    return fromBinding
  }

  const fromCommandDesc = getText(activeKey.commandAttrs?.desc)
  if (fromCommandDesc) {
    return fromCommandDesc
  }

  const fromCommandTitle = getText(activeKey.commandAttrs?.title)
  if (fromCommandTitle) {
    return fromCommandTitle
  }

  if (activeKey.continues) {
    const group = getText(activeKey.bindingAttrs?.group)
    if (group) {
      return `Continue ${group.toLowerCase()} bindings`
    }

    return "Continue sequence"
  }

  if (typeof activeKey.command === "string") {
    return activeKey.command
  }

  return "Action"
}

function renderActiveKeys(): void {
  const entries = keymap.getActiveKeys({ includeMetadata: true })
  if (entries.length === 0) {
    activeKeys.innerHTML = '<div class="active-key-row">No active bindings for the current focus state.</div>'
    return
  }

  activeKeys.innerHTML = entries
    .map((entry) => {
      return `
        <div class="active-key-row">
          <div class="active-key-header">
            <strong><kbd>${entry.display}</kbd></strong>
            <span>${entry.continues ? "Prefix" : "Command"}</span>
          </div>
          <div class="active-key-desc">${getActiveKeyDescription(entry)}</div>
        </div>
      `
    })
    .join("")
}

function renderLog(): void {
  logLines.innerHTML = logEntries
    .map((entry) => {
      return `<div class="log-line"><time>${entry.at}</time><div>${entry.message}</div></div>`
    })
    .join("")
}

function renderPrompt(): void {
  if (!promptVisible) {
    commandHelp.textContent = "Prompt hidden. Press : to open it."
    commandSuggestions.innerHTML = ""
    return
  }

  const suggestions = getCommandSuggestions()
  const selected = suggestions[selectedSuggestion] ?? suggestions[0]
  if (selected && suggestions[0] && !suggestions[selectedSuggestion]) {
    selectedSuggestion = 0
  }

  commandHelp.textContent = selected ? `${selected.usage}${selected.desc ? ` - ${selected.desc}` : ""}` : "No matching ex command"
  commandSuggestions.innerHTML = suggestions
    .map((suggestion, index) => {
      const selectedClass = index === selectedSuggestion ? " suggestion is-selected" : " suggestion"
      return `
        <div class="${selectedClass.trim()}">
          <div class="suggestion-header">
            <strong>${suggestion.label}</strong>
            <span class="suggestion-usage">${suggestion.usage}</span>
          </div>
          <div class="suggestion-desc">${suggestion.desc || "No description"}</div>
        </div>
      `
    })
    .join("")
}

function renderHelp(): void {
  helpCard.classList.toggle("is-hidden", !helpVisible)
  helpCopy.innerHTML = [
    "<div><kbd>Tab</kbd> and <kbd>Shift+Tab</kbd> cycle focus between panels and textareas.</div>",
    "<div><kbd>Space</kbd> arms a leader sequence for <kbd>Space s</kbd>, <kbd>Space h</kbd>, and <kbd>Space r</kbd>.</div>",
    "<div><kbd>:</kbd> opens the ex prompt. Try <kbd>:help</kbd>, <kbd>:reset</kbd>, <kbd>:write alpha</kbd>, or <kbd>:focus draft</kbd>.</div>",
    "<div>The Alpha and Beta panels each install their own focus-within layers with <kbd>j</kbd>, <kbd>k</kbd>, and <kbd>Enter</kbd>.</div>",
    "<div>The Notes and Draft textareas use plain browser editing plus keymap bindings for <kbd>Ctrl+Enter</kbd>.</div>",
  ].join("")
}

function renderAll(): void {
  renderCounters()
  renderStatus()
  renderActiveKeys()
  renderPrompt()
  renderHelp()
}

disposers()

function disposers(): void {
  addons.registerEnabledField(keymap)
  addons.registerMetadataFields(keymap)
  addons.registerExCommands(keymap, [
    {
      name: ":help",
      desc: "Toggle the help card",
      run() {
        toggleHelp()
      },
    },
    {
      name: ":reset",
      desc: "Reset the counters",
      run() {
        resetDemo()
      },
    },
    {
      name: ":write",
      aliases: ["w"],
      nargs: "?",
      desc: "Log a snapshot for the current demo state",
      usage: ":write [label]",
      run({ args }) {
        saveSnapshot(args[0] ?? "write")
      },
    },
    {
      name: ":focus",
      nargs: "1",
      desc: "Focus alpha, beta, notes, or draft",
      usage: ":focus <alpha|beta|notes|draft>",
      run({ args }) {
        const targetName = args[0]?.toLowerCase()
        const targets = new Map<string, HTMLElement>([
          ["alpha", alphaPanel],
          ["beta", betaPanel],
          ["notes", notesField],
          ["draft", draftField],
        ])
        const target = targetName ? targets.get(targetName) : undefined
        if (!target) {
          appendLog(`Unknown focus target: ${targetName ?? ""}`)
          return false
        }

        target.focus()
        appendLog(`Focused ${target.id}`)
      },
    },
  ])
  addons.registerTimedLeader(keymap, {
    trigger: " ",
    timeoutMs: 1600,
    onArm() {
      leaderArmed = true
      renderStatus()
    },
    onDisarm() {
      leaderArmed = false
      renderStatus()
    },
  })
  addons.registerEscapeClearsPendingSequence(keymap)
  addons.registerBackspacePopsPendingSequence(keymap)

  keymap.registerLayer({
    scope: "global",
    commands: [
      { name: "focus-next", title: "Focus Next", desc: "Move to the next focus target", run() { focusOffset(1) } },
      { name: "focus-prev", title: "Focus Previous", desc: "Move to the previous focus target", run() { focusOffset(-1) } },
      { name: "toggle-help", title: "Toggle Help", desc: "Show or hide the help card", run() { toggleHelp() } },
      { name: "prompt-open", title: "Open Ex Prompt", desc: "Open the ex command prompt", run() { openPrompt() } },
      { name: "prompt-close", title: "Close Ex Prompt", desc: "Close the ex command prompt", run() { closePrompt() } },
      { name: "prompt-submit", title: "Run Ex Command", desc: "Run the current ex command", run() { runPromptCommand() } },
      { name: "prompt-next", title: "Next Suggestion", desc: "Move to the next ex suggestion", run() { applySuggestion(1) } },
      { name: "prompt-prev", title: "Previous Suggestion", desc: "Move to the previous ex suggestion", run() { applySuggestion(-1) } },
      { name: "prompt-complete", title: "Complete Suggestion", desc: "Insert the selected ex suggestion", run() { completeSuggestion() } },
      { name: "save-session", title: "Save Session", desc: "Log a synthetic write snapshot", run() { saveSnapshot("leader") } },
      { name: "alpha-up", title: "Alpha Up", desc: "Increment the Alpha counter", run() { incrementAlpha(1) } },
      { name: "alpha-down", title: "Alpha Down", desc: "Decrement the Alpha counter", run() { incrementAlpha(-1) } },
      { name: "beta-up", title: "Beta Up", desc: "Increment the Beta counter", run() { incrementBeta(1) } },
      { name: "beta-down", title: "Beta Down", desc: "Decrement the Beta counter", run() { incrementBeta(-1) } },
      { name: "panel-write", title: "Panel Write", desc: "Log a panel write action", run(ctx) { appendLog(`Panel write from ${ctx.focused?.id ?? "unknown"}`) } },
      { name: "capture-notes", title: "Capture Notes", desc: "Log the Notes textarea snapshot", run() { captureTextarea("notes", notesField) } },
      { name: "capture-draft", title: "Capture Draft", desc: "Log the Draft textarea snapshot", run() { captureTextarea("draft", draftField) } },
    ],
  })

  keymap.registerLayer({
    scope: "global",
    enabled: () => !promptVisible,
    bindings: [
      { key: "tab", cmd: "focus-next", desc: "Next focus target" },
      { key: "shift+tab", cmd: "focus-prev", desc: "Previous focus target" },
      { key: "?", cmd: "toggle-help", desc: "Toggle help" },
      { key: ":", cmd: "prompt-open", desc: "Open ex prompt" },
      { key: "<leader>s", cmd: "save-session", desc: "Log a write snapshot" },
      { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help" },
      { key: "<leader>r", cmd: ":reset", desc: "Reset counters" },
      { key: "<leader>f", cmd: ":focus notes", desc: "Focus the notes editor" },
    ],
  })

  keymap.registerLayer({
    target: alphaPanel,
    scope: "focus-within",
    bindings: [
      { key: "j", cmd: "alpha-up", desc: "Alpha +1" },
      { key: "k", cmd: "alpha-down", desc: "Alpha -1" },
      { key: "return", cmd: "panel-write", desc: "Write alpha snapshot" },
    ],
  })

  keymap.registerLayer({
    target: betaPanel,
    scope: "focus-within",
    bindings: [
      { key: "j", cmd: "beta-up", desc: "Beta +1" },
      { key: "k", cmd: "beta-down", desc: "Beta -1" },
      { key: "return", cmd: "panel-write", desc: "Write beta snapshot" },
    ],
  })

  keymap.registerLayer({
    target: notesCard,
    scope: "focus-within",
    bindings: [{ key: "ctrl+return", cmd: "capture-notes", desc: "Capture notes snapshot" }],
  })

  keymap.registerLayer({
    target: draftCard,
    scope: "focus-within",
    bindings: [{ key: "ctrl+return", cmd: "capture-draft", desc: "Capture draft snapshot" }],
  })

  keymap.registerLayer({
    target: promptShell,
    scope: "focus-within",
    enabled: () => promptVisible,
    bindings: [
      { key: "escape", cmd: "prompt-close", desc: "Close prompt" },
      { key: "return", cmd: "prompt-submit", desc: "Run ex command" },
      { key: "tab", cmd: "prompt-complete", desc: "Complete suggestion" },
      { key: "up", cmd: "prompt-prev", desc: "Previous suggestion" },
      { key: "down", cmd: "prompt-next", desc: "Next suggestion" },
    ],
  })

  keymap.on("state", () => {
    renderAll()
  })
  keymap.on("warning", (event) => {
    appendLog(`Warning: ${event.message}`)
  })
  keymap.on("error", (event) => {
    appendLog(`Error: ${event.message}`)
  })
}

commandInput.addEventListener("input", () => {
  selectedSuggestion = 0
  renderPrompt()
})

renderCounters()
renderHelp()
appendLog(lastAction)
renderAll()
alphaPanel.focus()
