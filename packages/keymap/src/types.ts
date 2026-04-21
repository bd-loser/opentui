import type { Keymap } from "./keymap.js"

export interface KeymapEvent {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super?: boolean
  hyper?: boolean
  preventDefault(): void
  stopPropagation(): void
  readonly propagationStopped: boolean
}

export interface KeymapHost<TTarget extends object, TEvent extends KeymapEvent = KeymapEvent> {
  readonly rootTarget: TTarget
  readonly isDestroyed: boolean
  getFocusedTarget(): TTarget | null
  getParentTarget(target: TTarget): TTarget | null
  isTargetDestroyed(target: TTarget): boolean
  onKeyPress(listener: (event: TEvent) => void): () => void
  onKeyRelease(listener: (event: TEvent) => void): () => void
  onFocusChange(listener: (target: TTarget | null) => void): () => void
  /** Optional for hosts whose lifetime is managed by GC or root reachability. */
  onDestroy?(listener: () => void): () => void
  onTargetDestroy(target: TTarget, listener: () => void): () => void
  onRawInput?(listener: (sequence: string) => boolean): () => void
  createCommandEvent(): TEvent
}

export type EventData = Record<string, unknown>

export type Attributes = Record<string, unknown>

export interface KeyStrokeInput {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  hyper?: boolean
}

export interface NormalizedKeyStroke extends KeyStrokeInput {
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type KeyMatch = symbol

export interface EventMatchResolverContext {
  resolveKey(key: KeyLike): KeyMatch
}

export type EventMatchResolver<TEvent extends KeymapEvent = KeymapEvent> = (
  event: TEvent,
  ctx: EventMatchResolverContext,
) => readonly KeyMatch[] | undefined

export interface ResolvedKeyToken {
  stroke: NormalizedKeyStroke
  match: KeyMatch
}

export interface KeySequencePart {
  stroke: NormalizedKeyStroke
  display: string
  match: KeyMatch
}

export interface StringifyOptions {
  preferDisplay?: boolean
}

export type KeyStringifyInput =
  | KeyStrokeInput
  | NormalizedKeyStroke
  | KeySequencePart
  | { stroke: NormalizedKeyStroke; display?: string }

export type KeyLike = string | KeyStrokeInput

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

export interface CommandQuery<TTarget extends object = object> {
  visibility?: "reachable" | "active" | "registered"
  focused?: TTarget | null
  namespace?: string | readonly string[]
  search?: string
  searchIn?: readonly string[]
  filter?: CommandFilter
}

export interface RunCommandOptions<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  event?: TEvent
  focused?: TTarget | null
  target?: TTarget | null
  includeCommand?: boolean
}

export type RunCommandResult =
  | { ok: true; command?: CommandRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid-args" | "rejected" | "error"; command?: CommandRecord }

export interface CommandContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  keymap: Keymap<TTarget, TEvent>
  event: TEvent
  focused: TTarget | null
  target: TTarget | null
  data: Readonly<EventData>
  command?: CommandRecord
}

export type CommandResult = boolean | void | Promise<boolean | void>

export type CommandResolutionStatus = "resolved" | "unresolved" | "error"

export type CommandHandler<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  ctx: CommandContext<TTarget, TEvent>,
) => CommandResult

export type BindingCommand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | string
  | CommandHandler<TTarget, TEvent>

export type BindingEvent = "press" | "release"

export interface BindingInput<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  key: KeyLike
  cmd?: BindingCommand<TTarget, TEvent>
  event?: BindingEvent
  /**
   * Default `true`. Calls `event.preventDefault()` and
   * `event.stopPropagation()` so the matched key does not reach the focused
   * target or later host listeners. Independent of `fallthrough`, which only
   * controls dispatch inside the keymap. Set `preventDefault: false` if you
   * want a fallthrough binding to keep matching inside the keymap and still let
   * the key escape to later handlers.
   */
  preventDefault?: boolean
  /**
   * Default `false`. Continues to later matching bindings in the same
   * dispatch chain after this command runs. Independent of `preventDefault`,
   * which controls whether the key event leaves the keymap.
   */
  fallthrough?: boolean
  [key: string]: unknown
}

export type BindingShorthand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = Record<
  string,
  BindingCommand<TTarget, TEvent>
>

export type Bindings<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | BindingInput<TTarget, TEvent>[]
  | BindingShorthand<TTarget, TEvent>

export type Scope = "global" | "focus" | "focus-within"

export interface LayerFields<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  priority?: number
  bindings?: Bindings<TTarget, TEvent>
  commands?: readonly CommandDefinition<TTarget, TEvent>[]
  [key: string]: unknown
}

export interface GlobalLayer<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends LayerFields<TTarget, TEvent> {
  target?: undefined
  scope?: "global"
}

