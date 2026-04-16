import type { Renderable } from "../../Renderable.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import type { CliRenderer } from "../../renderer.js"
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

export interface ActionMapCommandInfo {
  name: string
  attrs?: Readonly<ActionMapAttributes>
}

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
  manager: ActionMap
  renderer: CliRenderer
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<ActionMapEventData>
  command?: ActionMapCommandInfo
}

export type ActionMapCommandResult = boolean | void | Promise<boolean | void>

export type ActionMapCommandHandler = (ctx: ActionMapCommandContext) => ActionMapCommandResult

export type ActionMapBindingCommand = string | ActionMapCommandHandler

export type ActionMapBindingEvent = "press" | "release"

export interface ActionMapBindingInput {
  key: KeyLike
  cmd?: ActionMapBindingCommand
  event?: ActionMapBindingEvent
  consume?: boolean
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

export interface ActionMapCommand {
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
  consume: boolean
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

export interface ActionMapBindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
}

export type ActionMapBindingFieldCompiler = (value: unknown, ctx: ActionMapBindingFieldContext) => void

export interface ActionMapLayerFieldContext {
  require(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
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
  consume?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export interface ActionMapBindingCompilerContext {
  layer: Readonly<Record<string, unknown>>
  add(binding: ActionMapParsedBindingInput): void
  skipOriginal(): void
}

export type ActionMapBindingCompiler = (binding: ActionMapParsedBindingInput, ctx: ActionMapBindingCompilerContext) => void

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
 * Events exposed through `ActionMap.hook(name, fn)`.
 *
 * These three hooks target different audiences and have different delivery
 * semantics. In general:
 *
 * - Framework adapters (React/Solid) that re-read through getters like
 *   `getActiveKeys()` or `getPendingSequenceParts()` should subscribe to
 *   `state` and ignore the other two. `state` is a superset signal that fires
 *   whenever any of the derived caches could have changed, and it is batched,
 *   so one user action yields at most one listener call.
 *
 * - Addons or integrations that need the pending sequence value synchronously
 *   (for example, `registerTimedLeader`) should subscribe to `pendingSequence`.
 *   It delivers the value directly without a getter read, and fires inline
 *   (not batched) so observers see each transition.
 *
 * - `unresolvedCommand` is a compile-time diagnostic, not a runtime event; it
 *   fires at most once per binding site, when a bound command name has no
 *   matching registration.
 *
 * Note that `state` and `pendingSequence` are not synchronized: subscribers to
 * `pendingSequence` fire before the pending `state` flush, and subscribers to
 * `state` do not receive the new sequence as a payload. Pick whichever matches
 * your need; subscribing to both would cause duplicate work.
 */
export type ActionMapHooks = {
  /**
   * Fires when any derived state may have changed (layers, commands, tokens,
   * data, runtime keys, focus, or pending sequence). Batched: at most one
   * emission per synchronous action. No payload; listeners should re-read
   * whatever they care about through the relevant getter. This is the hook
   * framework adapters should use.
   */
  state: void
  /**
   * Fires when the pending multi-key sequence pointer changes, including when
   * it is cleared. Payload is the current sequence (empty array when cleared).
   * Fires inline, not batched. Use this when you need the sequence value
   * synchronously without going back through the manager.
   */
  pendingSequence: readonly ParsedKeyStroke[]
  /**
   * Fires at most once per binding site when a binding references a command
   * name that no registered command or command resolver provides. Intended
   * for diagnostics (logging, dev-mode warnings). The binding is kept but
   * will never run until the referenced command becomes resolvable.
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
  keys: readonly string[]
}

export interface RuntimeMatchable {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
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
  commandInfo?: ActionMapCommandInfo
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
