# FileLock Hardening Plan

## Scope

This plan is based on the review of the `system-locks` branch relative to `main`.

Goals for the remaining follow-up work:

- preserve original failures when cleanup also fails
- finish the docs around the current public contract
- leave the implementation in a state that is ready for later cross-platform CI verification

Explicit constraints for this work:

- keep `resolveRenderLib()` in `packages/core/src/FileLock.ts` as-is
- do not add CI work as part of this change; cross-platform CI verification will happen later after implementation is done
- do not push anything to the remote repository during this work

## Current Implementation Snapshot

Relevant files and their current roles:

- `packages/core/src/FileLock.ts`: thin TypeScript wrapper around native file-lock pointers plus async retry logic for `tryAcquireWithTimeout()`
- `packages/core/src/zig.ts`: FFI symbol declarations and thin file-lock wrappers that surface `FileLockError`
- `packages/core/src/zig/file-lock.zig`: native file lock implementation, direct pointer lifecycle, native `createIfMissing` / `createParentPath` handling
- `packages/core/src/tests/file-lock.test.ts`: subprocess-based behavioural tests plus public/native error-code assertions
- `packages/core/src/tests/file-lock.fixture.ts`: helper process used by the behavioural tests
- `packages/core/src/zig/tests/file-lock_test.zig`: native unit tests

Current behaviour summary:

- `FileLock.open(path, options?)`, `FileLock.tryAcquire(path, options?)`, and `FileLock.tryAcquireWithTimeout(path, options?)` normalize the path in TypeScript and pass create options through to native code
- native create now handles missing parent creation and missing-file creation based on `createParentPath` / `createIfMissing`
- there is no registry anymore; TypeScript holds a native `FileLock` pointer directly
- there is no blocking acquire API in TypeScript or Zig; all lock contention handling goes through immediate native `tryAcquire()` plus asynchronous retry logic in `FileLock.ts`
- public `FileLockError`s expose stable `code`, `path`, `op`, and `cause`
- the TypeScript behavioural suite covers friendly defaults, strict opt-outs, timeout waiting, aborts, lifecycle semantics, `Symbol.dispose`, repeated contention, and stable error-code assertions
- the native test suite covers invalid handles, direct pointer lifecycle, one-shot create-and-try-acquire busy handling, and repeated create/tryAcquire/release/destroy cycles

## Remaining Work

### 1. Cleanup error preservation in `packages/core/src/FileLock.ts`

The remaining public error-model gap is cleanup failure handling:

- when an operation fails and `close()` also fails, preserve the original failure instead of replacing it with the cleanup failure
- keep the stable public `code`, `path`, `op`, and `cause` surface intact
- add targeted tests once that behavior is finalized

### 2. Documentation updates

Add or update docs in `packages/core/README.md` and/or `packages/core/docs`.

Document:

- what `FileLock` is for
- the default friendly behaviour (`createIfMissing: true`, `createParentPath: true`)
- the strict opt-out flags
- the non-blocking `tryAcquireWithTimeout()` semantics, including timeout, configurable `tickTime`, abort, and wait-tick behaviour
- the lifecycle contract for `tryAcquire`, `tryAcquireWithTimeout`, `release`, `close`, and `Symbol.dispose`
- that dedicated `.lock` files may remain on disk after release, which is expected
- that lock support depends on the underlying filesystem and platform capabilities

The docs should set expectations clearly for local filesystems and make it obvious that the API is advisory OS locking, not a distributed lock service.

## File-By-File Checklist

`packages/core/src/FileLock.ts`

- preserve original failures when cleanup also fails

`packages/core/README.md` and/or `packages/core/docs/*`

- document the final public contract

## Recommended Implementation Order

1. Finish cleanup error preservation in `packages/core/src/FileLock.ts`.
2. Update docs.
3. Run local verification only.

## Local Verification Plan

Because this work changes Zig/native code, local verification should include both build and test passes.

Recommended commands:

- from the repo root: `bun run build`
- from `packages/core`: `bun test src/tests/file-lock.test.ts`
- from `packages/core`: `bun run test:native`

To reduce flake risk before handing off for the later CI run:

- repeat the behavioural contention tests multiple times locally
- repeat the native file-lock tests multiple times locally

This plan intentionally does not include CI workflow changes or CI execution. Final cross-platform verification across Linux, macOS, and Windows will happen later after the implementation is complete.

## Done Criteria

This follow-up is complete when all of the following are true:

- cleanup failures preserve the original failure instead of hiding it
- the docs describe the real public contract clearly
