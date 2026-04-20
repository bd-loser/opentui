import type {
  Attributes,
  BindingCommand,
  BindingInput,
  Bindings,
  CommandContext,
  CommandHandler,
  CommandRecord,
  EventData,
  KeymapEvent,
  KeyStrokeInput,
  KeySequencePart,
  ParsedBindingInput,
  NormalizedKeyStroke,
  RegisteredCommand,
  ResolvedBindingCommand,
  SequenceNode,
  KeyStringifyInput,
  StringifyOptions,
} from "../types.js"

export interface SnapshotDataValueOptions {
  deep?: boolean
  freeze?: boolean
  preserveNonPlainObjects?: boolean
}

export const SNAPSHOT_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  preserveNonPlainObjects: true,
} satisfies SnapshotDataValueOptions)

export const SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  freeze: true,
  preserveNonPlainObjects: true,
} satisfies SnapshotDataValueOptions)

export const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

export function normalizeKeyName(name: string): string {
  if (name === " ") {
    return "space"
  }

  let next = name.trim()
  if (!next) {
    throw new Error("Invalid key name: key name cannot be empty")
  }

  next = next.toLowerCase()

  return next
}

export function snapshotStroke(stroke: NormalizedKeyStroke): NormalizedKeyStroke {
  return {
    name: stroke.name,
    ctrl: stroke.ctrl,
    shift: stroke.shift,
    meta: stroke.meta,
    super: stroke.super,
    hyper: stroke.hyper || undefined,
  }
}

export function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (!value) {
    return false
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return false
  }

  return typeof (value as { then?: unknown }).then === "function"
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// This is intentionally narrower than `structuredClone(...)`: some keymap
// metadata needs to preserve opaque values such as functions or class instances.
export function snapshotDataValue(value: unknown, options?: SnapshotDataValueOptions): unknown {
  const deep = options?.deep === true
  const freeze = options?.freeze === true
  const preserveNonPlainObjects = options?.preserveNonPlainObjects === true

  if (Array.isArray(value)) {
    const cloned = deep ? value.map((entry) => snapshotDataValue(entry, options)) : [...value]
    return freeze ? Object.freeze(cloned) : cloned
  }

  if (value && typeof value === "object") {
    if (preserveNonPlainObjects && !isPlainObject(value)) {
      return value
    }

    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = deep ? snapshotDataValue(entry, options) : entry
    }

    return freeze ? Object.freeze(cloned) : cloned
  }

  return value
}

export function sortByPriorityAndOrder<T extends { priority: number; order: number }>(
  items: T[],
  options?: { order?: "asc" | "desc" },
): T[] {
  const orderDirection = options?.order ?? "asc"

  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return orderDirection === "desc" ? b.order - a.order : a.order - b.order
  })
}

export function buildBindingKey(stroke: NormalizedKeyStroke): string {
  return `${stroke.name}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.super ? 1 : 0}:${stroke.hyper ? 1 : 0}`
}

export function createSequenceNode<TTarget extends object, TEvent extends KeymapEvent>(
  parent: SequenceNode<TTarget, TEvent> | null,
  stroke: NormalizedKeyStroke | null,
  matchKey: string | null,
): SequenceNode<TTarget, TEvent> {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
    matchKey,
    children: new Map(),
    bindings: [],
    reachableBindings: [],
  }
}

export function mergeRequirement(target: EventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

export function mergeAttribute(target: Attributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
}

export function snapshotAttributes(attrs: Attributes): Readonly<Attributes> | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined
  }

  return snapshotDataValue(attrs, { freeze: true }) as Readonly<Attributes>
}

export function snapshotBindingInput<TTarget extends object, TEvent extends KeymapEvent>(
  binding: BindingInput<TTarget, TEvent>,
): BindingInput<TTarget, TEvent> {
  return {
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }
}

export function snapshotParsedBindingInput<TTarget extends object, TEvent extends KeymapEvent>(
  binding: ParsedBindingInput<TTarget, TEvent>,
): ParsedBindingInput<TTarget, TEvent> {
  return {
    ...binding,
    sequence: binding.sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
  }
}

export function normalizeBindingCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: BindingCommand<TTarget, TEvent> | undefined,
): BindingCommand<TTarget, TEvent> | undefined {
  if (command === undefined || typeof command === "function") {
    return command
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  return trimmed
}

export function snapshotBindingInputs<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: Bindings<TTarget, TEvent>,
): BindingInput<TTarget, TEvent>[] {
  return normalizeBindingInputs(bindings).map((binding) => snapshotBindingInput(binding))
}

