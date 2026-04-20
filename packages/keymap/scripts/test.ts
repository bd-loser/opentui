import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const testRuns = [
  {
    cwd: rootDir,
    args: [
      "test",
      "./src/keymap.test.ts",
      "./src/keymap.host.test.ts",
      "./src/html.test.ts",
      "./src/addons",
      "./src/react",
    ],
  },
  {
    cwd: resolve(rootDir, "src/solid"),
    args: ["test", "./index.test.tsx"],
  },
  {
    cwd: rootDir,
    args: ["run", "build"],
  },
  {
    cwd: rootDir,
    args: ["scripts/check-dist-exports.ts"],
  },
] as const

for (const run of testRuns) {
  const result = spawnSync("bun", run.args, {
    cwd: run.cwd,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
