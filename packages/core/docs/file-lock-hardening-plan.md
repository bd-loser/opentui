# FileLock Hardening Plan

## Scope

This plan is based on the review of the `system-locks` branch relative to `main`.

Goals for the remaining follow-up work:

- close the known completeness and reliability gaps
- make error handling exhaustive and programmatic
- expand the tests so they cover the real behaviour of the feature
- leave the implementation in a state that is ready for later cross-platform CI verification

Explicit constraints for this work:

- keep `resolveRenderLib()` in `packages/core/src/FileLock.ts` as-is
- leave the global `fileLockRegistry` lifetime in `packages/core/src/zig/lib.zig` as-is for now
- do not add CI work as part of this change; cross-platform CI verification will happen later after implementation is done
- do not push anything to the remote repository during this work

## Current Implementation Snapshot

Relevant files and their current roles:

- `packages/core/src/FileLock.ts`: public TypeScript API, path normalization/preparation, non-blocking retry helper, error wrapping, lifecycle methods
- `packages/core/src/zig.ts`: FFI symbol declarations and the TypeScript wrapper around the native library
- `packages/core/src/zig-structs.ts`: FFI struct packing/unpacking helpers
- `packages/core/src/zig/file-lock.zig`: native file lock implementation and registry/handle management
- `packages/core/src/zig/lib.zig`: exported native functions and the process-global registry instance
- `packages/core/src/tests/file-lock.test.ts`: subprocess-based TypeScript behavioural tests
- `packages/core/src/tests/file-lock.fixture.ts`: helper process used by the behavioural tests
- `packages/core/src/zig/tests/file-lock_test.zig`: native unit tests

Current behaviour summary:

- `FileLock.open(path, options?)`, `FileLock.tryAcquire(path, options?)`, and `FileLock.tryAcquireWithTimeout(path, options?)` normalize the path, create missing parent directories and lock files by default, and support strict opt-out via `createParentPath: false` and `createIfMissing: false`
- there is no blocking acquire API in TypeScript or Zig; all lock contention handling goes through immediate `tryAcquire()` plus asynchronous retry logic in `FileLock.ts`
- `FileLock.tryAcquireWithTimeout()` retries without blocking the event loop, supports `timeoutMs`, `waitTick`, and `signal`, and returns `null` on timeout
- the native layer currently uses `std.fs.File.tryLock(.exclusive)` for lock attempts
- the native `open()` path still implicitly creates the file if it does not exist, so the remaining native follow-up should make that path strict existing-file-only
- TypeScript status decoding in `packages/core/src/zig.ts` is not exhaustive; status `9` (`unexpected`) is still not handled explicitly from a single source of truth
- TypeScript tests now cover friendly defaults, strict opt-outs, timeout waiting, aborts, and a few lifecycle/contention cases, but not the full lifecycle/stress matrix yet

## Key Insights That Drive This Plan

1. Path preparation and retry orchestration belong in `packages/core/src/FileLock.ts`, not in the FFI surface.

   `FileLock.ts` is the public API and the only current caller of `createFileLock()`. The ergonomic setup and async retry loop are now there, and the remaining work should preserve that split so the native create ABI can stay small and strict.

2. There should be no fully blocking acquire path anywhere in the stack.

   Immediate native `tryLock()` plus asynchronous JavaScript retry is sufficient for the current API needs and avoids blocking the main thread while a lock is contended.

3. The remaining native work is about strictness and exhaustiveness, not waiting semantics.

   The native layer should stay immediate-only for lock attempts. The follow-up there is to make create strict existing-file-only and keep status mapping exhaustive and stable.

4. Behavioural locking semantics should continue to be tested at the process level.

   The TypeScript test layer is the right place to verify real cross-process locking because it can spawn independent processes that contend on the same path. Zig tests should focus on native statuses and lifecycle guarantees exposed by the native API, not mutex internals or ref counts.

## Desired End State

The public API should settle on these semantics:

