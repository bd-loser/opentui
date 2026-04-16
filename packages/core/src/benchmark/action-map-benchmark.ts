import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing.js"
import {
  defaultBindingParser,
  getActionMap,
  registerEnabledField,
  registerMetadataFields,
  type ActionMapBindingParser,
  type ActionMap,
} from "../extras/action-map/index.js"

const DEFAULT_ITERATIONS = 20_000
const DEFAULT_WARMUP = 2_000
const DEFAULT_ROUNDS = 5
const DEFAULT_MIN_SAMPLE_MS = 250
const KEY_POOL = "abcdefghijklmnopqrstuvwxyz0123456789"

interface BenchmarkArgs {
  iterations: number
  warmupIterations: number
  rounds: number
  minSampleMs: number
  scenarioNames?: Set<string>
  jsonPath?: string
}

interface ScenarioResources {
  renderer: TestRenderer
  mockInput: MockInput
  manager: ActionMap
}

interface ScenarioInstance {
  resources: ScenarioResources
  runIteration: () => void
  cleanup: () => void
}

interface BenchmarkScenario {
  name: string
  description: string
  setup: () => Promise<ScenarioInstance>
}

interface BenchmarkSample {
  round: number
  durationMs: number
  opsPerSecond: number
}

interface BenchmarkResult {
  name: string
  description: string
  iterations: number
  warmupIterations: number
  rounds: number
  measuredIterations: number
  medianDurationMs: number
  bestDurationMs: number
  medianOpsPerSecond: number
  samples: BenchmarkSample[]
}

function parseNumberArg(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric benchmark argument: ${value}`)
  }

  return parsed
}

function parseArgs(argv: string[]): BenchmarkArgs {
  let iterations = DEFAULT_ITERATIONS
  let warmupIterations = DEFAULT_WARMUP
  let rounds = DEFAULT_ROUNDS
  let minSampleMs = DEFAULT_MIN_SAMPLE_MS
  let scenarioNames: Set<string> | undefined
  let jsonPath: string | undefined

  for (const arg of argv) {
    if (arg.startsWith("--iterations=")) {
      iterations = parseNumberArg(arg.slice("--iterations=".length), DEFAULT_ITERATIONS)
      continue
    }

    if (arg.startsWith("--warmup=")) {
      warmupIterations = parseNumberArg(arg.slice("--warmup=".length), DEFAULT_WARMUP)
      continue
    }

    if (arg.startsWith("--rounds=")) {
      rounds = parseNumberArg(arg.slice("--rounds=".length), DEFAULT_ROUNDS)
      continue
    }

    if (arg.startsWith("--min-sample-ms=")) {
      minSampleMs = parseNumberArg(arg.slice("--min-sample-ms=".length), DEFAULT_MIN_SAMPLE_MS)
      continue
    }

    if (arg.startsWith("--scenario=")) {
      const names = arg
        .slice("--scenario=".length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)

      scenarioNames = new Set(names)
      continue
    }

    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length)
    }
  }

  return {
    iterations,
    warmupIterations,
    rounds,
    minSampleMs,
    scenarioNames,
    jsonPath,
  }
}

function nowNs(): bigint {
  return process.hrtime.bigint()
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted[middle]
  if (value === undefined) {
    return 0
  }

  if (sorted.length % 2 === 1) {
    return value
  }

  const previous = sorted[middle - 1]
  if (previous === undefined) {
    return value
  }

  return (previous + value) / 2
}

function roundIterations(value: number): number {
  if (value <= 1_000) {
    return Math.max(1, Math.ceil(value))
  }

  if (value <= 10_000) {
    return Math.ceil(value / 10) * 10
  }

  if (value <= 100_000) {
    return Math.ceil(value / 100) * 100
  }

  return Math.ceil(value / 1_000) * 1_000
}

function createFocusableBox(renderer: TestRenderer, id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    width: 10,
    height: 4,
    focusable: true,
  })
}

function createKey(index: number): string {
  return KEY_POOL[index % KEY_POOL.length] ?? "x"
}

const noopBindingParser: ActionMapBindingParser = () => undefined

function createBracketTokenParser(): ActionMapBindingParser {
  return ({ input, index, tokens }) => {
    if (input[index] !== "[") {
      return undefined
    }

    const end = input.indexOf("]", index)
    if (end === -1) {
      throw new Error(`Invalid key sequence "${input}": unterminated token`)
    }

    const tokenName = input
      .slice(index, end + 1)
      .trim()
      .toLowerCase()
    const token = tokens.get(tokenName)
    if (!token) {
      return { parts: [], nextIndex: end + 1, unknownTokens: [tokenName] }
    }

    return {
      parts: [{ stroke: token.stroke, display: tokenName, matchKey: token.matchKey }],
      nextIndex: end + 1,
      usedTokens: [tokenName],
    }
  }
}

function registerGlobalLayers(manager: ActionMap, count: number, cmd = "noop"): void {
  for (let index = 0; index < count; index += 1) {
    manager.registerLayer({
      scope: "global",
      priority: index % 3,
      bindings: [{ key: createKey(index), cmd }],
    })
  }
}

function registerTargetLayer(
  manager: ActionMap,
  target: BoxRenderable,
  index: number,
  key = createKey(index),
  cmd = "noop",
): void {
  manager.registerLayer({
    target,
    scope: index % 2 === 0 ? "focus-within" : "focus",
    priority: index % 4,
    bindings: [{ key, cmd }],
  })
}

function registerModeBindingFields(manager: ActionMap): void {
  manager.registerBindingFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

function registerModeLayerFields(manager: ActionMap): void {
  manager.registerLayerFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

function normalizeFlagKey(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new Error(`${source} must be a string`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${source} cannot be empty`)
  }

  return trimmed
}