function hasDisplayStroke(
  input: KeyStringifyInput,
): input is KeySequencePart | { stroke: NormalizedKeyStroke; display?: string } {
  return "stroke" in input
}

function stringifyCanonicalStroke(stroke: NormalizedKeyStroke): string {
  const parts: string[] = []
  if (stroke.ctrl) {
    parts.push("ctrl")
  }

  if (stroke.shift) {
    parts.push("shift")
  }

  if (stroke.meta) {
    parts.push("meta")
  }

  if (stroke.super) {
    parts.push("super")
  }

  if (stroke.hyper) {
    parts.push("hyper")
  }

  parts.push(stroke.name === "return" ? "enter" : stroke.name)
  return parts.join("+")
}

export function createParsedKeyPart(
  stroke: NormalizedKeyStroke,
  display = stringifyCanonicalStroke(stroke),
  matchKey?: string,
): KeySequencePart {
  const cloned = snapshotStroke(stroke)

  return {
    stroke: cloned,
    display,
    matchKey: matchKey ?? buildBindingKey(cloned),
  }
}

export function stringifyKeyStroke(input: KeyStringifyInput, options?: StringifyOptions): string {
  if (hasDisplayStroke(input)) {
    if (options?.preferDisplay && input.display) {
      return input.display
    }

    return stringifyCanonicalStroke(input.stroke)
  }

  return stringifyCanonicalStroke(normalizeKeyStroke(input))
}

export function stringifyKeySequence(input: readonly KeyStringifyInput[], options?: StringifyOptions): string {
  return input.map((part) => stringifyKeyStroke(part, options)).join("")
}

export function normalizeKeyStroke(input: KeyStrokeInput): NormalizedKeyStroke {
  return {
    name: normalizeKeyName(input.name),
    ctrl: input.ctrl ?? false,
    shift: input.shift ?? false,
    meta: input.meta ?? false,
    super: input.super ?? false,
    hyper: input.hyper || undefined,
  }
}

export function normalizeEventKeyStroke(event: KeymapEvent): NormalizedKeyStroke {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
    hyper: event.hyper || undefined,
  }
}

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command name: name cannot be empty")
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}

export function getRegisteredCommandRecord<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
): CommandRecord {
  if (command.record) {
    return command.record
  }

  let fields = EMPTY_COMMAND_FIELDS
  if (command.fields !== EMPTY_COMMAND_FIELDS && Object.keys(command.fields).length > 0) {
    fields = snapshotDataValue(command.fields, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<
      Record<string, unknown>
    >
  }

  const record = command.attrs
    ? Object.freeze({
        name: command.name,
        fields,
        attrs: snapshotDataValue(command.attrs, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<Attributes>,
      })
    : Object.freeze({
        name: command.name,
        fields,
      })

  command.record = record
  return record
}

export function resolveRegisteredCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  options?: { includeRecord?: boolean },
): ResolvedBindingCommand<TTarget, TEvent> {
  const includeRecord = options?.includeRecord === true
  if (includeRecord) {
    const existing = command.resolvedWithRecord
    if (existing) {
      return existing
    }

      const resolved: ResolvedBindingCommand<TTarget, TEvent> = {
      run: createRegisteredCommandRunner(command),
    }

    if (command.attrs) {
      resolved.attrs = command.attrs
    }

    resolved.record = getRegisteredCommandRecord(command)
    command.resolvedWithRecord = resolved
    return resolved
  }

  const existing = command.resolved
  if (existing) {
    return existing
  }

  const resolved: ResolvedBindingCommand<TTarget, TEvent> = {
    run: createRegisteredCommandRunner(command),
  }

  if (command.attrs) {
    resolved.attrs = command.attrs
  }

  command.resolved = resolved
  return resolved
}

export function normalizeBindingInputs<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: Bindings<TTarget, TEvent>,
): BindingInput<TTarget, TEvent>[] {
  if (Array.isArray(bindings)) {
    return bindings
  }

  const normalized: BindingInput<TTarget, TEvent>[] = []
  for (const [key, cmd] of Object.entries(bindings)) {
    if (typeof cmd !== "string" && typeof cmd !== "function") {
      throw new Error(`Invalid keymap binding for "${key}": shorthand bindings must map to string or function commands`)
    }

    normalized.push({ key, cmd })
  }

  return normalized
}

function createRegisteredCommandRunner<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
): CommandHandler<TTarget, TEvent> {
  if (command.runner) {
    return command.runner
  }

  const runner: CommandHandler<TTarget, TEvent> = (ctx: CommandContext<TTarget, TEvent>) => {
    return command.run({
      ...ctx,
      command: getRegisteredCommandRecord(command),
    })
  }

  command.runner = runner
  return runner
}
