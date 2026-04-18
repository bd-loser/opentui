import type { Renderable } from "../../../Renderable.js"
import type { CommandService } from "./commands.js"
import type { ConditionService } from "./conditions.js"
import type { State } from "./state.js"
import type { NotificationService } from "./notify.js"
import type {
  Attributes,
  BindingCommand,
  BindingEvent,
  BindingExpander,
  BindingExpanderContext,
  BindingInput,
  BindingParser,
  BindingParserContext,
  BindingSyntax,
  EventData,
  ParsedBindingInput,
  ReactiveMatcher,
  RegisteredCommand,
  Scope,
  CompiledBinding,
  CompiledBindingsResult,
  KeyLike,
  KeyStroke,
  ParsedKeyPart,
  ParsedKeyToken,
  RuntimeMatcher,
  SequenceNode,
} from "../types.js"
import {
  createParsedKeyPart,
  createSequenceNode,
  getErrorMessage,
  mergeAttribute,
  mergeRequirement,
  normalizeBindingCommand,
  snapshotAttributes,
  snapshotParsedBindingInput,
} from "../lib/utils.js"

const EMPTY_COMPILE_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_REQUIRES: readonly [name: string, value: unknown][] = []
const EMPTY_MATCHERS: readonly RuntimeMatcher[] = []
const EMPTY_CONDITION_KEYS: readonly string[] = []

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "event", "preventDefault", "fallthrough"])

interface ParsedBindingSequenceResult {
  parts: ParsedKeyPart[]
  usedTokens: readonly string[]
  unknownTokens: readonly string[]
  hasTokenBindings: boolean
}

export interface CompilerOptions {
  warnUnknownField: (kind: "binding" | "layer", fieldName: string) => void
  warnUnknownToken: (token: string, sequence: string) => void
}

export class CompilerService {
  constructor(
    private readonly state: State,
    private readonly notify: NotificationService,
    private readonly commands: CommandService,
    private readonly conditions: ConditionService,
    private readonly options: CompilerOptions,
  ) {}

  public normalizeTokenName(token: string): string {
    const normalized = this.getBindingSyntax().normalizeTokenName(token)
    if (!normalized) {
      throw new Error("Invalid action map token: token cannot be empty")
    }

    return normalized
  }

  public parseTokenKey(key: KeyLike): ParsedKeyPart {
    return parseSingleKeyPartWithParsers(key, this.state.config.bindingParsers.values(), {
      tokens: this.state.config.tokens,
      layer: EMPTY_COMPILE_FIELDS,
      parseObjectKey: (value) => this.parseObjectKeyPart(value),
    })
  }

