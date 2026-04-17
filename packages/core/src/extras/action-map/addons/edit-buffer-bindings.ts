import { keyBindingToString } from "../../../lib/keybinding.internal.js"
import { CliRenderEvents } from "../../../renderer.js"
import { InputRenderable } from "../../../renderables/Input.js"
import { TextareaRenderable, defaultTextareaKeyBindings, type TextareaAction } from "../../../renderables/Textarea.js"
import type { EditBufferRenderable } from "../../../renderables/EditBufferRenderable.js"
import type {
  ActionMapBindingInput,
  ActionMapBindings,
  ActionMapCommandDefinition,
  ActionMapCommandContext,
  ActionMapLayer,
  ActionMap,
} from "../types.js"
import { snapshotBindingInputs } from "../lib/utils.js"

const editBufferCommandNames = [
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "newline",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
  "select-all",
  "submit",
] as const satisfies readonly TextareaAction[]

export type EditBufferCommandName = (typeof editBufferCommandNames)[number]

const editBufferCommandDescriptions = {
  "move-left": "Cursor left",
  "move-right": "Cursor right",
  "move-up": "Cursor up",
  "move-down": "Cursor down",
  "select-left": "Select left",
  "select-right": "Select right",
  "select-up": "Select up",
  "select-down": "Select down",
  "line-home": "Line start",
  "line-end": "Line end",
  "select-line-home": "Select to line start",
  "select-line-end": "Select to line end",
  "visual-line-home": "Visual line start",
  "visual-line-end": "Visual line end",
  "select-visual-line-home": "Select to visual line start",
  "select-visual-line-end": "Select to visual line end",
  "buffer-home": "Buffer start",
  "buffer-end": "Buffer end",
  "select-buffer-home": "Select to buffer start",
  "select-buffer-end": "Select to buffer end",
  "delete-line": "Delete line",
  "delete-to-line-end": "Delete to line end",
  "delete-to-line-start": "Delete to line start",
  backspace: "Delete backward",
  delete: "Delete forward",
  newline: "New line",
  undo: "Undo",
  redo: "Redo",
  "word-forward": "Next word",
  "word-backward": "Previous word",
  "select-word-forward": "Select next word",
  "select-word-backward": "Select previous word",
  "delete-word-forward": "Delete next word",
  "delete-word-backward": "Delete previous word",
  "select-all": "Select all",
  submit: "Submit",
} as const satisfies Record<EditBufferCommandName, string>

export interface EditBufferCommandOptions {
  descriptions?: Partial<Record<EditBufferCommandName, string>>
}

const editBufferCommandRegistrations = new WeakMap<
  ActionMap,
  {
    count: number
    dispose: () => void
  }
>()
const textareaMappingSuspensionRegistrations = new WeakMap<ActionMap, { count: number; dispose: () => void }>()

export type ManagedTextareaLayer = Omit<ActionMapLayer, "bindings"> & { bindings?: ActionMapBindings }

function isManagedTextarea(editor: EditBufferRenderable | null): editor is TextareaRenderable {
  return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
}

function resolveEditBufferCommandDescriptions(
  options?: EditBufferCommandOptions,
): Record<EditBufferCommandName, string> {
  const descriptions: Record<EditBufferCommandName, string> = { ...editBufferCommandDescriptions }
  const overrides = options?.descriptions
  if (!overrides) {
    return descriptions
  }

  for (const name of editBufferCommandNames) {
    const override = overrides[name]
    if (override === undefined) {
      continue
    }

    const normalized = override.trim()
    if (!normalized) {
      throw new Error(`Edit buffer command description for "${name}" cannot be empty`)
    }

    descriptions[name] = normalized
  }

  return descriptions
}

function setTextareaSuspend(editor: TextareaRenderable, suspended: boolean): void {
  const nextTraits = { ...editor.traits }
  if (suspended) {
    nextTraits.suspend = true
  } else {
    delete nextTraits.suspend
  }

  editor.traits = nextTraits
}

function createDefaultTextareaBindings(
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
): ActionMapBindingInput[] {
  return defaultTextareaKeyBindings.map((binding) => ({
    key: keyBindingToString(binding),
    cmd: binding.action,
    desc: descriptions[binding.action],
  }))
}

/**
 * Returns the default textarea bindings with any overrides prepended so they
 * take precedence. Prefer `registerManagedTextareaLayer` unless you are
 * composing a custom textarea integration.
 */
export function createTextareaBindings(overrides?: ActionMapBindings): ActionMapBindingInput[] {
  return createTextareaBindingsWithDescriptions(overrides, editBufferCommandDescriptions)
}

function createTextareaBindingsWithDescriptions(
  overrides: ActionMapBindings | undefined,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
): ActionMapBindingInput[] {
  const overrideBindings = overrides ? snapshotBindingInputs(overrides) : []
  return [...overrideBindings, ...createDefaultTextareaBindings(descriptions)]
}