export interface FocusWithinLayer<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends LayerFields<TTarget, TEvent> {
  target: TTarget
  scope?: "focus-within"
}

export interface FocusLayer<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends LayerFields<TTarget, TEvent> {
  target: TTarget
  scope: "focus"
}

export type TargetLayer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | FocusWithinLayer<TTarget, TEvent>
  | FocusLayer<TTarget, TEvent>

export type Layer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | GlobalLayer<TTarget, TEvent>
  | TargetLayer<TTarget, TEvent>

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
export interface ResolvedBindingCommand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  run: CommandHandler<TTarget, TEvent>
  attrs?: Readonly<Attributes>
  record?: CommandRecord
  rejectedResult?: Extract<RunCommandResult, { ok: false }>
}

export type CommandResolver<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  command: string,
  ctx: CommandResolverContext,
) => ResolvedBindingCommand<TTarget, TEvent> | undefined

/**
 * Layer command registration input. Extra fields stay on `fields` and can be
 * compiled into `attrs` by command-field addons.
 */
export interface CommandDefinition<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  name: string
  run: CommandHandler<TTarget, TEvent>
  [key: string]: unknown
}

export interface KeyToken {
  name: string
  key: KeyLike
}

export interface ActiveBinding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  sequence: KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
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

export interface ActiveKey<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  stroke: NormalizedKeyStroke
  display: string
  bindings?: ActiveBinding<TTarget, TEvent>[]
  bindingAttrs?: Readonly<Attributes>
  commandAttrs?: Readonly<Attributes>
  command?: BindingCommand<TTarget, TEvent>
  continues: boolean
}

/**
 * Boolean source with subscription-based invalidation. `ctx.activeWhen(...)`
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
  activeWhen(matcher: (() => boolean) | ReactiveMatcher): void
}

export type BindingFieldCompiler = (value: unknown, ctx: BindingFieldContext) => void

export interface LayerFieldContext {
  require(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Raw callbacks re-run on every read;
   * reactive matchers stay cached until they notify.
   */
  activeWhen(matcher: (() => boolean) | ReactiveMatcher): void
}

export type LayerFieldCompiler = (value: unknown, ctx: LayerFieldContext) => void

export interface LayerAnalysisContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  scope: Scope
  target?: TTarget
  order: number
  bindingInputs: readonly BindingInput<TTarget, TEvent>[]
  bindings: readonly LayerBindingAnalysis<TTarget, TEvent>[]
  hasTokenBindings: boolean
  checkCommandResolution(command: string): CommandResolutionStatus
  warn(code: string, warning: unknown, message: string): void
  warnOnce(key: string, code: string, warning: unknown, message: string): void
  error(code: string, error: unknown, message: string): void
}

export interface LayerBindingAnalysis<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  sequence: KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
  attrs?: Readonly<Attributes>
  event: BindingEvent
  preventDefault: boolean
  fallthrough: boolean
  sourceBinding: ParsedBindingInput<TTarget, TEvent>
  sourceScope: Scope
  sourceTarget?: TTarget
  sourceLayerOrder: number
  sourceBindingIndex: number
  hasCommandAtSequence: boolean
  hasContinuations: boolean
}

export type LayerAnalyzer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  ctx: LayerAnalysisContext<TTarget, TEvent>,
) => void

export interface BindingParserContext {
  input: string
  index: number
  layer: Readonly<Record<string, unknown>>
  tokens: ReadonlyMap<string, ResolvedKeyToken>
  normalizeTokenName(token: string): string
  createMatch(id: string): KeyMatch
  parseObjectKey(
    key: KeyStrokeInput,
    options?: {
      display?: string
      match?: KeyMatch
    },
  ): KeySequencePart
}

export interface BindingExpanderContext {
  input: string
  layer: Readonly<Record<string, unknown>>
}

export interface BindingParserResult {
  parts: KeySequencePart[]
  nextIndex: number
  usedTokens?: readonly string[]
  unknownTokens?: readonly string[]
}

export type BindingParser = (ctx: BindingParserContext) => BindingParserResult | undefined

export type BindingExpander = (ctx: BindingExpanderContext) => readonly string[] | undefined

export interface ParsedBindingInput<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  key: KeyLike
  sequence: KeySequencePart[]
  cmd?: BindingCommand<TTarget, TEvent>
  event?: BindingEvent
  preventDefault?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export interface BindingTransformerContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  layer: Readonly<Record<string, unknown>>
  parseKey(key: KeyLike): KeySequencePart
  add(binding: ParsedBindingInput<TTarget, TEvent>): void
  skipOriginal(): void
}

export type BindingTransformer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  binding: ParsedBindingInput<TTarget, TEvent>,
  ctx: BindingTransformerContext<TTarget, TEvent>,
) => void

export interface CommandFieldContext {
  attr(name: string, value: unknown): void
}

