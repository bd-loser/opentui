import type { Renderable } from "../../Renderable.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import type { CliRenderer } from "../../renderer.js"

export type KeymapEventData = Record<string, unknown>

export type KeymapAttributes = Record<string, unknown>

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

export type KeymapStrokeFallbackResolver = (event: KeyEvent, stroke: ParsedKeyStroke) => KeyStroke | undefined

export interface ParsedKeyPart {
  stroke: ParsedKeyStroke
  display: string
}

export interface KeymapStringifyOptions {
  preferDisplay?: boolean
}

export type KeymapStringifiableKey = ParsedKeyStroke | ParsedKeyPart | { stroke: ParsedKeyStroke; display?: string }

export type KeyLike = string | KeyStroke

export interface KeymapCommandInfo {
  name: string
  attrs?: Readonly<KeymapAttributes>
}

export interface KeymapCommandContext {
  manager: KeymapManager
  renderer: CliRenderer
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<KeymapEventData>
  command?: KeymapCommandInfo
}

export type KeymapCommandResult = boolean | void | Promise<boolean | void>

export type KeymapCommandHandler = (ctx: KeymapCommandContext) => KeymapCommandResult

export type KeymapBindingCommand = string | KeymapCommandHandler

export type KeymapBindingEvent = "press" | "release"

export type KeymapBindingInput = {
  key: KeyLike
  cmd?: KeymapBindingCommand
  event?: KeymapBindingEvent
  consume?: boolean
  fallthrough?: boolean
} & Record<string, unknown>

export type KeymapBindingShorthand = Record<string, KeymapBindingCommand>

export type KeymapBindings = KeymapBindingInput[] | KeymapBindingShorthand

export type KeymapScope = "global" | "focus" | "focus-within"

export interface KeymapLayerFields {
  priority?: number
  bindings: KeymapBindings
  [key: string]: unknown
}

export interface KeymapGlobalLayer extends KeymapLayerFields {
  target?: undefined
  scope?: "global"
}

export interface KeymapFocusWithinLayer extends KeymapLayerFields {
  target: Renderable
  scope?: "focus-within"
}

export interface KeymapFocusLayer extends KeymapLayerFields {
  target: Renderable
  scope: "focus"
}

export type KeymapTargetLayer = KeymapFocusWithinLayer | KeymapFocusLayer

export type KeymapLayer = KeymapGlobalLayer | KeymapTargetLayer

export interface KeymapParsedCommand {
  input: string
  name: string
  args: string[]
}

export interface KeymapCommandResolverContext {
  getCommandAttrs(name: string): Readonly<KeymapAttributes> | undefined
}

export interface KeymapResolvedBindingCommand {
  run: KeymapCommandHandler
  attrs?: Readonly<KeymapAttributes>
}

export type KeymapCommandResolver = (
  command: string,
  ctx: KeymapCommandResolverContext,
) => KeymapResolvedBindingCommand | undefined

export interface KeymapCommand {
  name: string
  run: KeymapCommandHandler
  [key: string]: unknown
}

export type ActionCommand = KeymapCommand

export interface KeymapToken {
  token: string
  key: KeyLike
}

export interface KeymapActiveBinding {
  sequence: ParsedKeyPart[]
  command?: KeymapBindingCommand
  commandAttrs?: Readonly<KeymapAttributes>
  attrs?: Readonly<KeymapAttributes>
  event: KeymapBindingEvent
  consume: boolean
  fallthrough: boolean
}

export interface KeymapActiveKeyOptions {
  includeBindings?: boolean
  includeMetadata?: boolean
}

export interface KeymapActiveKey {
  stroke: ParsedKeyStroke
  display: string
  bindings?: KeymapActiveBinding[]
  bindingAttrs?: Readonly<KeymapAttributes>
  commandAttrs?: Readonly<KeymapAttributes>
  command?: KeymapBindingCommand
  continues: boolean
}

export interface KeymapBindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
}

export type KeymapBindingFieldCompiler = (value: unknown, ctx: KeymapBindingFieldContext) => void

