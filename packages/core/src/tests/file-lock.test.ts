import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

const fixturePath = join(import.meta.dir, "file-lock.fixture.ts")
const fixtureCwd = join(import.meta.dir, "..", "..")

function spawnFixture(...args: string[]) {
  return Bun.spawn([process.execPath, fixturePath, ...args], {
    cwd: fixtureCwd,
    env: process.env,
    stdout: "ignore",
    stderr: "pipe",
  })
}

function runFixture(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, fixturePath, ...args], {
    cwd: fixtureCwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()

  if (result.exitCode !== 0) {
    throw new Error(`Fixture failed (${args.join(" ")}): ${stderr || stdout || "unknown error"}`)
  }

  return stdout ? JSON.parse(stdout) : null
}

async function waitForReady(path: string, timeout = 2_000): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    if (existsSync(path)) return
    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for ready marker: ${path}`)
}

test("FileLock.tryAcquire returns false while another process holds the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hold", lockPath, readyPath, "1000")

  try {
    await waitForReady(readyPath)

    expect(runFixture("try", lockPath)).toEqual({ acquired: false })
    expect(await holder.exited).toBe(0)
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.acquire waits until another process releases the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hold", lockPath, readyPath, "800")

  try {
    await waitForReady(readyPath)

    const result = runFixture("wait", lockPath) as { acquired: boolean; waited: number }

    expect(result.acquired).toBe(true)
    expect(result.waited).toBeGreaterThanOrEqual(250)
    expect(await holder.exited).toBe(0)
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock is released when the owning process exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hang", lockPath, readyPath)

  try {
    await waitForReady(readyPath)

    holder.kill()
    await holder.exited

    expect(runFixture("try", lockPath)).toEqual({ acquired: true })
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
