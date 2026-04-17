import type { Renderable } from "../../Renderable.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import type { ActionMap } from "./action-map.js"

export type ActionMapEventData = Record<string, unknown>

export type ActionMapAttributes = Record<string, unknown>

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

export type ActionMapEventMatchResolver = (event: KeyEvent) => readonly string[] | undefined

export interface ParsedKeyToken {
  stroke: ParsedKeyStroke
  matchKey: string
}

export interface ParsedKeyPart {
  stroke: ParsedKeyStroke
  display: string
  matchKey: string
}

export interface ActionMapStringifyOptions {
  preferDisplay?: boolean
}

export type ActionMapStringifiableKey = ParsedKeyStroke | ParsedKeyPart | { stroke: ParsedKeyStroke; display?: string }

export type KeyLike = string | KeyStroke

export interface ActionMapBindingSyntax {
  normalizeTokenName(token: string): string
  parseObjectKey(key: KeyStroke): ParsedKeyPart
}

/**
 * Read-only view of a registered command. `fields` is raw registration
 * metadata; `attrs` is compiled command-field metadata.
 */
export interface ActionMapCommandRecord {
  name: string
  fields: Readonly<Record<string, unknown>>
  attrs?: Readonly<ActionMapAttributes>
}

export type ActionMapCommandQueryValue =
  | unknown
  | readonly unknown[]
  | ((value: unknown, command: ActionMapCommandRecord) => boolean)

export type ActionMapCommandFilter =
  | Readonly<Record<string, ActionMapCommandQueryValue>>
  | ((command: ActionMapCommandRecord) => boolean)

export interface ActionMapCommandQuery {
  namespace?: string | readonly string[]
  search?: string
  searchIn?: readonly string[]
  filter?: ActionMapCommandFilter
}

export interface ActionMapRunCommandOptions {
  event?: KeyEvent
  focused?: Renderable | null
  target?: Renderable | null
  includeCommand?: boolean
}