/**
 * Suspends a focused `TextareaRenderable`'s own key handling so action-map
 * bindings can take over, restoring the previous suspend state on cleanup or
 * focus change. Reference-counted per `ActionMap`; prefer
 * `registerManagedTextareaLayer` unless you need this separately.
 */
export function registerTextareaMappingSuspension(actionMap: ActionMap): () => void {
  const existing = textareaMappingSuspensionRegistrations.get(actionMap)
  if (existing) {
    existing.count += 1
    return () => {
      const current = textareaMappingSuspensionRegistrations.get(actionMap)
      if (current !== existing) {
        return
      }

      current.count -= 1
      if (current.count > 0) {
        return
      }

      current.dispose()
      textareaMappingSuspensionRegistrations.delete(actionMap)
    }
  }

  const previousSuspendStates = new WeakMap<TextareaRenderable, boolean>()
  let suspendedEditor: TextareaRenderable | null = null

  const suspendEditor = (editor: EditBufferRenderable | null): void => {
    if (!isManagedTextarea(editor) || editor.isDestroyed) {
      suspendedEditor = null
      return
    }

    if (!previousSuspendStates.has(editor)) {
      previousSuspendStates.set(editor, editor.traits.suspend === true)
    }

    setTextareaSuspend(editor, true)
    suspendedEditor = editor
  }

  const restoreEditor = (editor: EditBufferRenderable | null): void => {
    if (!isManagedTextarea(editor)) {
      return
    }

    const previousSuspend = previousSuspendStates.get(editor)
    if (previousSuspend === undefined) {
      return
    }

    previousSuspendStates.delete(editor)
    if (!editor.isDestroyed) {
      setTextareaSuspend(editor, previousSuspend)
    }

    if (suspendedEditor === editor) {
      suspendedEditor = null
    }
  }

  const onFocusedEditor = (current: EditBufferRenderable | null, previous: EditBufferRenderable | null): void => {
    restoreEditor(previous)
    suspendEditor(current)
  }

  actionMap.renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
  suspendEditor(actionMap.renderer.currentFocusedEditor)

  const dispose = (): void => {
    actionMap.renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    restoreEditor(suspendedEditor)
  }

  const registration = { count: 1, dispose }
  textareaMappingSuspensionRegistrations.set(actionMap, registration)

  return () => {
    const current = textareaMappingSuspensionRegistrations.get(actionMap)
    if (current !== registration) {
      return
    }

    registration.count -= 1
    if (registration.count > 0) {
      return
    }

    registration.dispose()
    textareaMappingSuspensionRegistrations.delete(actionMap)
  }
}

function withFocusedEditor(ctx: ActionMapCommandContext, run: (editor: EditBufferRenderable) => boolean): boolean {
  const editor = ctx.actionMap.renderer.currentFocusedEditor
  if (!editor || editor.isDestroyed) {
    return false
  }

  return run(editor)
}

function hasSubmit(editor: EditBufferRenderable): editor is EditBufferRenderable & { submit: () => boolean } {
  return typeof (editor as { submit?: unknown }).submit === "function"
}

function createEditBufferCommand(
  name: EditBufferCommandName,
  run: (editor: EditBufferRenderable) => boolean,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
): ActionMapCommandDefinition {
  return {
    name,
    desc: descriptions[name],
    run(ctx) {
      return withFocusedEditor(ctx, run)
    },
  }
}

