import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

test("HTML example only imports exported names from the html entrypoint", async () => {
  const source = readFileSync(resolve(import.meta.dir, "..", "..", "examples", "keymap-html", "app.ts"), "utf8")
  const match = source.match(/import\s*\{([\s\S]*?)\}\s*from\s*"\/dist\/html\.js"/)

  expect(match).not.toBeNull()

  const requestedNames = (match?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("type "))

  const html = await import("../html.js")

  for (const name of requestedNames) {
    expect(name in html).toBe(true)
  }
})