  public compileBindings(
    bindings: readonly BindingInput[],
    tokens: ReadonlyMap<string, ParsedKeyToken>,
    sourceScope: Scope,
    sourceTarget: Renderable | undefined,
    sourceLayerOrder: number,
    compileFields?: Readonly<Record<string, unknown>>,
    localCommands?: ReadonlyMap<string, RegisteredCommand>,
  ): CompiledBindingsResult {
    const root = createSequenceNode(null, null, null)
    const compiledBindings: CompiledBinding[] = []
    let hasTokenBindings = false
    const bindingExpanders = this.state.config.bindingExpanders.values()
    const bindingParsers = this.state.config.bindingParsers.values()
    const bindingFieldCompilers = this.state.config.bindingFields
    const warnUnknownField = this.options.warnUnknownField
    const warnUnknownToken = this.options.warnUnknownToken
    const conditions = this.conditions
    const commands = this.commands

    for (const [bindingIndex, binding] of bindings.entries()) {
      let expandedBindingKeys: readonly KeyLike[]

      try {
        expandedBindingKeys = expandBindingInputWithExpanders(binding.key, bindingExpanders, {
          layer: compileFields,
        })
      } catch (error) {
        this.notify.emitError(getErrorMessage(error, "Failed to expand action map binding"), error)
        continue
      }

      for (const expandedBindingKey of expandedBindingKeys) {
        let parsed: ParsedBindingSequenceResult | undefined

        try {
          parsed =
            typeof expandedBindingKey === "string"
              ? parseBindingSequenceWithParsers(expandedBindingKey, bindingParsers, {
                  tokens,
                  layer: compileFields,
                  parseObjectKey: (value) => this.parseObjectKeyPart(value),
                })
              : {
                  parts: [this.parseObjectKeyPart(expandedBindingKey)],
                  usedTokens: [] as readonly string[],
                  unknownTokens: [] as readonly string[],
                  hasTokenBindings: false,
                }
        } catch (error) {
          this.notify.emitError(getErrorMessage(error, "Failed to parse action map binding"), error)
          continue
        }

        const sequence = parsed.parts
        hasTokenBindings ||= parsed.hasTokenBindings

        for (const tokenName of parsed.unknownTokens) {
          warnUnknownToken(
            tokenName,
            typeof expandedBindingKey === "string" ? expandedBindingKey : String(expandedBindingKey.name),
          )
        }

        for (const compiledInput of this.applyBindingTransformers(
          binding,
          sequence,
          tokens,
          bindingParsers,
          compileFields,
        )) {
          try {
            const event = this.normalizeBindingEvent(compiledInput.event)
            const compiledSequence = compiledInput.sequence
            let mergedRequires: EventData | undefined
            let mergedAttrs: Attributes | undefined
            let matchers: RuntimeMatcher[] | undefined
            let conditionKeys: Set<string> | undefined
            let hasUnkeyedMatchers = false

            for (const fieldName in compiledInput) {
              if (fieldName === "sequence") {
                continue
              }

              if (RESERVED_BINDING_FIELDS.has(fieldName)) {
                continue
              }

              const value = compiledInput[fieldName as keyof ParsedBindingInput]

              if (value === undefined) {
                continue
              }

              const compiler = bindingFieldCompilers.get(fieldName)
              if (!compiler) {
                warnUnknownField("binding", fieldName)
                continue
              }

              compiler(value, {
                require(name, requiredValue) {
                  if (!mergedRequires) {
                    mergedRequires = {}
                  }
                  mergeRequirement(mergedRequires, name, requiredValue, `field ${fieldName}`)
                  if (!conditionKeys) {
                    conditionKeys = new Set<string>()
                  }
                  conditionKeys.add(name)
                },
                attr(name, attributeValue) {
                  if (!mergedAttrs) {
                    mergedAttrs = {}
                  }
                  mergeAttribute(mergedAttrs, name, attributeValue, `field ${fieldName}`)
                },
                match: (matcher) => {
                  const runtimeMatcher = conditions.buildRuntimeMatcher(matcher, `field ${fieldName}`)
                  if (!runtimeMatcher.cacheable) {
                    hasUnkeyedMatchers = true
                  }
                  if (!matchers) {
                    matchers = []
                  }
                  matchers.push(runtimeMatcher)
                },
              })
            }

            const attrs = mergedAttrs ? snapshotAttributes(mergedAttrs) : undefined
            const command = normalizeBindingCommand(compiledInput.cmd)
            const compiledBinding: CompiledBinding = {
              sequence: compiledSequence,
              command,
              event,
              sourceBinding: snapshotParsedBindingInput(compiledInput),
              sourceScope,
              sourceTarget,
              sourceLayerOrder,
              sourceBindingIndex: bindingIndex,
              requires: mergedRequires ? Object.entries(mergedRequires) : EMPTY_REQUIRES,
              matchers: matchers ?? EMPTY_MATCHERS,
              conditionKeys: conditionKeys ? [...conditionKeys] : EMPTY_CONDITION_KEYS,
              hasUnkeyedMatchers,
              matchCacheDirty: true,
              preventDefault: compiledInput.preventDefault !== false,
              fallthrough: compiledInput.fallthrough ?? false,
            }

            if (attrs) {
              compiledBinding.attrs = attrs
            }

            commands.resolveCompiledBindingCommand(compiledBinding, localCommands)

            if (compiledSequence.length === 0) {
              continue
            }

            if (event === "release" && compiledSequence.length > 1) {
              throw new Error("ActionMap release bindings only support a single key stroke")
            }

            if (event === "press") {
              this.insertBinding(root, compiledBinding)
            }

            compiledBindings.push(compiledBinding)
          } catch (error) {
            this.notify.emitError(getErrorMessage(error, "Failed to compile action map binding"), error)
          }
        }
      }
    }

    return {
      root,
      bindings: compiledBindings,
      hasTokenBindings,
    }
  }

