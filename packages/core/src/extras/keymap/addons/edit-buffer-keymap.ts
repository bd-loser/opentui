import type { KeyBinding as EditBufferKeyBinding, TextareaAction } from "../../../renderables/Textarea.js"
import {
  normalizeBindingInputs,
  parseCommandInput,
  parseKeySequenceLike,
  RESERVED_BINDING_FIELDS,
  type KeymapBindings,
  type KeymapLayer,
  type KeymapManager,
} from "../core.js"
import { editBufferCommandNames, registerEditBufferCommands } from "./edit-buffer-commands.js"

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
    offCommands = registerEditBufferCommands(manager)
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