```ts
type FileLockTryAcquireWithTimeoutOptions = FileLockOpenOptions & {
  timeoutMs?: number
  signal?: AbortSignal
  waitTick?: (tick: { file: string; attempt: number; delay: number; waited: number }) => void | Promise<void>
}
```

Public surface:

- `FileLock.open(path, options?)`
- `FileLock.tryAcquire(path, options?)`
- `FileLock.tryAcquireWithTimeout(path, options?)`
- `lock.tryAcquire()` remains immediate and non-blocking
- `lock.tryAcquireWithTimeout(options?)` retries asynchronously and non-blockingly on the existing handle

Default behaviour:

- if parent directories are missing, create them
- if the lock file is missing, create it
- then open the native lock handle
- then try-acquire immediately or retry asynchronously as requested

Strict opt-out behaviour:

- `createParentPath: false` means missing parent directories remain an error
- `createIfMissing: false` means missing lock file remains an error

Timeout behaviour:

- `tryAcquire()` remains immediate and returns `false` on contention
- `tryAcquireWithTimeout({ timeoutMs })` retries asynchronously up to the requested bound and returns `null` / `false` on timeout
- `tryAcquireWithTimeout()` without `timeoutMs` may keep retrying until success or abort, but it must never block the main thread
- `signal` aborts waiting and rethrows the abort reason

Error surface:

- every native status is handled explicitly
- public errors expose a stable `code` in addition to message, `path`, `op`, and `cause`
- cleanup failures do not erase the original error

Lifecycle behaviour:

- `close()` stays idempotent
- same-instance repeated `tryAcquire()` / `tryAcquireWithTimeout()` behaviour should be explicitly documented and tested
- `release()` behaviour should be explicitly documented and tested instead of remaining an implicit side effect

## Detailed Implementation Plan

### 1. Remaining public API work in `packages/core/src/FileLock.ts`

The non-blocking retry path now lives in `FileLock.ts` and should stay there. The remaining work in this file is:

- extend `FileLockError` with a stable `code` field
- keep `path`, `op`, and `cause`
- map pre-create filesystem failures to the same public code namespace used for native errors where possible, for example:
  - `invalid_path`
  - `access_denied`
  - `file_not_found`
  - `system_resources`
  - `unexpected`
- use a small TS-only code such as `closed` only when the failure comes from API misuse before any native call happens
- update cleanup so a `close()` failure augments the original failure instead of replacing it
- document and test the chosen behaviour of repeated `tryAcquire()` / `tryAcquireWithTimeout()` and `release()` on the same instance

### 2. Remaining native work in `packages/core/src/zig/file-lock.zig`

Make native create strict and explicit:

- remove the current implicit `createFileAbsolute()` fallback from `open()`
- after this change, native `open()` should only open an existing absolute file
- the public TypeScript layer remains responsible for the friendly default behaviour

Other native details:

- keep `FileLock.tryAcquire()` immediate
- keep `statusFromError()` exhaustive
- preserve the existing machine-stable integer status codes

### 3. FFI cleanup in `packages/core/src/zig.ts`

Keep native create ABI small:

- keep `createFileLock(pathPtr, pathLen, outPtr)` as-is
- no create-options struct is needed while path preparation stays in `FileLock.ts`

Make status handling exhaustive in `packages/core/src/zig.ts`:

- replace the current ad-hoc `switch` in `fileLockStatus()` with a single status table or exhaustive constant map
- explicitly include every current status, including the currently missing `unexpected`
- keep a single source of truth for these status names to avoid future drift

Wrapper behaviour in `zig.ts`:

- `createFileLock()` keeps its current ABI and error flow
- `fileLockTryAcquire()` keeps returning `false` only for `busy` and throws for all other statuses
- surface stable public error codes instead of relying on message parsing alone

### 4. Behavioural tests in `packages/core/src/tests/file-lock.test.ts`

Keep the TypeScript suite black-box and process-based.

The friendly-default, strict-opt-out, timeout, and abort cases are now covered. The remaining additions are:

