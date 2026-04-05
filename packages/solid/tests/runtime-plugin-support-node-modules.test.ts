import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("solid runtime plugin support in node_modules", () => {
  it("rewrites runtime module specifiers for external node_modules modules", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support-node-modules.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr.toString().trim()

    if (stdout) {
      console.debug(`[runtime-plugin-support-node-modules.fixture] stdout:\n${stdout}`)
    }

    if (stderr) {
      console.debug(`[runtime-plugin-support-node-modules.fixture] stderr:\n${stderr}`)
    }

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("solid=true")
    expect(stdout).toContain("core=true")
    expect(stdout).toContain("coreTesting=true")
    expect(stdout).toContain("solidJs=true")
    expect(stdout).toContain("cjs=true")
    expect(stdout).toContain("esmPackage=true")
    expect(stdout).toContain("solidStore=true")
  })
})
