import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { FileLock, FileLockError } from "../FileLock"

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

test("FileLock.acquire creates missing parent directories and files by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "missing", "shared.lock")

  try {
    const lock = FileLock.acquire(path)

    try {
      expect(lock.acquired).toBe(true)
      expect(existsSync(join(dir, "missing"))).toBe(true)
      expect(existsSync(path)).toBe(true)
    } finally {
      lock.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.tryAcquire also creates missing parent directories and files by default", () => {
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

test("FileLock respects createParentPath: false when the parent directory is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "missing", "shared.lock")

  try {
    expect(() => FileLock.acquire(path, { createParentPath: false })).toThrow(FileLockError)
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

    expect(() => FileLock.acquire(path, { createIfMissing: false })).toThrow(FileLockError)
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

    const lock = FileLock.acquire(path, {
      createIfMissing: false,
      createParentPath: false,
    })

    try {
      expect(lock.acquired).toBe(true)
    } finally {
      lock.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("FileLock.close is idempotent and closed locks throw on reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentui-file-lock-"))
  const path = join(dir, "shared.lock")
  const lock = FileLock.open(path)

  try {
    lock.close()
    lock.close()

    expect(() => lock.acquire()).toThrow(FileLockError)
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