- release then re-acquire on the same instance
- explicit contract test for repeated `tryAcquire()` / `tryAcquireWithTimeout()` on the same instance
- explicit contract test for `release()`
- `Symbol.dispose` releases/cleans up correctly
- repeated contention/stress coverage with multiple subprocesses contending for the same lock path

Keep the contention tests behavioural:

- continue using subprocesses and real filesystem paths
- do not mock the native layer
- do not assert handle ids, internal registry state, or retry counts

### 5. Native tests in `packages/core/src/zig/tests/file-lock_test.zig`

Add native coverage for the remaining semantics without asserting internals.

Recommended cases:

- strict create behaviour: native create fails with `file_not_found` when the public layer has not pre-created the file
- invalid handles still return `invalid_handle`
- destroy still removes the handle
- repeated create/tryAcquire/release/destroy cycles complete cleanly

### 6. Documentation updates

Add or update docs in `packages/core/README.md` and/or `packages/core/docs`.

Document:

- what `FileLock` is for
- the default friendly behaviour (`createIfMissing: true`, `createParentPath: true`)
- the strict opt-out flags
- the non-blocking `tryAcquireWithTimeout()` semantics, including timeout, abort, and wait-tick behaviour
- the lifecycle contract for `tryAcquire`, `tryAcquireWithTimeout`, `release`, `close`, and `Symbol.dispose`
- that dedicated `.lock` files may remain on disk after release, which is expected
- that lock support depends on the underlying filesystem and platform capabilities

The docs should set expectations clearly for local filesystems and make it obvious that the API is advisory OS locking, not a distributed lock service.

## File-By-File Checklist

`packages/core/src/FileLock.ts`

- add stable `FileLockError.code`
- improve cleanup error preservation
- document/test explicit lifecycle semantics

`packages/core/src/zig/file-lock.zig`

- make native `open()` strict existing-file-only
- keep try-acquire immediate and exhaustive on errors

`packages/core/src/zig.ts`

- centralize and exhaustively handle file-lock statuses
- surface stable error codes

`packages/core/src/zig-structs.ts`

- no change expected unless implementation later chooses richer result structs

`packages/core/src/tests/file-lock.test.ts`

- add lifecycle tests
- add stress/flake-resistance tests

`packages/core/src/tests/file-lock.fixture.ts`

- add only the fixture modes needed by the remaining tests

`packages/core/src/zig/tests/file-lock_test.zig`

- add strict-create coverage
- add repeated lifecycle coverage

`packages/core/README.md` and/or `packages/core/docs/*`

- document the final public contract

## Recommended Implementation Order

1. Make native create strict in `packages/core/src/zig/file-lock.zig`.
2. Clean up exhaustive status/error handling in `packages/core/src/zig.ts`.
3. Finish the public error model and lifecycle contract in `packages/core/src/FileLock.ts`.
4. Expand the remaining TypeScript behavioural tests and fixture.
5. Expand the remaining Zig native tests.
6. Update docs.
7. Run local verification only.

## Local Verification Plan

Because this work changes Zig/native code, local verification should include both build and test passes.

Recommended commands:

- from the repo root: `bun run build`
- from `packages/core`: `bun test src/tests/file-lock.test.ts`
- from `packages/core`: `bun run test:native`

To reduce flake risk before handing off for the later CI run:

- repeat the behavioural contention tests multiple times locally
- repeat the native file-lock tests multiple times locally if any timing-sensitive coverage is added later

This plan intentionally does not include CI workflow changes or CI execution. Final cross-platform verification across Linux, macOS, and Windows will happen later after the implementation is complete.

## Done Criteria

This follow-up is complete when all of the following are true:

- there is no blocking acquire API or native blocking acquire path
- the public API creates parent directories and lock files by default
- callers can opt out of either behaviour explicitly
- `tryAcquireWithTimeout()` handles waiting without blocking the main thread
- status handling is exhaustive, including `unexpected`
- public errors expose stable machine-readable codes
- tests cover lifecycle and contention behaviour beyond the current timeout/abort coverage
- the behavioural tests remain black-box and do not assert internals
- the docs describe the real public contract clearly
