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
    args: ["test", "./tests", "./keymap/keymap.test.ts", "./keymap/addons", "./keymap/react"],
  },
  {
    cwd: resolve(rootDir, "keymap/solid"),
    args: ["test", "./index.test.tsx"],
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
