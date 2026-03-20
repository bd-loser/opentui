import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { expect, test } from "bun:test"

import { FileLock, FileLockError, type FileLockWaitTick } from "../FileLock"

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
    await sleep(20)
  }

  throw new Error(`Timed out waiting for ready marker: ${path}`)
}

test("FileLock.tryAcquire creates missing parent directories and files by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "missing", "shared.lock")
  const lock = FileLock.tryAcquire(path)

  try {
    expect(lock).not.toBeNull()
    expect(lock?.acquired).toBe(true)
    expect(existsSync(join(dir, "missing"))).toBe(true)
    expect(existsSync(path)).toBe(true)
  } finally {
    lock?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.open creates missing parent directories and files by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "missing", "shared.lock")
  const lock = FileLock.open(path)

  try {
    expect(lock.acquired).toBe(false)
    expect(lock.tryAcquire()).toBe(true)
    expect(existsSync(join(dir, "missing"))).toBe(true)
    expect(existsSync(path)).toBe(true)
  } finally {
    lock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock respects createParentPath: false when the parent directory is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "missing", "shared.lock")

  try {
    expect(() => FileLock.tryAcquire(path, { createParentPath: false })).toThrow(FileLockError)
    expect(existsSync(join(dir, "missing"))).toBe(false)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock respects createIfMissing: false when the lock file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "locks", "shared.lock")

  try {
    mkdirSync(join(dir, "locks"), { recursive: true })

    expect(() => FileLock.tryAcquire(path, { createIfMissing: false })).toThrow(FileLockError)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock strict create options succeed when the lock file already exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "locks", "shared.lock")

  try {
    mkdirSync(join(dir, "locks"), { recursive: true })
    const fd = openSync(path, "a")
    closeSync(fd)

    const lock = FileLock.tryAcquire(path, {
      createIfMissing: false,
      createParentPath: false,
    })

    try {
      expect(lock).not.toBeNull()
      expect(lock?.acquired).toBe(true)
    } finally {
      lock?.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.close is idempotent and closed locks throw on reuse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.open(path)

  try {
    lock.close()
    lock.close()

    expect(() => lock.tryAcquire()).toThrow(FileLockError)

    let error: unknown

    try {
      await lock.tryAcquireWithTimeout({ timeoutMs: 10 })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FileLockError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

test("FileLock.tryAcquireWithTimeout waits asynchronously and emits wait ticks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hold", lockPath, readyPath, "250")
  const ticks: FileLockWaitTick[] = []

  try {
    await waitForReady(readyPath)

    const timer = sleep(20).then(() => "timer")
    const pending = FileLock.tryAcquireWithTimeout(lockPath, {
      timeoutMs: 1_000,
      waitTick: (tick) => {
        ticks.push(tick)
      },
    })

    expect(await Promise.race([timer, pending.then(() => "lock")])).toBe("timer")

    const lock = await pending

    try {
      expect(lock).not.toBeNull()
      expect(lock?.acquired).toBe(true)
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks[0]?.attempt).toBe(1)
      expect(ticks[0]?.delay).toBeGreaterThan(0)
      expect(ticks[ticks.length - 1]?.waited).toBeGreaterThan(0)
      expect(await holder.exited).toBe(0)
    } finally {
      lock?.close()
    }
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.tryAcquireWithTimeout returns null after the timeout expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hold", lockPath, readyPath, "1000")
  const ticks: FileLockWaitTick[] = []

  try {
    await waitForReady(readyPath)

    const lock = await FileLock.tryAcquireWithTimeout(lockPath, {
      timeoutMs: 120,
      waitTick: (tick) => {
        ticks.push(tick)
      },
    })

    expect(lock).toBeNull()
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks[ticks.length - 1]?.waited).toBe(120)
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.tryAcquireWithTimeout respects AbortSignal while waiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hang", lockPath, readyPath)

  try {
    await waitForReady(readyPath)

    const controller = new AbortController()
    const reason = new Error("stop waiting")
    const pending = FileLock.tryAcquireWithTimeout(lockPath, {
      signal: controller.signal,
    })

    await sleep(60)
    controller.abort(reason)

    let error: unknown

    try {
      await pending
    } catch (caught) {
      error = caught
    }

    expect(error).toBe(reason)
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