  private getBindingSyntax(): BindingSyntax {
    const syntax = this.state.config.bindingSyntax
    if (!syntax) {
      throw new Error("No action map binding syntax is registered")
    }

    return syntax
  }

  private parseObjectKeyPart(key: KeyStroke): ParsedKeyPart {
    const parsed = this.getBindingSyntax().parseObjectKey(key)
    return createParsedKeyPart(parsed.stroke, parsed.display, parsed.matchKey)
  }

  private normalizeBindingEvent(event: unknown): BindingEvent {
    if (event === undefined || event === "press") {
      return "press"
    }

    if (event === "release") {
      return "release"
    }

    throw new Error(`Invalid action map binding event "${String(event)}": expected "press" or "release"`)
  }

  private applyBindingTransformers(
    binding: BindingInput,
    sequence: ParsedKeyPart[],
    tokens: ReadonlyMap<string, ParsedKeyToken>,
    bindingParsers: readonly BindingParser[],
    compileFields?: Readonly<Record<string, unknown>>,
  ): ParsedBindingInput[] {
    const bindingTransformers = this.state.config.bindingTransformers.values()

    if (bindingTransformers.length === 0) {
      return [
        { ...binding, sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)) },
      ]
    }

    const parsedBinding: ParsedBindingInput = {
      ...binding,
      sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
    }
    const extraBindings: ParsedBindingInput[] = []
    let keepOriginal = true
    const layer = compileFields ?? EMPTY_COMPILE_FIELDS

    for (const transformer of bindingTransformers) {
      try {
        transformer(parsedBinding, {
          layer,
          parseKey: (key) => {
            return parseSingleKeyPartWithParsers(key, bindingParsers, {
              tokens,
              layer,
              parseObjectKey: (value) => this.parseObjectKeyPart(value),
            })
          },
          add: (nextBinding) => {
            extraBindings.push(snapshotParsedBindingInput(nextBinding))
          },
          skipOriginal: () => {
            keepOriginal = false
          },
        })
      } catch (error) {
        this.notify.emitError("[ActionMap] Error in binding transformer:", error)
      }
    }

    if (!keepOriginal) {
      return extraBindings
    }

    if (extraBindings.length === 0) {
      return [parsedBinding]
    }

    return [parsedBinding, ...extraBindings]
  }

  private insertBinding(root: SequenceNode, binding: CompiledBinding): void {
    let node = root
    const touchedNodes: SequenceNode[] = []
    const createdNodes: Array<{ parent: SequenceNode; key: string }> = []

    try {
      for (const part of binding.sequence) {
        if (node.bindings.some((candidate) => candidate.command !== undefined)) {
          throw new Error(
            "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
          )
        }

        const bindingKey = part.matchKey
        let child = node.children.get(bindingKey)
        if (!child) {
          child = createSequenceNode(node, part.stroke, part.matchKey)
          node.children.set(bindingKey, child)
          createdNodes.push({ parent: node, key: bindingKey })
        }

        child.reachableBindings.push(binding)
        touchedNodes.push(child)
        node = child
      }

      if (binding.command !== undefined && node.children.size > 0) {
        throw new Error(
          "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
        )
      }

      node.bindings = [...node.bindings, binding]
    } catch (error) {
      for (let index = touchedNodes.length - 1; index >= 0; index -= 1) {
        const touchedNode = touchedNodes[index]
        if (!touchedNode) {
          continue
        }

        if (touchedNode.reachableBindings.at(-1) === binding) {
          touchedNode.reachableBindings.pop()
          continue
        }

        touchedNode.reachableBindings = touchedNode.reachableBindings.filter((candidate) => candidate !== binding)
      }

      for (let index = createdNodes.length - 1; index >= 0; index -= 1) {
        const createdNode = createdNodes[index]
        if (!createdNode) {
          continue
        }

        const child = createdNode.parent.children.get(createdNode.key)
        if (!child) {
          continue
        }

        if (child.children.size > 0 || child.reachableBindings.length > 0 || child.bindings.length > 0) {
          continue
        }

        createdNode.parent.children.delete(createdNode.key)
      }

      throw error
    }
  }
}

