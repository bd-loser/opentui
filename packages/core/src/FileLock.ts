import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { resolveRenderLib } from "./zig"

type FileLockOp = "create" | "tryAcquire" | "tryAcquireWithTimeout" | "release" | "close"

type FileLockErrorOptions = {
  path: string
  op: FileLockOp
  cause?: unknown
}

export interface FileLockOpenOptions {
  createIfMissing?: boolean
  createParentPath?: boolean
}

export interface FileLockWaitTick {
  file: string
  attempt: number
  delay: number
  waited: number
}

export type FileLockWait = (input: FileLockWaitTick) => void | Promise<void>

export interface FileLockWaitOptions {
  timeoutMs?: number
  waitTick?: FileLockWait
  signal?: AbortSignal
}

export interface FileLockTryAcquireWithTimeoutOptions extends FileLockOpenOptions, FileLockWaitOptions {}

export class FileLockError extends Error {
  public readonly path: string
  public readonly op: FileLockOp
  public override readonly cause?: unknown

  public constructor(message: string, options: FileLockErrorOptions) {
    super(message)
    this.name = "FileLockError"
    this.path = options.path
    this.op = options.op
    this.cause = options.cause
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "unknown error"
}

function normalizePath(path: string): string {
  if (typeof path !== "string") {
    throw new TypeError("FileLock path must be a string")
  }

  if (!path.trim()) {
    throw new Error("FileLock path must not be empty")
  }

  return resolve(path)
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(50 * attempt, 250)
}

function validateTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined

  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("FileLock timeoutMs must be a finite, non-negative number")
  }

  return timeoutMs
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason
  return new DOMException("Aborted", "AbortError")
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw abortReason(signal)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)

  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(id)
      reject(abortReason(signal))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function prepareLockPath(path: string, options: FileLockOpenOptions = {}): void {
  if (options.createParentPath !== false) {
    mkdirSync(dirname(path), { recursive: true })
  }

  if (options.createIfMissing === false) {
    if (!existsSync(path)) {
      throw new Error(`Lock file does not exist: ${path}`)
    }

    return
  }

  const fd = openSync(path, "a")
  closeSync(fd)
}

function wrapError(path: string, op: FileLockOp, error: unknown): FileLockError {
  if (error instanceof FileLockError) return error
  return new FileLockError(`${op} failed for ${path}: ${errorMessage(error)}`, {
    path,
    op,
    cause: error,
  })
}

export class FileLock {
  public static open(path: string, options?: FileLockOpenOptions): FileLock {
    return new FileLock(path, options)
  }

  public static tryAcquire(path: string, options?: FileLockOpenOptions): FileLock | null {
    const lock = FileLock.open(path, options)

    try {
      if (!lock.tryAcquire()) {
        lock.close()
        return null
      }
      return lock
    } catch (error) {
      FileLock.cleanup(lock, "tryAcquire", error)
    }
  }

  public static async tryAcquireWithTimeout(
    path: string,
    options: FileLockTryAcquireWithTimeoutOptions = {},
  ): Promise<FileLock | null> {
    const { createIfMissing, createParentPath, timeoutMs, waitTick, signal } = options
    const lock = FileLock.open(path, { createIfMissing, createParentPath })

    try {
      const acquired = await lock.tryAcquireWithTimeout({ timeoutMs, waitTick, signal })

      if (!acquired) {
        lock.close()
        return null
      }

      return lock
    } catch (error) {
      FileLock.throwAfterCleanup(lock, error)
    }
  }

  private static cleanup(lock: FileLock, op: FileLockOp, error: unknown): never {
    const wrapped = wrapError(lock.path, op, error)

    try {
      lock.close()
    } catch (closeError) {
      throw new FileLockError(`${wrapped.message}; cleanup failed: ${errorMessage(closeError)}`, {
        path: lock.path,
        op,
        cause: closeError,
      })
    }

    throw wrapped
  }

  private static throwAfterCleanup(lock: FileLock, error: unknown): never {
    try {
      lock.close()
    } catch (closeError) {
      throw wrapError(lock.path, "close", closeError)
    }

    throw error
  }

  public readonly path: string
  private readonly lib = resolveRenderLib()
  private id: number
  private held = false
  private closed = false

  private constructor(path: string, options: FileLockOpenOptions = {}) {
    this.path = normalizePath(path)

    try {
      prepareLockPath(this.path, options)
      this.id = this.lib.createFileLock(this.path)
    } catch (error) {
      throw wrapError(this.path, "create", error)
    }
  }

  public get acquired(): boolean {
    return this.held
  }

  public tryAcquire(): boolean {
    this.assertOpen("tryAcquire")
    if (this.held) return true

    try {
      const acquired = this.lib.fileLockTryAcquire(this.id)
      this.held = acquired
      return acquired
    } catch (error) {
      throw wrapError(this.path, "tryAcquire", error)
    }
  }

  public async tryAcquireWithTimeout(options: FileLockWaitOptions = {}): Promise<boolean> {
    const timeoutMs = validateTimeoutMs(options.timeoutMs)

    throwIfAborted(options.signal)

    if (this.tryAcquire()) {
      return true
    }

    let attempt = 0
    let waited = 0

    while (timeoutMs === undefined || waited < timeoutMs) {
      throwIfAborted(options.signal)

      attempt += 1

      const remaining = timeoutMs === undefined ? undefined : timeoutMs - waited
      const delay =
        remaining === undefined ? defaultRetryDelay(attempt) : Math.min(defaultRetryDelay(attempt), remaining)

      if (delay <= 0) {
        return false
      }

      waited += delay
      await options.waitTick?.({ file: this.path, attempt, delay, waited })
      await sleep(delay, options.signal)

      if (this.tryAcquire()) {
        return true
      }
    }

    return false
  }

  public release(): void {
    if (this.closed || !this.held) return

    try {
      this.lib.fileLockRelease(this.id)
      this.held = false
    } catch (error) {
      throw wrapError(this.path, "release", error)
    }
  }

  public close(): void {
    if (this.closed) return

    try {
      this.lib.destroyFileLock(this.id)
      this.held = false
      this.closed = true
      this.id = 0
    } catch (error) {
      throw wrapError(this.path, "close", error)
    }
  }

  public [Symbol.dispose](): void {
    this.close()
  }

  private assertOpen(op: FileLockOp): void {
    if (!this.closed) return
    throw new FileLockError(`FileLock is closed: ${this.path}`, { path: this.path, op })
  }
}
