import { resolve } from "node:path"

import { resolveRenderLib } from "./zig"

type FileLockOp = "create" | "acquire" | "tryAcquire" | "release" | "close"

type FileLockErrorOptions = {
  path: string
  op: FileLockOp
  cause?: unknown
}

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

function wrapError(path: string, op: FileLockOp, error: unknown): FileLockError {
  if (error instanceof FileLockError) return error
  return new FileLockError(`${op} failed for ${path}: ${errorMessage(error)}`, {
    path,
    op,
    cause: error,
  })
}

export class FileLock {
  public static open(path: string): FileLock {
    return new FileLock(path)
  }

  public static acquire(path: string): FileLock {
    const lock = new FileLock(path)

    try {
      lock.acquire()
      return lock
    } catch (error) {
      FileLock.cleanup(lock, "acquire", error)
    }
  }

  public static tryAcquire(path: string): FileLock | null {
    const lock = new FileLock(path)

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

  public readonly path: string
  private readonly lib = resolveRenderLib()
  private id: number
  private held = false
  private closed = false

  private constructor(path: string) {
    this.path = normalizePath(path)

    try {
      this.id = this.lib.createFileLock(this.path)
    } catch (error) {
      throw wrapError(this.path, "create", error)
    }
  }

  public get acquired(): boolean {
    return this.held
  }

  public acquire(): void {
    this.assertOpen("acquire")
    if (this.held) return

    try {
      this.lib.fileLockAcquire(this.id)
      this.held = true
    } catch (error) {
      throw wrapError(this.path, "acquire", error)
    }
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
