export type FileLockOp = "create" | "tryAcquire" | "tryAcquireWithTimeout" | "release" | "close"

export type FileLockErrorCode =
  | "invalid_path"
  | "access_denied"
  | "file_not_found"
  | "locks_not_supported"
  | "system_resources"
  | "out_of_memory"
  | "unexpected"
  | "closing"
  | "closed"
  | "invalid_argument"

export class FileLockError extends Error {
  public readonly code: FileLockErrorCode
  public readonly path: string
  public readonly op: FileLockOp
  public override readonly cause?: unknown

  public constructor(options: {
    path: string
    op: FileLockOp
    code?: FileLockErrorCode
    cause?: unknown
    message?: string
  }) {
    const code = options.code ?? "unexpected"

    let detail = options.message

    if (!detail) {
      if (options.cause instanceof Error && options.cause.message) {
        detail = options.cause.message
      } else if (typeof options.cause === "string" && options.cause) {
        detail = options.cause
      } else {
        detail = code
      }
    }

    super(options.message ?? `${options.op} failed for ${options.path}: ${detail}`)
    this.name = "FileLockError"
    this.code = code
    this.path = options.path
    this.op = options.op
    this.cause = options.cause
  }
}