function expandBindingInputWithExpanders(
  key: KeyLike,
  expanders: readonly BindingExpander[],
  options?: {
    layer?: Readonly<Record<string, unknown>>
  },
): readonly KeyLike[] {
  if (typeof key !== "string" || expanders.length === 0) {
    return [key]
  }

  const layer = options?.layer ?? EMPTY_COMPILE_FIELDS
  let candidates = [key]

  for (const expander of expanders) {
    const nextCandidates: string[] = []

    for (const input of candidates) {
      const result = expander({ input, layer } satisfies BindingExpanderContext)
      if (!result) {
        nextCandidates.push(input)
        continue
      }

      if (result.length === 0) {
        throw new Error(`ActionMap binding expander must return at least one key sequence for "${input}"`)
      }

      for (const expandedInput of result) {
        if (typeof expandedInput !== "string") {
          throw new Error(`ActionMap binding expander must return string key sequences for "${input}"`)
        }

        nextCandidates.push(expandedInput)
      }
    }

    candidates = nextCandidates
  }

  return candidates
}

function parseBindingSequenceWithParsers(
  key: string,
  parsers: readonly BindingParser[],
  options: {
    tokens?: ReadonlyMap<string, ParsedKeyToken>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey: (key: KeyStroke) => ParsedKeyPart
  },
): ParsedBindingSequenceResult {
  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (parsers.length === 0) {
    throw new Error("No action map binding parsers are registered")
  }

  const tokens = options.tokens ?? new Map<string, ParsedKeyToken>()
  const layer = options.layer ?? EMPTY_COMPILE_FIELDS
  const parseObjectKey = options.parseObjectKey
  const parts: ParsedKeyPart[] = []
  const usedTokens = new Set<string>()
  const unknownTokens = new Set<string>()

  let index = 0
  while (index < key.length) {
    let matched = false

    for (const parser of parsers) {
      const result = parser({
        input: key,
        index,
        layer,
        tokens,
        parseObjectKey,
      } satisfies BindingParserContext)
      if (!result) {
        continue
      }

      if (result.nextIndex <= index || result.nextIndex > key.length) {
        throw new Error(`ActionMap binding parser must advance the input for "${key}" at index ${index}`)
      }

      parts.push(...result.parts)
      for (const tokenName of result.usedTokens ?? []) {
        usedTokens.add(tokenName)
      }
      for (const tokenName of result.unknownTokens ?? []) {
        unknownTokens.add(tokenName)
      }

      index = result.nextIndex
      matched = true
      break
    }

    if (!matched) {
      throw new Error(`No action map binding parser handled input at index ${index} in "${key}"`)
    }
  }

  return {
    parts,
    usedTokens: [...usedTokens],
    unknownTokens: [...unknownTokens],
    hasTokenBindings: usedTokens.size > 0 || unknownTokens.size > 0,
  }
}

function parseSingleKeyPartWithParsers(
  key: KeyLike,
  parsers: readonly BindingParser[],
  options: {
    tokens?: ReadonlyMap<string, ParsedKeyToken>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey: (key: KeyStroke) => ParsedKeyPart
  },
): ParsedKeyPart {
  if (typeof key !== "string") {
    return options.parseObjectKey(key)
  }

  const { parts } = parseBindingSequenceWithParsers(key, parsers, options)
  const [part] = parts
  if (!part || parts.length !== 1) {
    throw new Error(`Invalid key "${String(key)}": expected a single key stroke`)
  }

  return part
}
