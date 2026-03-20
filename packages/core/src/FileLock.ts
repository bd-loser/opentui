import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { resolveRenderLib } from "./zig"

type FileLockOp = "create" | "acquire" | "tryAcquire" | "release" | "close"

type FileLockErrorOptions = {
  path: string
  op: FileLockOp
  cause?: unknown
}

export interface FileLockOpenOptions {
  createIfMissing?: boolean
  createParentPath?: boolean
}

export interface FileLockAcquireOptions extends FileLockOpenOptions {}

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

  public static acquire(path: string, options?: FileLockAcquireOptions): FileLock {
    const lock = FileLock.open(path, options)

    try {
      lock.acquire()
      return lock
    } catch (error) {
      FileLock.cleanup(lock, "acquire", error)
    }
  }

  public static tryAcquire(path: string, options?: FileLockAcquireOptions): FileLock | null {
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
