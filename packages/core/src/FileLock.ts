import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { FileLockError, type FileLockOp } from "./FileLockError"
import { resolveRenderLib } from "./zig"

export { FileLockError } from "./FileLockError"

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

export interface FileLockTryAcquireWithTimeoutOptions {
  createIfMissing?: boolean
  createParentPath?: boolean
  timeoutMs?: number
  tickTime?: (attempt: number) => number
  waitTick?: (input: FileLockWaitTick) => void | Promise<void>
  signal?: AbortSignal
}

function preparePath(path: string, options: FileLockOpenOptions = {}): string {
  const inputPath = typeof path === "string" ? path : String(path)

  if (typeof path !== "string") {
    throw new FileLockError({
      path: inputPath,
      op: "create",
      code: "invalid_path",
      message: `create failed for ${inputPath}: FileLock path must be a string`,
    })
  }

  if (!path.trim()) {
    throw new FileLockError({
      path,
      op: "create",
      code: "invalid_path",
      message: `create failed for ${path}: FileLock path must not be empty`,
    })
  }

  const resolvedPath = resolve(path)

  try {
    if (options.createParentPath !== false) {
      mkdirSync(dirname(resolvedPath), { recursive: true })
    }

    if (options.createIfMissing === false) {
      if (!existsSync(resolvedPath)) {
        throw new FileLockError({
          path: resolvedPath,
          op: "create",
          code: "file_not_found",
          message: `create failed for ${resolvedPath}: Lock file does not exist: ${resolvedPath}`,
        })
      }
    } else {
      closeSync(openSync(resolvedPath, "a"))
    }
  } catch (error) {
    if (error instanceof FileLockError) {
      throw error
    }

    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new FileLockError({ path: resolvedPath, op: "create", code: "file_not_found", cause: error })
      }

      if (error.code === "EACCES" || error.code === "EPERM") {
        throw new FileLockError({ path: resolvedPath, op: "create", code: "access_denied", cause: error })
      }
    }

    throw new FileLockError({ path: resolvedPath, op: "create", cause: error })
  }

  return resolvedPath
}

export class FileLock {
  public static open(path: string, options?: FileLockOpenOptions): FileLock {
    const resolvedPath = preparePath(path, options)
    return new FileLock(resolvedPath, resolveRenderLib().createFileLock(resolvedPath))
  }

  public static tryAcquire(path: string, options?: FileLockOpenOptions): FileLock | null {
    const resolvedPath = preparePath(path, options)
    const id = resolveRenderLib().createFileLockAndTryAcquire(resolvedPath)
    return id === null ? null : new FileLock(resolvedPath, id, true)
  }

  public static async tryAcquireWithTimeout(
    path: string,
    options: FileLockTryAcquireWithTimeoutOptions = {},
  ): Promise<FileLock | null> {
    const lock = FileLock.open(path, options)

    try {
      if (!(await lock.tryAcquireWithTimeout(options))) {
        lock.close()
        return null
      }

      return lock
    } catch (error) {
      try {
        lock.close()
      } catch {}

      throw error
    }
  }

  public readonly path: string
  private readonly lib = resolveRenderLib()
  private id: number
  private held = false
  private closed = false

  private constructor(path: string, id: number, held = false) {
    this.path = path
    this.id = id
    this.held = held
  }

  public get acquired(): boolean {
    return this.held
  }

  public tryAcquire(): boolean {
    this.assertOpen("tryAcquire")

    if (this.held) {
      return true
    }

    this.held = this.lib.fileLockTryAcquire(this.id)
    return this.held
  }

  public async tryAcquireWithTimeout(
    options: {
      timeoutMs?: number
      tickTime?: (attempt: number) => number
      waitTick?: (input: FileLockWaitTick) => void | Promise<void>
      signal?: AbortSignal
    } = {},
  ): Promise<boolean> {
    this.assertOpen("tryAcquireWithTimeout")

    if (this.held) {
      return true
    }

    if (
      options.timeoutMs !== undefined &&
      (typeof options.timeoutMs !== "number" || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
    ) {
      throw new FileLockError({
        path: this.path,
        op: "tryAcquireWithTimeout",
        code: "invalid_argument",
        message: `tryAcquireWithTimeout failed for ${this.path}: FileLock timeoutMs must be a finite, non-negative number`,
      })
    }

    const tickTime = options.tickTime ?? (() => 50)
    const start = Date.now()
    let attempt = 0
    let waited = 0

    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
      }

      if (this.tryAcquire()) {
        return true
      }

      const elapsed = Date.now() - start

      if (options.timeoutMs !== undefined && elapsed >= options.timeoutMs) {
        return false
      }

      attempt += 1

      const nextDelay = tickTime(attempt)

      if (typeof nextDelay !== "number" || !Number.isFinite(nextDelay) || nextDelay < 0) {
        throw new FileLockError({
          path: this.path,
          op: "tryAcquireWithTimeout",
          code: "invalid_argument",
          message: `tryAcquireWithTimeout failed for ${this.path}: FileLock tickTime must return a finite, non-negative number`,
        })
      }

      const delay =
        options.timeoutMs === undefined ? nextDelay : Math.min(nextDelay, Math.max(options.timeoutMs - elapsed, 0))

      waited += delay
      await options.waitTick?.({ file: this.path, attempt, delay, waited })

      try {
        await sleep(delay, undefined, options.signal ? { signal: options.signal } : undefined)
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? error
        }

        throw error
      }
    }
  }

  public release(): void {
    if (this.closed || !this.held) {
      return
    }

    this.lib.fileLockRelease(this.id)
    this.held = false
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.lib.destroyFileLock(this.id)
    this.held = false
    this.closed = true
    this.id = 0
  }

  public [Symbol.dispose](): void {
    this.close()
  }

  private assertOpen(op: FileLockOp): void {
    if (!this.closed) {
      return
    }

    throw new FileLockError({
      code: "closed",
      path: this.path,
      op,
      message: `FileLock is closed: ${this.path}`,
    })
  }
}
