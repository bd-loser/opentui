import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { expect, test } from "bun:test"

import { FileLock, FileLockError, type FileLockWaitTick } from "../FileLock"
import { resolveRenderLib } from "../zig"

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

function spawnFixtureWithOutput(...args: string[]) {
  return Bun.spawn([process.execPath, fixturePath, ...args], {
    cwd: fixtureCwd,
    env: process.env,
    stdout: "pipe",
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

async function readFixtureResult<T>(fixture: ReturnType<typeof spawnFixtureWithOutput>, args: string[]): Promise<T> {
  const [stdout, stderr, exitCode] = await Promise.all([
    fixture.stdout ? new Response(fixture.stdout).text() : Promise.resolve(""),
    fixture.stderr ? new Response(fixture.stderr).text() : Promise.resolve(""),
    fixture.exited,
  ])

  const trimmedStdout = stdout.trim()
  const trimmedStderr = stderr.trim()

  if (exitCode !== 0) {
    throw new Error(`Fixture failed (${args.join(" ")}): ${trimmedStderr || trimmedStdout || "unknown error"}`)
  }

  return JSON.parse(trimmedStdout) as T
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
    let error: unknown

    try {
      FileLock.tryAcquire(path, { createParentPath: false })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FileLockError)
    expect((error as FileLockError).code).toBe("file_not_found")
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

    let error: unknown

    try {
      FileLock.tryAcquire(path, { createIfMissing: false })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FileLockError)
    expect((error as FileLockError).code).toBe("file_not_found")
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock exposes invalid_path for invalid create inputs", () => {
  let error: unknown

  try {
    FileLock.open("")
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(FileLockError)
  expect((error as FileLockError).code).toBe("invalid_path")
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
    expect((error as FileLockError).code).toBe("closed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.tryAcquireWithTimeout exposes invalid_argument for invalid options", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const lock = FileLock.open(path)
  const holder = spawnFixture("hold", path, readyPath, "1000")

  try {
    let timeoutError: unknown

    try {
      await lock.tryAcquireWithTimeout({ timeoutMs: -1 })
    } catch (caught) {
      timeoutError = caught
    }

    expect(timeoutError).toBeInstanceOf(FileLockError)
    expect((timeoutError as FileLockError).code).toBe("invalid_argument")

    await waitForReady(readyPath)

    let tickTimeError: unknown

    try {
      await FileLock.tryAcquireWithTimeout(path, { tickTime: () => -1 })
    } catch (caught) {
      tickTimeError = caught
    }

    expect(tickTimeError).toBeInstanceOf(FileLockError)
    expect((tickTimeError as FileLockError).code).toBe("invalid_argument")
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    lock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveRenderLib file lock wrappers expose stable create error codes", () => {
  const lib = resolveRenderLib()

  let createError: unknown

  try {
    lib.createFileLock("shared.lock")
  } catch (caught) {
    createError = caught
  }

  expect(createError).toBeInstanceOf(Error)
  expect((createError as { code?: string }).code).toBe("invalid_path")
})

test("FileLock.release unlocks the file and lets the same instance acquire again", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.tryAcquire(path)

  if (!lock) {
    throw new Error("Expected to acquire the lock")
  }

  try {
    expect(lock.acquired).toBe(true)

    lock.release()
    expect(lock.acquired).toBe(false)
    expect(runFixture("try", path)).toEqual({ acquired: true })
    expect(lock.tryAcquire()).toBe(true)
    expect(lock.acquired).toBe(true)
  } finally {
    lock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.release is a no-op when the lock is not held", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.open(path)

  try {
    lock.release()
    expect(lock.acquired).toBe(false)

    expect(lock.tryAcquire()).toBe(true)
    lock.release()
    lock.release()

    expect(lock.acquired).toBe(false)
    expect(runFixture("try", path)).toEqual({ acquired: true })
  } finally {
    lock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock repeated tryAcquire and tryAcquireWithTimeout on the same instance return immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.tryAcquire(path)
  const ticks: FileLockWaitTick[] = []

  if (!lock) {
    throw new Error("Expected to acquire the lock")
  }

  try {
    expect(lock.tryAcquire()).toBe(true)
    expect(
      await lock.tryAcquireWithTimeout({
        timeoutMs: 100,
        waitTick: (tick) => {
          ticks.push(tick)
        },
      }),
    ).toBe(true)
    expect(ticks).toEqual([])
  } finally {
    lock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock Symbol.dispose releases and closes the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.tryAcquire(path)

  if (!lock) {
    throw new Error("Expected to acquire the lock")
  }

  try {
    lock[Symbol.dispose]()

    expect(runFixture("try", path)).toEqual({ acquired: true })
    expect(() => lock.tryAcquire()).toThrow(FileLockError)
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
      expect(ticks[0]?.delay).toBe(50)
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
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    expect(ticks[0]?.delay).toBe(50)
    expect(ticks[1]?.delay).toBe(50)
    expect(ticks[ticks.length - 1]?.waited).toBeLessThanOrEqual(120)
    expect(ticks[ticks.length - 1]?.waited).toBeGreaterThan(100)
  } finally {
    holder.kill()
    await holder.exited.catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.tryAcquireWithTimeout uses custom tickTime when provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")
  const readyPath = join(dir, "holder.ready")
  const holder = spawnFixture("hold", lockPath, readyPath, "120")
  const ticks: FileLockWaitTick[] = []

  try {
    await waitForReady(readyPath)

    const lock = await FileLock.tryAcquireWithTimeout(lockPath, {
      tickTime: (attempt) => attempt * 25,
      waitTick: (tick) => {
        ticks.push(tick)
      },
    })

    try {
      expect(lock).not.toBeNull()
      expect(lock?.acquired).toBe(true)
      expect(ticks.map((tick) => tick.delay)).toEqual([25, 50, 75])
    } finally {
      lock?.close()
    }
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

test("FileLock serializes repeated multi-process contention without overlap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const lockPath = join(dir, "shared.lock")

  try {
    for (let round = 0; round < 3; round += 1) {
      const fixtures = Array.from({ length: 4 }, (_, index) => {
        const args = ["contend", lockPath, `${round}-${index}`, "30", "2000", "10"]
        return {
          args,
          process: spawnFixtureWithOutput(...args),
        }
      })

      const results = await Promise.all(
        fixtures.map(({ process, args }) =>
          readFixtureResult<{ worker: string; acquiredAt: number; releasedAt: number }>(process, args),
        ),
      )

      expect(new Set(results.map((result) => result.worker)).size).toBe(4)

      const ordered = [...results].sort((a, b) => a.acquiredAt - b.acquiredAt)

      for (let index = 1; index < ordered.length; index += 1) {
        expect(ordered[index]?.acquiredAt).toBeGreaterThanOrEqual(ordered[index - 1]!.releasedAt)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