function registerNamedBindingFields(manager: ActionMap): void {
  manager.registerBindingFields({
    activeWhen(value, ctx) {
      ctx.require(normalizeFlagKey(value, "binding field activeWhen"), true)
    },
  })
}

function registerNamedLayerFields(manager: ActionMap): void {
  manager.registerLayerFields({
    activeWhen(value, ctx) {
      ctx.require(normalizeFlagKey(value, "layer field activeWhen"), true)
    },
  })
}

function createFlagKey(index: number): string {
  return `flag-${index}`
}

function registerExternalBindingFields(manager: ActionMap, flags: Record<string, boolean>): void {
  manager.registerBindingFields({
    activeExternally(value, ctx) {
      const key = normalizeFlagKey(value, "binding field activeExternally")
      ctx.match(() => flags[key] === true, { keys: [key] })
    },
  })
}

function registerStateChangeNoopListener(manager: ActionMap): () => void {
  let events = 0

  return manager.hook("state", () => {
    events += 1
  })
}

function registerStateChangeReadListeners(manager: ActionMap): () => void {
  let sink = 0

  const offActiveKeys = manager.hook("state", () => {
    sink += manager.getActiveKeys().length
  })
  const offPendingSequence = manager.hook("state", () => {
    sink += manager.getPendingSequenceParts().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    void sink
  }
}

function registerStateChangeMetadataListeners(manager: ActionMap): () => void {
  let sink = 0

  const offActiveKeys = manager.hook("state", () => {
    sink += manager.getActiveKeys({ includeMetadata: true }).length
  })
  const offPendingSequence = manager.hook("state", () => {
    sink += manager.getPendingSequenceParts().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    void sink
  }
}

function registerStateChangeBindingListeners(manager: ActionMap): () => void {
  let sink = 0

  const offActiveKeys = manager.hook("state", () => {
    sink += manager.getActiveKeys({ includeBindings: true }).length
  })
  const offPendingSequence = manager.hook("state", () => {
    sink += manager.getPendingSequenceParts().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    void sink
  }
}

function readActiveKeysRepeatedly(manager: ActionMap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    manager.getActiveKeys()
  }
}

function readActiveKeysWithMetadataRepeatedly(manager: ActionMap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    manager.getActiveKeys({ includeMetadata: true })
  }
}

function readActiveKeysWithBindingsRepeatedly(manager: ActionMap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    manager.getActiveKeys({ includeBindings: true })
  }
}