export type CommandFieldCompiler = (value: unknown, ctx: CommandFieldContext) => void

export interface KeyInputContext<TEvent extends KeymapEvent = KeymapEvent> {
  event: TEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface RawInputContext {
  sequence: string
  stop: () => void
}

export type Hooks<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = {
  /**
   * Batched "derived state may have changed" signal. Re-read through getters;
   * framework adapters should use this event.
   */
  state: void
  /**
   * Synchronous pending-sequence updates, including clear. Payload is the
   * current sequence.
   */
  pendingSequence: readonly KeySequencePart[]
}

export type HookName = keyof Hooks

export type Listener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

export interface WarningEvent {
  code: string
  message: string
  warning: unknown
}

export interface ErrorEvent {
  code: string
  message: string
  error: unknown
}

/** Events exposed by `keymap.on(...)`. `state` is batched and `pendingSequence` is synchronous. */
export type Events<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = Hooks<
  TTarget,
  TEvent
> & {
  warning: WarningEvent
  error: ErrorEvent
}

export type EventName = keyof Events

export type Intercepts<TEvent extends KeymapEvent = KeymapEvent> = {
  key: KeyInputContext<TEvent>
  raw: RawInputContext
}

export type InterceptName = keyof Intercepts

export interface KeyInterceptOptions {
  priority?: number
  release?: boolean
}

export interface RawInterceptOptions {
  priority?: number
}

export type { Keymap }
export type KeymapActiveKey<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = ActiveKey<
  TTarget,
  TEvent
>
export type KeymapBindingInput<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> = BindingInput<TTarget, TEvent>
export type KeymapCommandDefinition<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> = CommandDefinition<TTarget, TEvent>
export type KeymapCommandRecord = CommandRecord

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

export interface CompiledBinding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent>
  extends ActiveBinding<TTarget, TEvent>, RuntimeMatchable {
  run?: CommandHandler<TTarget, TEvent>
  sourceBinding: ParsedBindingInput<TTarget, TEvent>
  sourceScope: Scope
  sourceTarget?: TTarget
  sourceLayerOrder: number
  sourceBindingIndex: number
}

export interface ActiveKeySelection<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  display: string
  continues: boolean
  firstBinding?: CompiledBinding<TTarget, TEvent>
  commandBinding?: CompiledBinding<TTarget, TEvent>
  bindings?: readonly CompiledBinding<TTarget, TEvent>[]
  stop: boolean
}

export interface ActiveKeyState<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  stroke: NormalizedKeyStroke
  display: string
  continues: boolean
  firstBinding?: CompiledBinding<TTarget, TEvent>
  commandBinding?: CompiledBinding<TTarget, TEvent>
  bindings?: CompiledBinding<TTarget, TEvent>[]
}

export interface RegisteredCommand<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends CommandRecord {
  run: (ctx: CommandContext<TTarget, TEvent>) => CommandResult
  runner?: CommandHandler<TTarget, TEvent>
  resolved?: ResolvedBindingCommand<TTarget, TEvent>
  resolvedWithRecord?: ResolvedBindingCommand<TTarget, TEvent>
  record?: CommandRecord
}

export interface CompiledBindingsResult<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  root: SequenceNode<TTarget, TEvent>
  bindings: readonly CompiledBinding<TTarget, TEvent>[]
  hasTokenBindings: boolean
}

export interface SequenceNode<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  parent: SequenceNode<TTarget, TEvent> | null
  depth: number
  stroke: NormalizedKeyStroke | null
  match: KeyMatch | null
  children: Map<KeyMatch, SequenceNode<TTarget, TEvent>>
  bindings: CompiledBinding<TTarget, TEvent>[]
  reachableBindings: CompiledBinding<TTarget, TEvent>[]
}

export interface RegisteredLayer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  order: number
  target?: TTarget
  indexTarget: TTarget
  scope: Scope
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
  compileFields?: Readonly<Record<string, unknown>>
  commands: readonly RegisteredCommand<TTarget, TEvent>[]
  commandLookup?: ReadonlyMap<string, RegisteredCommand<TTarget, TEvent>>
  bindingInputs: readonly BindingInput<TTarget, TEvent>[]
  compiledBindings: readonly CompiledBinding<TTarget, TEvent>[]
  hasUnkeyedBindings: boolean
  hasTokenBindings: boolean
  root: SequenceNode<TTarget, TEvent>
  offTargetDestroy?: () => void
  bucket?: RegisteredLayerBucket<TTarget, TEvent>
}

export interface RegisteredLayerBucket<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  focusLayers: RegisteredLayer<TTarget, TEvent>[]
  focusWithinLayers: RegisteredLayer<TTarget, TEvent>[]
}

export interface PendingSequenceState<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  layer: RegisteredLayer<TTarget, TEvent>
  node: SequenceNode<TTarget, TEvent>
}