function createEditBufferCommands(
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
): ActionMapCommandDefinition[] {
  return [
    createEditBufferCommand("move-left", (editor) => editor.moveCursorLeft(), descriptions),
    createEditBufferCommand("move-right", (editor) => editor.moveCursorRight(), descriptions),
    createEditBufferCommand("move-up", (editor) => editor.moveCursorUp(), descriptions),
    createEditBufferCommand("move-down", (editor) => editor.moveCursorDown(), descriptions),
    createEditBufferCommand("select-left", (editor) => editor.moveCursorLeft({ select: true }), descriptions),
    createEditBufferCommand("select-right", (editor) => editor.moveCursorRight({ select: true }), descriptions),
    createEditBufferCommand("select-up", (editor) => editor.moveCursorUp({ select: true }), descriptions),
    createEditBufferCommand("select-down", (editor) => editor.moveCursorDown({ select: true }), descriptions),
    createEditBufferCommand("line-home", (editor) => editor.gotoLineHome(), descriptions),
    createEditBufferCommand("line-end", (editor) => editor.gotoLineEnd(), descriptions),
    createEditBufferCommand("select-line-home", (editor) => editor.gotoLineHome({ select: true }), descriptions),
    createEditBufferCommand("select-line-end", (editor) => editor.gotoLineEnd({ select: true }), descriptions),
    createEditBufferCommand("visual-line-home", (editor) => editor.gotoVisualLineHome(), descriptions),
    createEditBufferCommand("visual-line-end", (editor) => editor.gotoVisualLineEnd(), descriptions),
    createEditBufferCommand(
      "select-visual-line-home",
      (editor) => editor.gotoVisualLineHome({ select: true }),
      descriptions,
    ),
    createEditBufferCommand(
      "select-visual-line-end",
      (editor) => editor.gotoVisualLineEnd({ select: true }),
      descriptions,
    ),
    createEditBufferCommand("buffer-home", (editor) => editor.gotoBufferHome(), descriptions),
    createEditBufferCommand("buffer-end", (editor) => editor.gotoBufferEnd(), descriptions),
    createEditBufferCommand("select-buffer-home", (editor) => editor.gotoBufferHome({ select: true }), descriptions),
    createEditBufferCommand("select-buffer-end", (editor) => editor.gotoBufferEnd({ select: true }), descriptions),
    createEditBufferCommand("delete-line", (editor) => editor.deleteLine(), descriptions),
    createEditBufferCommand("delete-to-line-end", (editor) => editor.deleteToLineEnd(), descriptions),
    createEditBufferCommand("delete-to-line-start", (editor) => editor.deleteToLineStart(), descriptions),
    createEditBufferCommand("backspace", (editor) => editor.deleteCharBackward(), descriptions),
    createEditBufferCommand("delete", (editor) => editor.deleteChar(), descriptions),
    createEditBufferCommand("newline", (editor) => editor.newLine(), descriptions),
    createEditBufferCommand("undo", (editor) => editor.undo(), descriptions),
    createEditBufferCommand("redo", (editor) => editor.redo(), descriptions),
    createEditBufferCommand("word-forward", (editor) => editor.moveWordForward(), descriptions),
    createEditBufferCommand("word-backward", (editor) => editor.moveWordBackward(), descriptions),
    createEditBufferCommand("select-word-forward", (editor) => editor.moveWordForward({ select: true }), descriptions),
    createEditBufferCommand(
      "select-word-backward",
      (editor) => editor.moveWordBackward({ select: true }),
      descriptions,
    ),
    createEditBufferCommand("delete-word-forward", (editor) => editor.deleteWordForward(), descriptions),
    createEditBufferCommand("delete-word-backward", (editor) => editor.deleteWordBackward(), descriptions),
    createEditBufferCommand("select-all", (editor) => editor.selectAll(), descriptions),
    createEditBufferCommand(
      "submit",
      (editor) => {
        if (!hasSubmit(editor)) {
          return false
        }

        return editor.submit()
      },
      descriptions,
    ),
  ]
}

/**
 * Registers the standard edit-buffer commands against
 * `renderer.currentFocusedEditor`. Reference-counted per `ActionMap`; prefer
 * `registerManagedTextareaLayer` unless you need the commands without the
 * default bindings or textarea suspension.
 */
export function registerEditBufferCommands(actionMap: ActionMap, options?: EditBufferCommandOptions): () => void {
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const existing = editBufferCommandRegistrations.get(actionMap)
  if (existing) {
    existing.count += 1
    return () => {
      const current = editBufferCommandRegistrations.get(actionMap)
      if (current !== existing) {
        return
      }

      current.count -= 1
      if (current.count > 0) {
        return
      }

      current.dispose()
      editBufferCommandRegistrations.delete(actionMap)
    }
  }

  const dispose = actionMap.registerCommands(createEditBufferCommands(descriptions))
  const registration = { count: 1, dispose }
  editBufferCommandRegistrations.set(actionMap, registration)

  return () => {
    const current = editBufferCommandRegistrations.get(actionMap)
    if (current !== registration) {
      return
    }

    registration.count -= 1
    if (registration.count > 0) {
      return
    }

    registration.dispose()
    editBufferCommandRegistrations.delete(actionMap)
  }
}

/**
 * High-level textarea integration: registers the edit-buffer commands,
 * suspends the textarea's built-in key handling while focused, and installs
 * the layer with default bindings plus overrides. Safe to combine with the
 * lower-level helpers because they are reference-counted.
 */
export function registerManagedTextareaLayer(
  actionMap: ActionMap,
  layer: ManagedTextareaLayer,
  options?: EditBufferCommandOptions,
): () => void {
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const offCommands = registerEditBufferCommands(actionMap, options)
  const offSuspension = registerTextareaMappingSuspension(actionMap)

  try {
    const { bindings, ...rest } = layer
    const offLayer = actionMap.registerLayer({
      ...rest,
      bindings: createTextareaBindingsWithDescriptions(bindings, descriptions),
    })

    return () => {
      offLayer()
      offSuspension()
      offCommands()
    }
  } catch (error) {
    offSuspension()
    offCommands()
    throw error
  }
}
