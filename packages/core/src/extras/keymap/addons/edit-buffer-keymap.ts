import type { EditBufferRenderable } from "../../../renderables/EditBufferRenderable.js"
import type { KeyBinding as EditBufferKeyBinding, TextareaAction } from "../../../renderables/Textarea.js"
import {
  RESERVED_BINDING_FIELDS,
  type KeymapBindings,
  type KeymapCommand,
  type KeymapCommandContext,
  type KeymapLayer,
  type KeymapManager,
} from "../core.js"
import { normalizeBindingInputs, parseCommandInput, parseKeySequenceLike } from "../utils.js"

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

function ensureEditBufferCommandsRegistered(manager: KeymapManager): () => void {
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

const editBufferCommandNameSet = new Set<string>(editBufferCommandNames)

function validateEditBufferCommandInput(input: string): void {
  const command = parseCommandInput(input)
  if (command.args.length > 0) {
    throw new Error(`Edit-buffer command "${input}" cannot include arguments`)
  }

  if (!editBufferCommandNameSet.has(command.name)) {
    throw new Error(`Unknown edit-buffer command "${command.name}"`)
  }
}

function validateEditBufferKeymapBindings(bindings: KeymapBindings): void {
  for (const binding of normalizeBindingInputs(bindings)) {
    validateEditBufferCommandInput(binding.cmd)
  }
}

export function registerEditBufferKeymap(manager: KeymapManager, layer: KeymapLayer): () => void {
  validateEditBufferKeymapBindings(layer.bindings)

  const offLayer = manager.registerLayer(layer)
  let offCommands: (() => void) | undefined

  try {
    offCommands = ensureEditBufferCommandsRegistered(manager)
  } catch (error) {
    offLayer()
    throw error
  }

  return () => {
    offLayer()
    offCommands?.()
  }
}

export function compileEditBufferKeyBindings(bindings: KeymapBindings): EditBufferKeyBinding[] {
  return normalizeBindingInputs(bindings).map((binding) => {
    for (const [fieldName, value] of Object.entries(binding)) {
      if (RESERVED_BINDING_FIELDS.has(fieldName)) {
        continue
      }

      if (value === undefined) {
        continue
      }

      throw new Error(`Edit-buffer key bindings do not support the extra field "${fieldName}"`)
    }

    const parts = parseKeySequenceLike(binding.key, new Map())
    if (parts.length !== 1) {
      throw new Error("Edit-buffer key bindings only support a single key stroke")
    }

    const [part] = parts
    if (!part) {
      throw new Error("Edit-buffer key bindings only support a single key stroke")
    }

    validateEditBufferCommandInput(binding.cmd)
    const command = parseCommandInput(binding.cmd)

    return {
      name: part.stroke.name,
      ctrl: part.stroke.ctrl || undefined,
      shift: part.stroke.shift || undefined,
      meta: part.stroke.meta || undefined,
      super: part.stroke.super || undefined,
      action: command.name as TextareaAction,
    }
  })
}
