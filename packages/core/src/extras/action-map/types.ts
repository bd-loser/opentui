import type { Renderable } from "../../Renderable.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import type { ActionMap } from "./action-map.js"

export type EventData = Record<string, unknown>

export type Attributes = Record<string, unknown>

export interface KeyStroke {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  hyper?: boolean
}

export interface ParsedKeyStroke extends KeyStroke {
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export interface EventMatchResolverContext {
  matchKey(key: KeyLike): string
}

export type EventMatchResolver = (event: KeyEvent, ctx: EventMatchResolverContext) => readonly string[] | undefined

export interface ParsedKeyToken {
  stroke: ParsedKeyStroke
  matchKey: string
}

export interface ParsedKeyPart {
  stroke: ParsedKeyStroke
  display: string
  matchKey: string
}

export interface StringifyOptions {
  preferDisplay?: boolean
}

export type StringifiableKey = ParsedKeyStroke | ParsedKeyPart | { stroke: ParsedKeyStroke; display?: string }

export type KeyLike = string | KeyStroke

export interface BindingSyntax {
  normalizeTokenName(token: string): string
  parseObjectKey(key: KeyStroke): ParsedKeyPart
}

/**
 * Read-only view of a registered command. `fields` is raw registration
 * metadata; `attrs` is compiled command-field metadata.
 */
export interface CommandRecord {
  name: string
  fields: Readonly<Record<string, unknown>>
  attrs?: Readonly<Attributes>
}

export type CommandQueryValue = unknown | readonly unknown[] | ((value: unknown, command: CommandRecord) => boolean)

export type CommandFilter = Readonly<Record<string, CommandQueryValue>> | ((command: CommandRecord) => boolean)

export interface CommandQuery {
  namespace?: string | readonly string[]
  search?: string
  searchIn?: readonly string[]
  filter?: CommandFilter
}

export interface RunCommandOptions {
  event?: KeyEvent
  focused?: Renderable | null
  target?: Renderable | null
  includeCommand?: boolean
}

export type RunCommandResult =
  | { ok: true; command?: CommandRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid-args" | "rejected" | "error"; command?: CommandRecord }

export interface CommandContext {
  actionMap: ActionMap
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<EventData>
  command?: CommandRecord
}

export type CommandResult = boolean | void | Promise<boolean | void>

export type CommandHandler = (ctx: CommandContext) => CommandResult

export type BindingCommand = string | CommandHandler

export type BindingEvent = "press" | "release"

export interface BindingInput {
  key: KeyLike
  cmd?: BindingCommand
  event?: BindingEvent
  /**
   * Default `true`. Calls `event.preventDefault()` and
   * `event.stopPropagation()` so the matched key does not reach the focused
   * renderable or later `renderer.keyInput` listeners. Independent of
   * `fallthrough`, which only controls dispatch inside the action-map.
   */
  preventDefault?: boolean
  /**
   * Default `false`. Continues to later matching bindings in the same
   * dispatch chain after this command runs. Independent of `preventDefault`,
   * which controls whether the key event leaves the action-map.
   */
  fallthrough?: boolean
  [key: string]: unknown
}

export type BindingShorthand = Record<string, BindingCommand>

export type Bindings = BindingInput[] | BindingShorthand

export type Scope = "global" | "focus" | "focus-within"

export interface LayerFields {
  priority?: number
  bindings: Bindings
  [key: string]: unknown
}

export interface GlobalLayer extends LayerFields {
  target?: undefined
  scope?: "global"
}

export interface FocusWithinLayer extends LayerFields {
  target: Renderable
  scope?: "focus-within"
}

export interface FocusLayer extends LayerFields {
  target: Renderable
  scope: "focus"
}

export type TargetLayer = FocusWithinLayer | FocusLayer

export type Layer = GlobalLayer | TargetLayer

export interface ParsedCommand {
  input: string
  name: string
  args: string[]
}

export interface CommandResolverContext {
  getCommandAttrs(name: string): Readonly<Attributes> | undefined
  getCommandRecord(name: string): CommandRecord | undefined
}

/**
 * Resolver output. `run` executes the command, `attrs` / `record` expose
 * metadata, and `rejectedResult` overrides the default rejected result.
 */
export interface ResolvedBindingCommand {
  run: CommandHandler
  attrs?: Readonly<Attributes>
  record?: CommandRecord
  rejectedResult?: Extract<RunCommandResult, { ok: false }>
}

export type CommandResolver = (command: string, ctx: CommandResolverContext) => ResolvedBindingCommand | undefined

/**
 * Input to `registerCommands(...)`. Extra fields stay on `fields` and can be
 * compiled into `attrs` by command-field addons.
 */
export interface CommandDefinition {
  name: string
  run: CommandHandler
  [key: string]: unknown
}

export interface Token {
  name: string
  key: KeyLike
}

export interface ActiveBinding {
  sequence: ParsedKeyPart[]
  command?: BindingCommand
  commandAttrs?: Readonly<Attributes>
  attrs?: Readonly<Attributes>
  event: BindingEvent
  preventDefault: boolean
  fallthrough: boolean
}

export interface ActiveKeyOptions {
  includeBindings?: boolean
  includeMetadata?: boolean
}

export interface ActiveKey {
  stroke: ParsedKeyStroke
  display: string
  bindings?: ActiveBinding[]
  bindingAttrs?: Readonly<Attributes>
  commandAttrs?: Readonly<Attributes>
  command?: BindingCommand
  continues: boolean
}

/**
 * Boolean source with subscription-based invalidation. `ctx.match(...)`
 * subscribes at registration time and unsubscribes when the owning
 * layer or binding is removed.
 */
export interface ReactiveMatcher {
  get(): boolean
  subscribe(onChange: () => void): () => void
}

export interface BindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Raw callbacks re-run on every read;
   * reactive matchers stay cached until they notify.
   */
  match(matcher: (() => boolean) | ReactiveMatcher): void
}

export type BindingFieldCompiler = (value: unknown, ctx: BindingFieldContext) => void

export interface LayerFieldContext {
  require(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Raw callbacks re-run on every read;
   * reactive matchers stay cached until they notify.
   */
  match(matcher: (() => boolean) | ReactiveMatcher): void
}

export type LayerFieldCompiler = (value: unknown, ctx: LayerFieldContext) => void

export interface BindingParserContext {
  input: string
  index: number
  layer: Readonly<Record<string, unknown>>
  tokens: ReadonlyMap<string, ParsedKeyToken>
  parseObjectKey(key: KeyStroke): ParsedKeyPart
}

export interface BindingExpanderContext {
  input: string
  layer: Readonly<Record<string, unknown>>
}

export interface BindingParserResult {
  parts: ParsedKeyPart[]
  nextIndex: number
  usedTokens?: readonly string[]
  unknownTokens?: readonly string[]
}

export type BindingParser = (ctx: BindingParserContext) => BindingParserResult | undefined

export type BindingExpander = (ctx: BindingExpanderContext) => readonly string[] | undefined

export interface ParsedBindingInput {
  sequence: ParsedKeyPart[]
  cmd?: BindingCommand
  event?: BindingEvent
  preventDefault?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export interface BindingTransformerContext {
  layer: Readonly<Record<string, unknown>>
  parseKey(key: KeyLike): ParsedKeyPart
  add(binding: ParsedBindingInput): void
  skipOriginal(): void
}

export type BindingTransformer = (binding: ParsedBindingInput, ctx: BindingTransformerContext) => void

export interface CommandFieldContext {
  attr(name: string, value: unknown): void
}

export type CommandFieldCompiler = (value: unknown, ctx: CommandFieldContext) => void

export interface KeyInputContext {
  event: KeyEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface RawInputContext {
  sequence: string
  stop: () => void
}

export interface UnresolvedCommandContext {
  command: string
  binding: ParsedBindingInput
  scope: Scope
  target?: Renderable
}

/**
 * Hooks exposed by `actionMap.hook(...)`. Use `state` for batched derived-
 * state re-reads, `pendingSequence` when you need synchronous sequence values,
 * and `unresolvedCommand` for one-time missing-command diagnostics.
 * `pendingSequence` fires before the batched `state` flush, so most consumers
 * should pick one or the other.
 */
export type Hooks = {
  /**
   * Batched "derived state may have changed" signal. Re-read through getters;
   * framework adapters should use this hook.
   */
  state: void
  /**
   * Synchronous pending-sequence updates, including clear. Payload is the
   * current sequence.
   */
  pendingSequence: readonly ParsedKeyStroke[]
  /**
   * One-time diagnostic when a binding references a command name that is not
   * currently resolvable.
   */
  unresolvedCommand: UnresolvedCommandContext
}

export type HookName = keyof Hooks

export type HookListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

export interface WarningEvent {
  message: string
}

export interface ErrorEvent {
  message: string
  cause?: unknown
}

export type Events = {
  warning: WarningEvent
  error: ErrorEvent
}

export type { ActionMap }

export interface RuntimeMatcher {
  source: string
  match: () => boolean
  /**
   * False for raw callbacks with no subscription or data dependency, so the
   * owner must re-evaluate on every read.
   */
  cacheable: boolean
  /**
   * Present for reactive matchers; wired during registration and torn down via
   * `dispose`.
   */
  subscribe?: (onChange: () => void) => () => void
  dispose?: () => void
}

export interface RuntimeMatchable {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  /** Data keys referenced via `require(...)`; used for `setData` invalidation. */
  conditionKeys: readonly string[]
  /** True when any matcher is a raw callback and therefore cannot be cached. */
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
}

export interface CompiledBinding extends ActiveBinding, RuntimeMatchable {
  run?: CommandHandler
  activeBindingCacheVersion?: number
  activeBindingCache?: ActiveBinding
  sourceBinding: ParsedBindingInput
  sourceScope: Scope
  sourceTarget?: Renderable
  sourceLayerOrder: number
  sourceBindingIndex: number
}

export interface ActiveKeySelection {
  display: string
  continues: boolean
  firstBinding?: CompiledBinding
  commandBinding?: CompiledBinding
  bindings?: readonly CompiledBinding[]
  stop: boolean
}

export interface ActiveKeyState {
  stroke: ParsedKeyStroke
  display: string
  continues: boolean
  firstBinding?: CompiledBinding
  commandBinding?: CompiledBinding
  bindings?: CompiledBinding[]
}

export interface RegisteredCommand extends CommandRecord {
  run: (ctx: CommandContext) => CommandResult
  runner?: CommandHandler
  resolved?: ResolvedBindingCommand
  resolvedWithRecord?: ResolvedBindingCommand
  record?: CommandRecord
}

export interface CompiledBindingsResult {
  root: SequenceNode
  bindings: readonly CompiledBinding[]
  hasTokenBindings: boolean
}

export interface SequenceNode {
  parent: SequenceNode | null
  depth: number
  stroke: ParsedKeyStroke | null
  matchKey: string | null
  children: Map<string, SequenceNode>
  bindings: CompiledBinding[]
  reachableBindings: CompiledBinding[]
}

export interface RegisteredLayer {
  order: number
  target?: Renderable
  scope: Scope
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
  compileFields?: Readonly<Record<string, unknown>>
  bindingInputs: readonly BindingInput[]
  compiledBindings: readonly CompiledBinding[]
  hasUnkeyedBindings: boolean
  hasTokenBindings: boolean
  root: SequenceNode
  offTargetDestroy?: () => void
  bucket?: RegisteredLayerBucket
}

export interface RegisteredLayerBucket {
  focusLayers: RegisteredLayer[]
  focusWithinLayers: RegisteredLayer[]
}

export interface PendingSequenceState {
  layer: RegisteredLayer
  node: SequenceNode
}