export type ActionMapRunCommandResult =
  | { ok: true; command?: ActionMapCommandRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid-args" | "rejected" | "error"; command?: ActionMapCommandRecord }

export interface ActionMapCommandContext {
  actionMap: ActionMap
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<ActionMapEventData>
  command?: ActionMapCommandRecord
}

export type ActionMapCommandResult = boolean | void | Promise<boolean | void>

export type ActionMapCommandHandler = (ctx: ActionMapCommandContext) => ActionMapCommandResult

export type ActionMapBindingCommand = string | ActionMapCommandHandler

export type ActionMapBindingEvent = "press" | "release"

export interface ActionMapBindingInput {
  key: KeyLike
  cmd?: ActionMapBindingCommand
  event?: ActionMapBindingEvent
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

export type ActionMapBindingShorthand = Record<string, ActionMapBindingCommand>

export type ActionMapBindings = ActionMapBindingInput[] | ActionMapBindingShorthand

export type ActionMapScope = "global" | "focus" | "focus-within"

export interface ActionMapLayerFields {
  priority?: number
  bindings: ActionMapBindings
  [key: string]: unknown
}

export interface ActionMapGlobalLayer extends ActionMapLayerFields {
  target?: undefined
  scope?: "global"
}

export interface ActionMapFocusWithinLayer extends ActionMapLayerFields {
  target: Renderable
  scope?: "focus-within"
}

export interface ActionMapFocusLayer extends ActionMapLayerFields {
  target: Renderable
  scope: "focus"
}

export type ActionMapTargetLayer = ActionMapFocusWithinLayer | ActionMapFocusLayer

export type ActionMapLayer = ActionMapGlobalLayer | ActionMapTargetLayer

export interface ActionMapParsedCommand {
  input: string
  name: string
  args: string[]
}

export interface ActionMapCommandResolverContext {
  getCommandAttrs(name: string): Readonly<ActionMapAttributes> | undefined
  getCommandRecord(name: string): ActionMapCommandRecord | undefined
}

/**
 * Resolver output. `run` executes the command, `attrs` / `record` expose
 * metadata, and `rejectedResult` overrides the default rejected result.
 */
export interface ActionMapResolvedBindingCommand {
  run: ActionMapCommandHandler
  attrs?: Readonly<ActionMapAttributes>
  record?: ActionMapCommandRecord
  rejectedResult?: Extract<ActionMapRunCommandResult, { ok: false }>
}

export type ActionMapCommandResolver = (
  command: string,
  ctx: ActionMapCommandResolverContext,
) => ActionMapResolvedBindingCommand | undefined

/**
 * Input to `registerCommands(...)`. Extra fields stay on `fields` and can be
 * compiled into `attrs` by command-field addons.
 */
export interface ActionMapCommandDefinition {
  name: string
  run: ActionMapCommandHandler
  [key: string]: unknown
}

export interface ActionMapToken {
  name: string
  key: KeyLike
}

export interface ActionMapActiveBinding {
  sequence: ParsedKeyPart[]
  command?: ActionMapBindingCommand
  commandAttrs?: Readonly<ActionMapAttributes>
  attrs?: Readonly<ActionMapAttributes>
  event: ActionMapBindingEvent
  preventDefault: boolean
  fallthrough: boolean
}

export interface ActionMapActiveKeyOptions {
  includeBindings?: boolean
  includeMetadata?: boolean
}

export interface ActionMapActiveKey {
  stroke: ParsedKeyStroke
  display: string
  bindings?: ActionMapActiveBinding[]
  bindingAttrs?: Readonly<ActionMapAttributes>
  commandAttrs?: Readonly<ActionMapAttributes>
  command?: ActionMapBindingCommand
  continues: boolean
}

/**
 * Boolean source with subscription-based invalidation. `ctx.match(...)`
 * subscribes at registration time and unsubscribes when the owning
 * layer or binding is removed.
 */
export interface ActionMapReactiveMatcher {
  get(): boolean
  subscribe(onChange: () => void): () => void
}

export interface ActionMapBindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Raw callbacks re-run on every read;
   * reactive matchers stay cached until they notify.
   */
  match(matcher: (() => boolean) | ActionMapReactiveMatcher): void
}

export type ActionMapBindingFieldCompiler = (value: unknown, ctx: ActionMapBindingFieldContext) => void

export interface ActionMapLayerFieldContext {
  require(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Raw callbacks re-run on every read;
   * reactive matchers stay cached until they notify.
   */
  match(matcher: (() => boolean) | ActionMapReactiveMatcher): void
}

export type ActionMapLayerFieldCompiler = (value: unknown, ctx: ActionMapLayerFieldContext) => void

export interface ActionMapBindingParserContext {
  input: string
  index: number
  layer: Readonly<Record<string, unknown>>
  tokens: ReadonlyMap<string, ParsedKeyToken>
}

export interface ActionMapBindingExpanderContext {
  input: string
  layer: Readonly<Record<string, unknown>>
}

export interface ActionMapBindingParserResult {
  parts: ParsedKeyPart[]
  nextIndex: number
  usedTokens?: readonly string[]
  unknownTokens?: readonly string[]
}

export type ActionMapBindingParser = (ctx: ActionMapBindingParserContext) => ActionMapBindingParserResult | undefined

export type ActionMapBindingExpander = (ctx: ActionMapBindingExpanderContext) => readonly string[] | undefined

export interface ActionMapParsedBindingInput {
  sequence: ParsedKeyPart[]
  cmd?: ActionMapBindingCommand
  event?: ActionMapBindingEvent
  preventDefault?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export interface ActionMapBindingCompilerContext {
  layer: Readonly<Record<string, unknown>>
  add(binding: ActionMapParsedBindingInput): void
  skipOriginal(): void
}

export type ActionMapBindingCompiler = (
  binding: ActionMapParsedBindingInput,
  ctx: ActionMapBindingCompilerContext,
) => void

export interface ActionMapCommandFieldContext {
  attr(name: string, value: unknown): void
}

export type ActionMapCommandFieldCompiler = (value: unknown, ctx: ActionMapCommandFieldContext) => void

export interface ActionMapKeyInputContext {
  event: KeyEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface ActionMapRawInputContext {
  sequence: string
  stop: () => void
}

export interface ActionMapUnresolvedCommandContext {
  command: string
  binding: ActionMapParsedBindingInput
  scope: ActionMapScope
  target?: Renderable
}

/**
 * Hooks exposed by `actionMap.hook(...)`. Use `state` for batched derived-
 * state re-reads, `pendingSequence` when you need synchronous sequence values,
 * and `unresolvedCommand` for one-time missing-command diagnostics.
 * `pendingSequence` fires before the batched `state` flush, so most consumers
 * should pick one or the other.
 */
export type ActionMapHooks = {
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
  unresolvedCommand: ActionMapUnresolvedCommandContext
}

export type ActionMapHookName = keyof ActionMapHooks

export type ActionMapHookListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

export interface ActionMapWarningEvent {
  message: string
}

export interface ActionMapErrorEvent {
  message: string
  cause?: unknown
}

export type ActionMapEvents = {
  warning: ActionMapWarningEvent
  error: ActionMapErrorEvent
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

export interface CompiledBinding extends ActionMapActiveBinding, RuntimeMatchable {
  run?: ActionMapCommandHandler
  activeBindingCacheVersion?: number
  activeBindingCache?: ActionMapActiveBinding
  sourceBinding: ActionMapParsedBindingInput
  sourceScope: ActionMapScope
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

export interface RegisteredCommand extends ActionMapCommandRecord {
  run: (ctx: ActionMapCommandContext) => ActionMapCommandResult
  runner?: ActionMapCommandHandler
  resolved?: ActionMapResolvedBindingCommand
  resolvedWithRecord?: ActionMapResolvedBindingCommand
  record?: ActionMapCommandRecord
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
  scope: ActionMapScope
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
  compileFields?: Readonly<Record<string, unknown>>
  bindingInputs: readonly ActionMapBindingInput[]
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