export interface KeymapLayerFieldContext {
  require(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
}

export type KeymapLayerFieldCompiler = (value: unknown, ctx: KeymapLayerFieldContext) => void

export interface KeymapBindingParserContext {
  input: string
  index: number
  layer: Readonly<Record<string, unknown>>
  tokens: ReadonlyMap<string, ParsedKeyStroke>
}

export interface KeymapBindingExpanderContext {
  input: string
  layer: Readonly<Record<string, unknown>>
}

export interface KeymapBindingParserResult {
  parts: ParsedKeyPart[]
  nextIndex: number
  usedTokens?: readonly string[]
  unknownTokens?: readonly string[]
}

export type KeymapBindingParser = (ctx: KeymapBindingParserContext) => KeymapBindingParserResult | undefined

export type KeymapBindingExpander = (ctx: KeymapBindingExpanderContext) => readonly string[] | undefined

export interface KeymapParsedBindingInput extends Omit<KeymapBindingInput, "key"> {
  sequence: ParsedKeyPart[]
}

export interface KeymapBindingCompilerContext {
  layer: Readonly<Record<string, unknown>>
  add(binding: KeymapParsedBindingInput): void
  skipOriginal(): void
}

export type KeymapBindingCompiler = (binding: KeymapParsedBindingInput, ctx: KeymapBindingCompilerContext) => void

export interface KeymapCommandFieldContext {
  attr(name: string, value: unknown): void
}

export type KeymapCommandFieldCompiler = (value: unknown, ctx: KeymapCommandFieldContext) => void

export interface KeymapKeyInputContext {
  event: KeyEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface KeymapRawInputContext {
  sequence: string
  stop: () => void
}

export interface KeymapUnresolvedCommandContext {
  command: string
  binding: KeymapParsedBindingInput
  scope: KeymapScope
  target?: Renderable
}

export interface KeymapHooks {
  state: void
  pendingSequence: readonly ParsedKeyStroke[]
  unresolvedCommand: KeymapUnresolvedCommandContext
}

export type KeymapHookName = keyof KeymapHooks

export type KeymapHookListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

export interface KeymapLogger {
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface KeymapManagerOptions {
  logger?: KeymapLogger
}

export interface KeymapManager {
  readonly renderer: CliRenderer
  destroy(): void
  setData(name: string, value: unknown): void
  getData(name: string): unknown
  invalidateRuntimeKey(name: string): void
  getPendingSequence(): readonly ParsedKeyStroke[]
  getPendingSequenceParts(): readonly ParsedKeyPart[]
  clearPendingSequence(): void
  popPendingSequence(): boolean
  getActiveKeys(options?: KeymapActiveKeyOptions): readonly KeymapActiveKey[]
  hook<TName extends KeymapHookName>(name: TName, fn: KeymapHookListener<KeymapHooks[TName]>): () => void
  registerLayer(layer: KeymapLayer): () => void
  registerLayerFields(fields: Record<string, KeymapLayerFieldCompiler>): () => void
  registerToken(token: KeymapToken): () => void
  prependBindingExpander(expander: KeymapBindingExpander): () => void
  appendBindingExpander(expander: KeymapBindingExpander): () => void
  clearBindingExpanders(): void
  prependBindingParser(parser: KeymapBindingParser): () => void
  appendBindingParser(parser: KeymapBindingParser): () => void
  clearBindingParsers(): void
  registerBindingCompiler(compiler: KeymapBindingCompiler): () => void
  registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void
  registerCommandFields(fields: Record<string, KeymapCommandFieldCompiler>): () => void
  registerCommandResolver(resolver: KeymapCommandResolver): () => void
  registerStrokeFallbackResolver(resolver: KeymapStrokeFallbackResolver): () => void
  onKeyInput(fn: (ctx: KeymapKeyInputContext) => void, options?: { priority?: number; release?: boolean }): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommands(commands: KeymapCommand[]): () => void
}

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

export interface CompiledBinding extends KeymapActiveBinding, RuntimeMatchable {
  run?: KeymapCommandHandler
  activeBindingCacheVersion?: number
  activeBindingCache?: KeymapActiveBinding
  sourceBinding: KeymapParsedBindingInput
  sourceScope: KeymapScope
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

export interface RegisteredCommand {
  name: string
  run: (ctx: KeymapCommandContext) => KeymapCommandResult
  attrs?: Readonly<KeymapAttributes>
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
  children: Map<string, SequenceNode>
  bindings: CompiledBinding[]
  reachableBindings: CompiledBinding[]
}

export interface RegisteredLayer {
  order: number
  target?: Renderable
  scope: KeymapScope
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
  compileFields?: Readonly<Record<string, unknown>>
  bindingInputs: readonly KeymapBindingInput[]
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

export interface RegisteredKeyHook {
  order: number
  priority: number
  release: boolean
  fn: (ctx: KeymapKeyInputContext) => void
}

export interface RegisteredRawHook {
  order: number
  priority: number
  fn: (ctx: KeymapRawInputContext) => void
}

export interface PendingSequenceState {
  layer: RegisteredLayer
  node: SequenceNode
}

export interface ResolvedKeymapLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
