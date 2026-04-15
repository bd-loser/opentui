import { keyBindingToString } from "../../../lib/keymapping.js"
import { CliRenderEvents } from "../../../renderer.js"
import { InputRenderable } from "../../../renderables/Input.js"
import { TextareaRenderable, defaultTextareaKeyBindings, type TextareaAction } from "../../../renderables/Textarea.js"
import type { EditBufferRenderable } from "../../../renderables/EditBufferRenderable.js"
import type {
  KeymapBindingInput,
  KeymapBindings,
  KeymapCommand,
  KeymapCommandContext,
  KeymapFocusLayer,
  KeymapFocusWithinLayer,
  KeymapGlobalLayer,
  KeymapManager,
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

type EditBufferCommandName = (typeof editBufferCommandNames)[number]

const editBufferCommandRegistrations = new WeakMap<KeymapManager, { count: number; dispose: () => void }>()
const textareaMappingSuspensionRegistrations = new WeakMap<KeymapManager, { count: number; dispose: () => void }>()

export type ManagedTextareaLayer =
  | (Omit<KeymapGlobalLayer, "bindings"> & { bindings?: KeymapBindings })
  | (Omit<KeymapFocusLayer, "bindings"> & { bindings?: KeymapBindings })
  | (Omit<KeymapFocusWithinLayer, "bindings"> & { bindings?: KeymapBindings })

function isManagedTextarea(editor: EditBufferRenderable | null): editor is TextareaRenderable {
  return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
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

function createDefaultTextareaBindings(): KeymapBindingInput[] {
  return defaultTextareaKeyBindings.map((binding) => ({
    key: keyBindingToString(binding),
    cmd: binding.action,
  }))
}

export function createTextareaKeymap(overrides?: KeymapBindings): KeymapBindingInput[] {
  const overrideBindings = overrides ? snapshotBindingInputs(overrides) : []
  return [...overrideBindings, ...createDefaultTextareaBindings()]
}

export function registerTextareaMappingSuspension(manager: KeymapManager): () => void {
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

function withFocusedEditor(ctx: KeymapCommandContext, run: (editor: EditBufferRenderable) => boolean): boolean {
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
): KeymapCommand {
  return {
    name,
    run(ctx) {
      return withFocusedEditor(ctx, run)
    },
  }
}

function createEditBufferCommands(): KeymapCommand[] {
  return [
    createEditBufferCommand("move-left", (editor) => editor.moveCursorLeft()),
    createEditBufferCommand("move-right", (editor) => editor.moveCursorRight()),
    createEditBufferCommand("move-up", (editor) => editor.moveCursorUp()),
    createEditBufferCommand("move-down", (editor) => editor.moveCursorDown()),
    createEditBufferCommand("select-left", (editor) => editor.moveCursorLeft({ select: true })),
    createEditBufferCommand("select-right", (editor) => editor.moveCursorRight({ select: true })),
    createEditBufferCommand("select-up", (editor) => editor.moveCursorUp({ select: true })),
    createEditBufferCommand("select-down", (editor) => editor.moveCursorDown({ select: true })),
    createEditBufferCommand("line-home", (editor) => editor.gotoLineHome()),
    createEditBufferCommand("line-end", (editor) => editor.gotoLineEnd()),
    createEditBufferCommand("select-line-home", (editor) => editor.gotoLineHome({ select: true })),
    createEditBufferCommand("select-line-end", (editor) => editor.gotoLineEnd({ select: true })),
    createEditBufferCommand("visual-line-home", (editor) => editor.gotoVisualLineHome()),
    createEditBufferCommand("visual-line-end", (editor) => editor.gotoVisualLineEnd()),
    createEditBufferCommand("select-visual-line-home", (editor) => editor.gotoVisualLineHome({ select: true })),
    createEditBufferCommand("select-visual-line-end", (editor) => editor.gotoVisualLineEnd({ select: true })),
    createEditBufferCommand("buffer-home", (editor) => editor.gotoBufferHome()),
    createEditBufferCommand("buffer-end", (editor) => editor.gotoBufferEnd()),
    createEditBufferCommand("select-buffer-home", (editor) => editor.gotoBufferHome({ select: true })),
    createEditBufferCommand("select-buffer-end", (editor) => editor.gotoBufferEnd({ select: true })),
    createEditBufferCommand("delete-line", (editor) => editor.deleteLine()),
    createEditBufferCommand("delete-to-line-end", (editor) => editor.deleteToLineEnd()),
    createEditBufferCommand("delete-to-line-start", (editor) => editor.deleteToLineStart()),
    createEditBufferCommand("backspace", (editor) => editor.deleteCharBackward()),
    createEditBufferCommand("delete", (editor) => editor.deleteChar()),
    createEditBufferCommand("newline", (editor) => editor.newLine()),
    createEditBufferCommand("undo", (editor) => editor.undo()),
    createEditBufferCommand("redo", (editor) => editor.redo()),
    createEditBufferCommand("word-forward", (editor) => editor.moveWordForward()),
    createEditBufferCommand("word-backward", (editor) => editor.moveWordBackward()),
    createEditBufferCommand("select-word-forward", (editor) => editor.moveWordForward({ select: true })),
    createEditBufferCommand("select-word-backward", (editor) => editor.moveWordBackward({ select: true })),
    createEditBufferCommand("delete-word-forward", (editor) => editor.deleteWordForward()),
    createEditBufferCommand("delete-word-backward", (editor) => editor.deleteWordBackward()),
    createEditBufferCommand("select-all", (editor) => editor.selectAll()),
    createEditBufferCommand("submit", (editor) => {
      if (!hasSubmit(editor)) {
        return false
      }

      return editor.submit()
    }),
  ]
}

export function registerEditBufferCommands(manager: KeymapManager): () => void {
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

  const dispose = manager.registerCommands(createEditBufferCommands())
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

export function registerManagedTextareaLayer(manager: KeymapManager, layer: ManagedTextareaLayer): () => void {
  const offCommands = registerEditBufferCommands(manager)
  const offSuspension = registerTextareaMappingSuspension(manager)

  try {
    const { bindings, ...rest } = layer
    const offLayer = manager.registerLayer({
      ...rest,
      bindings: createTextareaKeymap(bindings),
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