function readPendingSequencePartsRepeatedly(manager: ActionMap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    manager.getPendingSequenceParts()
  }
}

function setupStateChangeFocusChurn(resources: ScenarioResources): {
  first: BoxRenderable
  second: BoxRenderable
} {
  const first = createFocusableBox(resources.renderer, "state-focus-first")
  const second = createFocusableBox(resources.renderer, "state-focus-second")

  resources.renderer.root.add(first)
  resources.renderer.root.add(second)

  for (let index = 0; index < 8; index += 1) {
    registerTargetLayer(resources.manager, first, index, createKey(index + 1))
    registerTargetLayer(resources.manager, second, index + 100, createKey(index + 11))
  }

  registerGlobalLayers(resources.manager, 120)

  return { first, second }
}

function setupMetadataFocusTree(resources: ScenarioResources): BoxRenderable[] {
  registerMetadataFields(resources.manager)

  const commands = Array.from({ length: 36 + 300 + 150 }, (_, index) => ({
    name: `metadata-command-${index}`,
    title: `Action ${index}`,
    desc: `Action ${index}`,
    run() {},
  }))

  resources.manager.registerCommands(commands)

  const focusChain = createFocusTree(resources, 6)
  let commandIndex = 0

  for (let index = 0; index < focusChain.length; index += 1) {
    const target = focusChain[index]
    if (!target) {
      continue
    }

    for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
      resources.manager.registerLayer({
        target,
        scope: index % 2 === 0 ? "focus-within" : "focus",
        priority: layerIndex % 4,
        bindings: [
          {
            key: createKey(index * 10 + layerIndex),
            cmd: `metadata-command-${commandIndex}`,
            desc: `Binding ${commandIndex}`,
            group: `Panel ${index}`,
          },
        ],
      })

      commandIndex += 1
    }
  }

  for (let index = 0; index < 300; index += 1) {
    const sibling = createFocusableBox(resources.renderer, `metadata-sibling-${index}`)
    resources.renderer.root.add(sibling)
    resources.manager.registerLayer({
      target: sibling,
      scope: index % 2 === 0 ? "focus-within" : "focus",
      priority: index % 4,
      bindings: [
        {
          key: createKey(index + 4000),
          cmd: `metadata-command-${commandIndex}`,
          desc: `Binding ${commandIndex}`,
          group: "Sibling",
        },
      ],
    })
    commandIndex += 1
  }

  for (let index = 0; index < 150; index += 1) {
    resources.manager.registerLayer({
      scope: "global",
      priority: index % 3,
      bindings: [
        {
          key: createKey(index + 8000),
          cmd: `metadata-command-${commandIndex}`,
          desc: `Binding ${commandIndex}`,
          group: "Global",
        },
      ],
    })
    commandIndex += 1
  }

  return focusChain
}

async function createScenarioResources(): Promise<ScenarioResources> {
  const testSetup = await createTestRenderer({ width: 80, height: 24 })
  const manager = getActionMap(testSetup.renderer)
  manager.registerCommands([
    {
      name: "noop",
      run() {},
    },
  ])

  return {
    renderer: testSetup.renderer,
    mockInput: testSetup.mockInput,
    manager,
  }
}

function createFocusTree(resources: ScenarioResources, depth: number): BoxRenderable[] {
  const chain: BoxRenderable[] = []
  let parent: { add(child: BoxRenderable): void } = resources.renderer.root

  for (let index = 0; index < depth; index += 1) {
    const node = createFocusableBox(resources.renderer, `focus-${index}`)
    parent.add(node)
    chain.push(node)
    parent = node
  }

  chain.at(-1)?.focus()
  return chain
}

