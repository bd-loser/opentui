import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing.js"
import { getKeymapManager, type KeymapManager } from "../extras/keymap/index.js"

const DEFAULT_ITERATIONS = 20_000
const DEFAULT_WARMUP = 2_000
const DEFAULT_ROUNDS = 5
const KEY_POOL = "abcdefghijklmnopqrstuvwxyz0123456789"

interface BenchmarkArgs {
  iterations: number
  warmupIterations: number
  rounds: number
  jsonPath?: string
}

interface ScenarioResources {
  renderer: TestRenderer
  mockInput: MockInput
  manager: KeymapManager
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

    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length)
    }
  }

  return {
    iterations,
    warmupIterations,
    rounds,
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

function registerGlobalLayers(manager: KeymapManager, count: number, cmd = "noop"): void {
  for (let index = 0; index < count; index += 1) {
    manager.registerLayer({
      scope: "global",
      priority: index % 3,
      bindings: [{ key: createKey(index), cmd }],
    })
  }
}

function registerTargetLayer(
  manager: KeymapManager,
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

function registerModeBindingFields(manager: KeymapManager): void {
  manager.registerBindingFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

async function createScenarioResources(): Promise<ScenarioResources> {
  const testSetup = await createTestRenderer({ width: 80, height: 24 })
  const manager = getKeymapManager(testSetup.renderer)
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
  let parent = resources.renderer.root as BoxRenderable

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

    const samples: BenchmarkSample[] = []
    for (let round = 0; round < args.rounds; round += 1) {
      const start = nowNs()
      for (let iteration = 0; iteration < args.iterations; iteration += 1) {
        instance.runIteration()
      }
      const durationMs = nsToMs(nowNs() - start)
      samples.push({
        round: round + 1,
        durationMs,
        opsPerSecond: (args.iterations * 1000) / durationMs,
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
    `keymap-benchmark iters=${args.iterations} warmup=${args.warmupIterations} rounds=${args.rounds} scenarios=${results.length}`,
  )
  console.log("")

  const header = ["scenario", "median ms", "best ms", "median ops/sec"]
  const rows = results.map((result) => [
    result.name,
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

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, args))
  }

  printResults(results, args)

  if (args.jsonPath) {
    writeResults(results, args, args.jsonPath)
  }
}

await main()
