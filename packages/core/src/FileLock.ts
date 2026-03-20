import { resolve } from "node:path"

import type { Pointer } from "bun:ffi"

import { resolveRenderLib } from "./zig"

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
      lock.close()
      throw error
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
      lock.close()
      throw error
    }
  }

  public readonly path: string
  public readonly handle: Pointer
  private readonly lib = resolveRenderLib()
  private held = false
  private closed = false

  private constructor(path: string) {
    this.path = resolve(path)
    this.handle = this.lib.createFileLock(this.path)
  }

  public get acquired(): boolean {
    return this.held
  }

  public acquire(): void {
    this.assertOpen()
    if (this.held) return

    this.lib.fileLockAcquire(this.handle)
    this.held = true
  }

  public tryAcquire(): boolean {
    this.assertOpen()
    if (this.held) return true

    const acquired = this.lib.fileLockTryAcquire(this.handle)
    this.held = acquired
    return acquired
  }

  public release(): void {
    if (this.closed || !this.held) return

    this.lib.fileLockRelease(this.handle)
    this.held = false
  }

  public close(): void {
    if (this.closed) return

    this.release()
    this.lib.destroyFileLock(this.handle)
    this.closed = true
  }

  public [Symbol.dispose](): void {
    this.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`FileLock is closed: ${this.path}`)
    }
  }
}