const scenarios: BenchmarkScenario[] = [
  {
    name: "compile_layer_default_parser",
    description: "Repeated layer registration using the default binding parser",
    async setup() {
      const resources = await createScenarioResources()
      resources.manager.registerToken({ token: "<leader>", key: { name: "x", ctrl: true } })

      return {
        resources,
        runIteration() {
          const off = resources.manager.registerLayer({
            scope: "global",
            bindings: [{ key: "g<leader>d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_many_noop_parsers",
    description: "Repeated layer registration with many no-op parsers ahead of default",
    async setup() {
      const resources = await createScenarioResources()
      resources.manager.registerToken({ token: "<leader>", key: { name: "x", ctrl: true } })

      for (let index = 0; index < 32; index += 1) {
        resources.manager.prependBindingParser(noopBindingParser)
      }

      return {
        resources,
        runIteration() {
          const off = resources.manager.registerLayer({
            scope: "global",
            bindings: [{ key: "g<leader>d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_replaced_parser_chain",
    description: "Repeated layer registration after replacing the parser chain",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.clearBindingParsers()
      resources.manager.appendBindingParser(createBracketTokenParser())
      resources.manager.appendBindingParser(defaultBindingParser)
      resources.manager.registerToken({ token: "[leader]", key: { name: "x", ctrl: true } })

      return {
        resources,
        runIteration() {
          const off = resources.manager.registerLayer({
            scope: "global",
            bindings: [{ key: "g[leader]d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "register_commands_custom_fields",
    description: "Repeated command registration with compiled and raw custom fields",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommandFields({
        desc(value, ctx) {
          ctx.attr("desc", value)
        },
        title(value, ctx) {
          ctx.attr("title", value)
        },
        category(value, ctx) {
          ctx.attr("category", value)
        },
      })

      return {
        resources,
        runIteration() {
          const off = resources.manager.registerCommands([
            {
              name: "bench-command",
              namespace: "bench",
              desc: "Write the current file",
              title: "Write File",
              category: "File",
              usage: ":write <file>",
              tags: ["file", "write"],
              run() {},
            },
          ])

          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_query",
    description: "Repeated command discovery with search and filter over raw fields and attrs",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommandFields({
        title(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.manager.registerCommands(
        Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          title: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      )

      return {
        resources,
        runIteration() {
          resources.manager.getCommands({
            search: "write",
            searchIn: ["name", "title", "usage", "label"],
            filter: {
              namespace: "bench",
              tags: "file",
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_namespace_query",
    description: "Repeated command discovery with top-level namespace filtering",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommandFields({
        title(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.manager.registerCommands(
        Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          title: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      )

      return {
        resources,
        runIteration() {
          resources.manager.getCommands({
            namespace: "bench",
            filter: {
              tags: "file",
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_query_function_filter",
    description: "Repeated command discovery with search and a full-record filter predicate",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommandFields({
        title(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.manager.registerCommands(
        Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          title: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      )

      return {
        resources,
        runIteration() {
          resources.manager.getCommands({
            search: "write",
            searchIn: ["name", "title", "usage", "label"],
            filter(command) {
              return (
                command.fields.namespace === "bench" &&
                Array.isArray(command.fields.tags) &&
                command.fields.tags.includes("file")
              )
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "run_command_registered",
    description: "Repeated programmatic execution of a directly registered command",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommands([
        {
          name: "bench-run-command",
          title: "Bench Run Command",
          desc: "Bench Run Command",
          run() {},
        },
      ])

      return {
        resources,
        runIteration() {
          resources.manager.runCommand("bench-run-command")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "run_command_registered_with_command",
    description: "Repeated programmatic execution of a directly registered command with command metadata included",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommands([
        {
          name: "bench-run-command",
          title: "Bench Run Command",
          desc: "Bench Run Command",
          run() {},
        },
      ])

      return {
        resources,
        runIteration() {
          resources.manager.runCommand("bench-run-command", { includeCommand: true })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_global_layers",
    description: "Repeated getActiveKeys with many global layers",
    async setup() {
      const resources = await createScenarioResources()
      registerGlobalLayers(resources.manager, 400)

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_focus_tree",
    description: "Repeated getActiveKeys with deep focus chain and many unrelated target layers",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 6)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
          registerTargetLayer(resources.manager, target, index * 10 + layerIndex)
        }
      }

      for (let index = 0; index < 300; index += 1) {
        const sibling = createFocusableBox(resources.renderer, `sibling-${index}`)
        resources.renderer.root.add(sibling)
        registerTargetLayer(resources.manager, sibling, index + 1000)
      }

      registerGlobalLayers(resources.manager, 150)

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_focus_tree_repeat_reads_5x",
    description: "Repeated getActiveKeys five times against the same focus tree state",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 6)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
          registerTargetLayer(resources.manager, target, index * 10 + layerIndex)
        }
      }

      for (let index = 0; index < 300; index += 1) {
        const sibling = createFocusableBox(resources.renderer, `repeat-sibling-${index}`)
        resources.renderer.root.add(sibling)
        registerTargetLayer(resources.manager, sibling, index + 3000)
      }

      registerGlobalLayers(resources.manager, 150)

      return {
        resources,
        runIteration() {
          readActiveKeysRepeatedly(resources.manager, 5)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_focus_tree_with_bindings_repeat_reads_5x",
    description: "Repeated getActiveKeys with bindings five times against metadata-rich focus tree state",
    async setup() {
      const resources = await createScenarioResources()
      setupMetadataFocusTree(resources)

      return {
        resources,
        runIteration() {
          readActiveKeysWithBindingsRepeatedly(resources.manager, 5)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_focus_tree_with_metadata_repeat_reads_5x",
    description: "Repeated getActiveKeys with metadata five times against metadata-rich focus tree state",
    async setup() {
      const resources = await createScenarioResources()
      setupMetadataFocusTree(resources)

      return {
        resources,
        runIteration() {
          readActiveKeysWithMetadataRepeatedly(resources.manager, 5)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_focus_tree",
    description: "Repeated key dispatch with deep focus chain and many unrelated target layers",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 6)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
          registerTargetLayer(resources.manager, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      const focusedTarget = focusChain.at(-1)
      if (!focusedTarget) {
        throw new Error("Expected a focused target for dispatch benchmark")
      }

      resources.manager.registerLayer({
        target: focusedTarget,
        bindings: [{ key: "x", cmd: "noop" }],
      })

      for (let index = 0; index < 300; index += 1) {
        const sibling = createFocusableBox(resources.renderer, `dispatch-sibling-${index}`)
        resources.renderer.root.add(sibling)
        registerTargetLayer(resources.manager, sibling, index + 2000)
      }

      registerGlobalLayers(resources.manager, 150)

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_pending_sequence",
    description: "Repeated getActiveKeys while a multi-key sequence is pending",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 5)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 5; layerIndex += 1) {
          registerTargetLayer(resources.manager, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      registerGlobalLayers(resources.manager, 120)
      resources.manager.registerLayer({
        scope: "global",
        bindings: [
          { key: "ga", cmd: "noop" },
          { key: "gb", cmd: "noop" },
          { key: "gc", cmd: "noop" },
          { key: "gd", cmd: "noop" },
        ],
      })

      resources.mockInput.pressKey("g")

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "pending_sequence_parts_repeat_reads_5x",
    description: "Repeated pending sequence part reads against the same pending state",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 5)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 5; layerIndex += 1) {
          registerTargetLayer(resources.manager, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      registerGlobalLayers(resources.manager, 120)
      resources.manager.registerLayer({
        scope: "global",
        bindings: [
          { key: "ga", cmd: "noop" },
          { key: "gb", cmd: "noop" },
          { key: "gc", cmd: "noop" },
          { key: "gd", cmd: "noop" },
        ],
      })

      resources.mockInput.pressKey("g")

      return {
        resources,
        runIteration() {
          readPendingSequencePartsRepeatedly(resources.manager, 5)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_pending_recompiled_token_prefix",
    description: "Repeated getActiveKeys while a late-registered token prefix is pending",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 320; index += 1) {
        resources.manager.registerLayer({
          scope: "global",
          bindings: [{ key: `<leader>${createKey(index)}`, cmd: "noop" }],
        })
      }

      resources.manager.registerToken({
        token: "<leader>",
        key: { name: "x", ctrl: true },
      })
      resources.mockInput.pressKey("x", { ctrl: true })

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_requirement_heavy",
    description: "Repeated getActiveKeys with many runtime-gated bindings",
    async setup() {
      const resources = await createScenarioResources()
      registerModeBindingFields(resources.manager)
      resources.manager.setData("vim.mode", "normal")
      resources.manager.setData("vim.state", "idle")

      for (let index = 0; index < 320; index += 1) {
        resources.manager.registerLayer({
          scope: "global",
          bindings: [
            {
              key: createKey(index),
              mode: index % 2 === 0 ? "normal" : "visual",
              state: index % 3 === 0 ? "idle" : "busy",
              cmd: "noop",
            },
            {
              key: createKey(index + 1),
              mode: index % 2 === 0 ? "visual" : "normal",
              state: index % 4 === 0 ? "idle" : "busy",
              cmd: "noop",
            },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_layer_requirement_heavy",
    description: "Repeated getActiveKeys with many runtime-gated layers",
    async setup() {
      const resources = await createScenarioResources()
      registerModeLayerFields(resources.manager)
      resources.manager.setData("vim.mode", "normal")
      resources.manager.setData("vim.state", "idle")

      for (let index = 0; index < 320; index += 1) {
        resources.manager.registerLayer({
          scope: "global",
          mode: index % 2 === 0 ? "normal" : "visual",
          state: index % 3 === 0 ? "idle" : "busy",
          bindings: [
            { key: createKey(index), cmd: "noop" },
            { key: createKey(index + 1), cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_enabled_callback_heavy",
    description: "Repeated getActiveKeys with many callback-enabled layers",
    async setup() {
      const resources = await createScenarioResources()
      const enabledStates: boolean[] = []

      registerEnabledField(resources.manager)

      for (let index = 0; index < 320; index += 1) {
        enabledStates.push(index % 3 !== 0)
        resources.manager.registerLayer({
          scope: "global",
          enabled: () => enabledStates[index] ?? false,
          bindings: [
            { key: createKey(index), cmd: "noop" },
            { key: createKey(index + 1), cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_binding_sparse_data_churn",
    description: "Repeated setData and getActiveKeys with per-binding dependency keys",
    async setup() {
      const resources = await createScenarioResources()
      registerNamedBindingFields(resources.manager)

      for (let index = 0; index < 320; index += 1) {
        resources.manager.setData(createFlagKey(index), true)
        resources.manager.registerLayer({
          scope: "global",
          bindings: [
            {
              key: createKey(index),
              activeWhen: createFlagKey(index),
              cmd: "noop",
            },
          ],
        })
      }

      let iteration = 0

      return {
        resources,
        runIteration() {
          const key = createFlagKey(iteration % 320)
          const nextValue = iteration % 2 === 0
          resources.manager.setData(key, nextValue)
          resources.manager.getActiveKeys()
          iteration += 1
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_layer_sparse_data_churn",
    description: "Repeated setData and getActiveKeys with per-layer dependency keys",
    async setup() {
      const resources = await createScenarioResources()
      registerNamedLayerFields(resources.manager)

      for (let index = 0; index < 320; index += 1) {
        resources.manager.setData(createFlagKey(index), true)
        resources.manager.registerLayer({
          scope: "global",
          activeWhen: createFlagKey(index),
          bindings: [{ key: createKey(index), cmd: "noop" }],
        })
      }

      let iteration = 0

      return {
        resources,
        runIteration() {
          const key = createFlagKey(iteration % 320)
          const nextValue = iteration % 2 === 0
          resources.manager.setData(key, nextValue)
          resources.manager.getActiveKeys()
          iteration += 1
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_noop",
    description: "Repeated focus changes with a noop state listener",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      const offStateChange = registerStateChangeNoopListener(resources.manager)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_read_heavy",
    description: "Repeated focus changes with active key and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      const offStateChange = registerStateChangeReadListeners(resources.manager)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_metadata_read_heavy",
    description: "Repeated focus changes with active metadata and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = setupMetadataFocusTree(resources)
      const offStateChange = registerStateChangeMetadataListeners(resources.manager)
      const first = focusChain[0]
      const second = focusChain[1]
      let focusFirst = false

      if (!first || !second) {
        throw new Error("Expected metadata focus targets for metadata benchmark")
      }

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_bindings_read_heavy",
    description: "Repeated focus changes with active binding and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = setupMetadataFocusTree(resources)
      const offStateChange = registerStateChangeBindingListeners(resources.manager)
      const first = focusChain[0]
      const second = focusChain[1]
      let focusFirst = false

      if (!first || !second) {
        throw new Error("Expected metadata focus targets for binding benchmark")
      }

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_repeat_reads_5x",
    description: "Repeated focus changes followed by five active key reads",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          readActiveKeysRepeatedly(resources.manager, 5)
          focusFirst = !focusFirst
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_pending_blur_read_heavy",
    description: "Repeated pending sequence blur clears with state listeners",
    async setup() {
      const resources = await createScenarioResources()
      const target = createFocusableBox(resources.renderer, "state-pending-target")
      const offStateChange = registerStateChangeReadListeners(resources.manager)

      resources.renderer.root.add(target)
      resources.manager.registerLayer({
        target,
        bindings: [{ key: "dd", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          target.focus()
          resources.mockInput.pressKey("d")
          target.blur()
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_external_invalidation_read_heavy",
    description: "Repeated external keyed invalidation with state listeners",
    async setup() {
      const resources = await createScenarioResources()
      const flags: Record<string, boolean> = Object.create(null)
      const offStateChange = registerStateChangeReadListeners(resources.manager)

      registerExternalBindingFields(resources.manager, flags)

      for (let index = 0; index < 320; index += 1) {
        const key = createFlagKey(index)
        flags[key] = true
        resources.manager.registerLayer({
          scope: "global",
          bindings: [
            {
              key: createKey(index),
              activeExternally: key,
              cmd: "noop",
            },
          ],
        })
      }

      let iteration = 0

      return {
        resources,
        runIteration() {
          const key = createFlagKey(iteration % 320)
          flags[key] = iteration % 2 === 0
          resources.manager.invalidateRuntimeKey(key)
          iteration += 1
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_prefix_merge_heavy",
    description: "Repeated getActiveKeys with many overlapping prefixes across layers",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 160; index += 1) {
        resources.manager.registerLayer({
          scope: "global",
          bindings: [
            { key: "ga", cmd: "noop" },
            { key: "gb", cmd: "noop" },
            { key: "gc", cmd: "noop" },
            { key: "gd", cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          resources.manager.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_key_hooks_heavy",
    description: "Repeated key dispatch with many registered key hooks",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 80; index += 1) {
        resources.manager.onKeyInput(
          ({ event }) => {
            if (event.name === "z") {
              return
            }
          },
          { priority: index % 5 },
        )
      }

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_command_data_heavy",
    description: "Repeated matched dispatch while commands receive many runtime data fields",
    async setup() {
      const resources = await createScenarioResources()

      resources.manager.registerCommands([
        {
          name: "consume-data",
          run(ctx) {
            if (ctx.data["field-0"] === "value-0") {
              return
            }
          },
        },
      ])

      for (let index = 0; index < 20; index += 1) {
        resources.manager.setData(`field-${index}`, `value-${index}`)
      }

      resources.manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "consume-data" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
]

async function runScenario(scenario: BenchmarkScenario, args: BenchmarkArgs): Promise<BenchmarkResult> {
  const instance = await scenario.setup()

  try {
    for (let iteration = 0; iteration < args.warmupIterations; iteration += 1) {
      instance.runIteration()
    }

    let measuredIterations = args.iterations
    const calibrationStart = nowNs()
    for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
      instance.runIteration()
    }
    const calibrationDurationMs = nsToMs(nowNs() - calibrationStart)

    if (calibrationDurationMs > 0 && calibrationDurationMs < args.minSampleMs) {
      const scaledIterations = (measuredIterations * args.minSampleMs) / calibrationDurationMs
      measuredIterations = roundIterations(scaledIterations)
    }

    if (measuredIterations !== args.iterations) {
      for (let iteration = 0; iteration < Math.min(measuredIterations, args.warmupIterations); iteration += 1) {
        instance.runIteration()
      }
    }

    const samples: BenchmarkSample[] = []
    for (let round = 0; round < args.rounds; round += 1) {
      const start = nowNs()
      for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
        instance.runIteration()
      }
      const durationMs = nsToMs(nowNs() - start)
      samples.push({
        round: round + 1,
        durationMs,
        opsPerSecond: (measuredIterations * 1000) / durationMs,
      })
    }

    const durations = samples.map((sample) => sample.durationMs)
    const opsPerSecond = samples.map((sample) => sample.opsPerSecond)

    return {
      name: scenario.name,
      description: scenario.description,
      iterations: args.iterations,
      warmupIterations: args.warmupIterations,
      rounds: args.rounds,
      measuredIterations,
      medianDurationMs: median(durations),
      bestDurationMs: Math.min(...durations),
      medianOpsPerSecond: median(opsPerSecond),
      samples,
    }
  } finally {
    instance.cleanup()
  }
}

function formatNumber(value: number): string {
  return value.toFixed(2)
}

function printResults(results: BenchmarkResult[], args: BenchmarkArgs): void {
  console.log(
    `action-map-benchmark iters=${args.iterations} warmup=${args.warmupIterations} rounds=${args.rounds} min_sample_ms=${args.minSampleMs} scenarios=${results.length}`,
  )
  console.log("")

  const header = ["scenario", "iters", "median ms", "best ms", "median ops/sec"]
  const rows = results.map((result) => [
    result.name,
    String(result.measuredIterations),
    formatNumber(result.medianDurationMs),
    formatNumber(result.bestDurationMs),
    formatNumber(result.medianOpsPerSecond),
  ])

  const widths = header.map((title, index) => {
    return Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0))
  })

  const lines = [header, ...rows].map((row, rowIndex) => {
    const line = row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ")
    if (rowIndex !== 0) {
      return line
    }

    const divider = widths.map((width) => "-".repeat(width)).join("  ")
    return `${line}\n${divider}`
  })

  console.log(lines.join("\n"))
  console.log("")

  for (const result of results) {
    console.log(`${result.name}: ${result.description}`)
    for (const sample of result.samples) {
      console.log(
        `  round ${sample.round}: ${formatNumber(sample.durationMs)} ms (${formatNumber(sample.opsPerSecond)} ops/sec)`,
      )
    }
  }
}

function writeResults(results: BenchmarkResult[], args: BenchmarkArgs, jsonPath: string): void {
  const absolutePath = path.isAbsolute(jsonPath) ? jsonPath : path.resolve(process.cwd(), jsonPath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(
    absolutePath,
    JSON.stringify(
      {
        meta: {
          timestamp: new Date().toISOString(),
          iterations: args.iterations,
          warmupIterations: args.warmupIterations,
          rounds: args.rounds,
          cwd: process.cwd(),
          args: process.argv.slice(2),
        },
        results,
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const results: BenchmarkResult[] = []

  const selectedScenarios = args.scenarioNames
    ? scenarios.filter((scenario) => args.scenarioNames!.has(scenario.name))
    : scenarios

  if (selectedScenarios.length === 0) {
    throw new Error("No benchmark scenarios matched the provided --scenario filter")
  }

  for (const scenario of selectedScenarios) {
    results.push(await runScenario(scenario, args))
  }

  printResults(results, args)

  if (args.jsonPath) {
    writeResults(results, args, args.jsonPath)
  }
}

await main()
