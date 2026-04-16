import { keyBindingToString } from "../../../lib/keybinding.internal.js"
import { CliRenderEvents } from "../../../renderer.js"
import { InputRenderable } from "../../../renderables/Input.js"
import { TextareaRenderable, defaultTextareaKeyBindings, type TextareaAction } from "../../../renderables/Textarea.js"
import type { EditBufferRenderable } from "../../../renderables/EditBufferRenderable.js"
import type {
  ActionMapBindingInput,
  ActionMapBindings,
  ActionMapCommand,
  ActionMapCommandContext,
  ActionMapFocusLayer,
  ActionMapFocusWithinLayer,
  ActionMapGlobalLayer,
  ActionMap,
} from "../types.js"
import { snapshotBindingInputs } from "../utils.js"

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

export type ManagedTextareaLayer =
  | (Omit<ActionMapGlobalLayer, "bindings"> & { bindings?: ActionMapBindings })
  | (Omit<ActionMapFocusLayer, "bindings"> & { bindings?: ActionMapBindings })
  | (Omit<ActionMapFocusWithinLayer, "bindings"> & { bindings?: ActionMapBindings })

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
 * Builds the default textarea binding list with optional user overrides prepended
 * (earlier entries win, so overrides take precedence over defaults).
 *
 * Exported for advanced use cases where an application composes its own textarea
 * integration. For standard use, prefer `registerManagedTextareaLayer`, which
 * wires these bindings together with the edit-buffer commands and the required
 * textarea-mapping suspension in a single call.
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
 * Suspends the built-in local key handling of the currently focused `TextareaRenderable`
 * so that action-map bindings can drive the editor instead. Restores the previous
 * suspend state on disposal and when focus moves away.
 *
 * Reference-counted per `ActionMap`: repeated calls share one registration and the
 * underlying teardown only runs when the last caller disposes.
 *
 * Exported for advanced use cases where an application drives textarea bindings
 * without the full managed layer. For standard use, prefer
 * `registerManagedTextareaLayer`, which calls this internally.
 */
export function registerTextareaMappingSuspension(manager: ActionMap): () => void {
  const existing = textareaMappingSuspensionRegistrations.get(manager)
  if (existing) {
    existing.count += 1
    return () => {
      const current = textareaMappingSuspensionRegistrations.get(manager)
      if (current !== existing) {
        return
      }

      current.count -= 1
      if (current.count > 0) {
        return
      }

      current.dispose()
      textareaMappingSuspensionRegistrations.delete(manager)
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

  manager.renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
  suspendEditor(manager.renderer.currentFocusedEditor)

  const dispose = (): void => {
    manager.renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    restoreEditor(suspendedEditor)
  }

  const registration = { count: 1, dispose }
  textareaMappingSuspensionRegistrations.set(manager, registration)

  return () => {
    const current = textareaMappingSuspensionRegistrations.get(manager)
    if (current !== registration) {
      return
    }

    registration.count -= 1
    if (registration.count > 0) {
      return
    }

    registration.dispose()
    textareaMappingSuspensionRegistrations.delete(manager)
  }
}

function withFocusedEditor(ctx: ActionMapCommandContext, run: (editor: EditBufferRenderable) => boolean): boolean {
  const editor = ctx.renderer.currentFocusedEditor
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
): ActionMapCommand {
  return {
    name,
    desc: descriptions[name],
    run(ctx) {
      return withFocusedEditor(ctx, run)
    },
  }
}

function createEditBufferCommands(descriptions: Readonly<Record<EditBufferCommandName, string>>): ActionMapCommand[] {
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
 * Registers the standard edit-buffer commands (cursor movement, selection, deletion,
 * undo/redo, submit, etc.) on the given `ActionMap`. Each command operates on
 * `renderer.currentFocusedEditor` and returns `false` when no editor is focused.
 *
 * Reference-counted per `ActionMap`: repeated calls share one registration and the
 * commands are only removed when the last caller disposes.
 *
 * Exported for advanced use cases where an application needs the commands without
 * the default bindings or the textarea suspension (for example, to bind them under
 * a different key scheme). For standard use, prefer `registerManagedTextareaLayer`,
 * which calls this internally.
 */
export function registerEditBufferCommands(manager: ActionMap, options?: EditBufferCommandOptions): () => void {
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const existing = editBufferCommandRegistrations.get(manager)
  if (existing) {
    existing.count += 1
    return () => {
      const current = editBufferCommandRegistrations.get(manager)
      if (current !== existing) {
        return
      }

      current.count -= 1
      if (current.count > 0) {
        return
      }

      current.dispose()
      editBufferCommandRegistrations.delete(manager)
    }
  }

  const dispose = manager.registerCommands(createEditBufferCommands(descriptions))
  const registration = { count: 1, dispose }
  editBufferCommandRegistrations.set(manager, registration)

  return () => {
    const current = editBufferCommandRegistrations.get(manager)
    if (current !== registration) {
      return
    }

    registration.count -= 1
    if (registration.count > 0) {
      return
    }

    registration.dispose()
    editBufferCommandRegistrations.delete(manager)
  }
}

/**
 * Preferred entry point for driving `TextareaRenderable` editors through the
 * action-map. Registers the edit-buffer commands, suspends the textarea's built-in
 * key handling while it's focused, and installs the provided layer with the default
 * textarea bindings (plus any user-supplied `bindings` as overrides).
 *
 * Returns a single disposer that tears all three registrations down in the correct
 * order. Reference-counting in the underlying `registerEditBufferCommands` and
 * `registerTextareaMappingSuspension` calls makes it safe to use this alongside
 * those functions or alongside multiple managed layers on the same `ActionMap`.
 */
export function registerManagedTextareaLayer(
  manager: ActionMap,
  layer: ManagedTextareaLayer,
  options?: EditBufferCommandOptions,
): () => void {
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const offCommands = registerEditBufferCommands(manager, options)
  const offSuspension = registerTextareaMappingSuspension(manager)

  try {
    const { bindings, ...rest } = layer
    const offLayer = manager.registerLayer({
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
