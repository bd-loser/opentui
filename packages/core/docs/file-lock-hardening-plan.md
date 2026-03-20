# FileLock Hardening Plan

## Scope

This plan is based on the review of the `system-locks` branch relative to `main`.

Goals for the follow-up work:

- make the API friendly by default
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

- `packages/core/src/FileLock.ts`: public TypeScript API, path normalization/preparation, error wrapping, lifecycle methods
- `packages/core/src/zig.ts`: FFI symbol declarations and the TypeScript wrapper around the native library
- `packages/core/src/zig-structs.ts`: FFI struct packing/unpacking helpers
- `packages/core/src/zig/file-lock.zig`: native file lock implementation and registry/handle management
- `packages/core/src/zig/lib.zig`: exported native functions and the process-global registry instance
- `packages/core/src/tests/file-lock.test.ts`: subprocess-based TypeScript behavioural tests
- `packages/core/src/tests/file-lock.fixture.ts`: helper process used by the behavioural tests
- `packages/core/src/zig/tests/file-lock_test.zig`: native unit tests

Current behaviour summary:

- `FileLock.open(path, options?)`, `FileLock.acquire(path, options?)`, and `FileLock.tryAcquire(path, options?)` normalize the path, create missing parent directories and lock files by default, and support strict opt-out via `createParentPath: false` and `createIfMissing: false`
- the native `open()` path still implicitly creates the file if it does not exist, so the remaining native follow-up should make that path strict existing-file-only
- blocking `acquire()` ultimately calls `std.fs.File.lock(.exclusive)`
- `tryAcquire()` uses `std.fs.File.tryLock(.exclusive)`
- TypeScript status decoding in `packages/core/src/zig.ts` is not exhaustive; status `9` (`unexpected`) is missing an explicit branch
- TypeScript tests cover friendly defaults, strict opt-outs, and a few contention/lifecycle cases, but not timeout or stress behaviour yet

## Key Insights That Drive This Plan

1. The path-preparation ergonomics stay in `packages/core/src/FileLock.ts`, not in the FFI surface.

   `FileLock.ts` is the public API and the only current caller of `createFileLock()`. That split is now in place, and the remaining work should preserve it so the native create ABI can stay small and strict.

2. Timeout support must be implemented in the native layer.

   A JavaScript timeout wrapped around the current blocking native `acquire()` call is not sufficient, because once the thread enters `file.lock(.exclusive)`, JavaScript cannot interrupt it. The timeout has to live in the native lock acquisition path.

3. The reliability issue in `destroy()` is really an acquire-path issue.

   The current registry can wait forever because `Registry.acquire()` enters a blocking OS lock call. To fix that, the registry-level acquire path must switch to a retry loop around `tryLock(.exclusive)` so it can observe both timeout and `closing` state between attempts.

4. Behavioural locking semantics should be tested at the process level, not by inspecting implementation details.

   The TypeScript test layer is the right place to verify real cross-process locking because it can spawn independent processes that contend on the same path. Zig tests should focus on native statuses and lifecycle guarantees exposed by the native API, not mutex internals or ref counts.

5. The remaining follow-up should treat the public create-path ergonomics as settled API surface.

   The public layer now creates missing parent directories and the lock file by default and allows strict opt-out for existing-path-only callers. The remaining work is to document that contract and make the native create path strict underneath it.

## Desired End State

The remaining public API work should end up with these semantics:

```ts
type FileLockAcquireOptions = FileLockOpenOptions & {
  timeoutMs?: number
}
```

Remaining public surface work:

- `FileLock.acquire(path, options?)` should accept `timeoutMs` once the native timeout path exists
- `lock.acquire(options?: { timeoutMs?: number })`
- `lock.tryAcquire()` remains immediate and non-blocking

Timeout behaviour:

- `acquire()` without `timeoutMs` waits until success or a non-busy error
- `acquire({ timeoutMs })` waits up to the requested bound and then fails with a distinct timeout error code
- `tryAcquire()` remains immediate and returns `false` on contention

Error surface:

- every native status is handled explicitly
- public errors expose a stable `code` in addition to message, `path`, `op`, and `cause`
- cleanup failures do not erase the original error

Lifecycle behaviour:

- `close()` stays idempotent
- same-instance repeated `acquire()` / `tryAcquire()` behaviour should be explicitly documented and tested
- `release()` behaviour should be explicitly documented and tested instead of remaining an implicit side effect

## Detailed Implementation Plan

### 1. Remaining public API work in `packages/core/src/FileLock.ts`

The create-path ergonomics now live in `FileLock.ts` and should stay there. The remaining work in this file is:

- extend `FileLockAcquireOptions` with `timeoutMs`
- keep `timeoutMs` only on acquire paths; it does not apply to `tryAcquire()`

Update public constructors/helpers:

- `FileLock.acquire(path, options?)` should use the timeout-aware native path when `timeoutMs` is provided
- instance `acquire(options?)` only accepts the timeout subset, because create-path options matter only before the handle exists

Lifecycle contract cleanup:

- keep `close()` idempotent
- document and test the chosen behaviour of repeated `acquire()` / `tryAcquire()` on the same instance
- document and test the chosen behaviour of `release()` so it is an explicit API contract instead of an undocumented side effect

Error model improvements in `FileLock.ts`:

- extend `FileLockError` with a stable `code` field
- keep `path`, `op`, and `cause`
- map pre-create filesystem failures to the same public code namespace used for native errors where possible, for example:
  - `invalid_path`
  - `access_denied`
  - `file_not_found`
  - `system_resources`
  - `unexpected`
- use a small TS-only code such as `closed` only when the failure comes from API misuse before any native call happens

Cleanup error handling:

- update the static `cleanup()` helper so a `close()` failure augments the original failure instead of replacing it
- the main requirement is that the original cause of failure remains visible to callers and tests

### 2. Native lock acquisition in `packages/core/src/zig/file-lock.zig`

Make native create strict and explicit:

- remove the current implicit `createFileAbsolute()` fallback from `open()`
- after this change, native `open()` should only open an existing absolute file
- the public TypeScript layer will be responsible for the friendly default behaviour

Add a timeout-aware status:

- extend `Status` with `timed_out`
- keep all existing statuses intact and continue to return machine-stable integer codes through the FFI

Rework the registry acquire path so it does not block forever inside the OS lock call:

- stop using blocking `entry.lock.acquire()` inside `Registry.acquire()`
- instead, loop on `entry.lock.tryAcquire()` while holding `entry.op`
- after each busy result:
  - check whether the entry is now closing
  - check whether the timeout deadline has expired
  - sleep for a short interval before retrying

Recommended native shape:

- keep `FileLock.tryAcquire()` immediate
- add `Registry.acquireWithTimeout(id: u64, timeout_ns: ?u64) Status`
- implement `Registry.acquire(id)` as `acquireWithTimeout(id, null)`
- keep `Registry.tryAcquire(id)` immediate

Why the loop belongs at the registry layer:

- only the registry can observe `entry.closing`
- this lets the waiter return `closing` promptly when `destroy()` starts
- this removes the current indefinite-wait risk created by entering a blocking OS lock call with no cancellation points

Retry strategy guidance:

- use a small fixed sleep interval that keeps CPU usage low but does not make tests flaky
- the exact value can be tuned during implementation, but it should be short enough that timeout-based tests do not become brittle

Other native details:

- keep `statusFromError()` exhaustive
- `busy` remains the status used by immediate try-acquire contention
- `timed_out` is only for bounded acquire waiting
- `closing` remains the status used when a handle is being torn down while an acquire is waiting

### 3. FFI updates in `packages/core/src/zig/lib.zig` and `packages/core/src/zig.ts`

Keep native create ABI small:

- keep `createFileLock(pathPtr, pathLen, outPtr)` as-is
- no create-options struct is needed if path preparation stays in `FileLock.ts`

Add a timeout-capable acquire export in `packages/core/src/zig/lib.zig`:

- add `fileLockAcquireWithTimeout(lockId: u64, timeoutMs: u64) i32`
- convert ms to the native duration unit inside Zig and delegate to `Registry.acquireWithTimeout`

Update the FFI declaration table in `packages/core/src/zig.ts`:

- add the new `fileLockAcquireWithTimeout` symbol
- leave the existing `fileLockAcquire`, `fileLockTryAcquire`, and `fileLockRelease` symbols intact

Make status handling exhaustive in `packages/core/src/zig.ts`:

- replace the current ad-hoc `switch` in `fileLockStatus()` with a single status table or exhaustive constant map
- explicitly include every status, including the currently missing `unexpected` and the new `timed_out`
- keep a single source of truth for these status names to avoid future drift

Wrapper behaviour in `zig.ts`:

- `createFileLock()` keeps its current ABI and error flow
- `fileLockAcquireWithTimeout()` throws a typed error for all non-`ok` statuses, including `timed_out`
- `fileLockTryAcquire()` keeps returning `false` only for `busy` and throws for all other statuses

Input validation in `zig.ts` / `FileLock.ts`:

- validate `timeoutMs` before crossing the FFI boundary
- require a finite, non-negative number
- clamp or reject values that cannot be represented safely as the native integer input

`packages/core/src/zig-structs.ts` impact:

- no changes are required unless the implementation later decides to pack richer error/result structs
- the current `FileLockCreateResultStruct` can remain as-is

### 4. Behavioural tests in `packages/core/src/tests/file-lock.test.ts`

Keep the TypeScript suite black-box and process-based.

The friendly-default and strict-opt-out cases are now covered. The remaining additions are:

Add timeout coverage:

- `acquire({ timeoutMs })` times out while another process holds the lock longer than the deadline
- `acquire({ timeoutMs })` succeeds when the other process releases before the deadline
- timeout failures expose a stable public error code, not only a message string

Add lifecycle coverage:

- release then re-acquire on the same instance
- explicit contract test for repeated `acquire()` / `tryAcquire()` on the same instance
- explicit contract test for `release()`
- `close()` remains idempotent
- closed locks fail on reuse with a stable public error code
- `Symbol.dispose` releases/cleans up correctly

Keep the contention tests behavioural:

- continue using subprocesses and real filesystem paths
- do not mock the native layer
- do not assert handle ids, internal registry state, or retry counts

Add basic stress coverage:

- run a repeated contention loop with multiple subprocesses contending for the same lock path
- the test should assert observable outcomes only: one holder at a time, eventual success, no permanent hangs

### 5. Fixture updates in `packages/core/src/tests/file-lock.fixture.ts`

Expand the fixture only as needed for behavioural testing.

Recommended changes:

- replace `Bun.sleep` with a standard timer-based sleep helper such as `node:timers/promises`
- keep the fixture protocol simple: JSON on stdout, nonzero exit on failure
- add fixture modes only when they serve a real behavioural test, for example:
  - hold a lock for a known duration
  - wait on a lock with a timeout
  - try-acquire and report whether it succeeded

Keep synchronization stable:

- continue using ready-marker files or another explicit readiness signal instead of relying on arbitrary race-prone sleeps

### 6. Native tests in `packages/core/src/zig/tests/file-lock_test.zig`

Add native coverage for the new semantics without asserting internals.

Recommended cases:

- existing-file open/acquire/release/re-acquire still works
- strict create behaviour: native create fails with `file_not_found` when the public layer has not pre-created the file
- timeout returns `timed_out`
- invalid handles still return `invalid_handle`
- destroy still removes the handle
- waiting acquire returns `closing` when destroy begins while that acquire is pending
- repeated create/acquire/release/destroy cycles complete cleanly

The `closing` case is worth covering explicitly because it is the native regression the timeout-loop change is meant to fix.

That test should stay public-API-facing:

- create a registry and a lock handle
- have one thread hold the lock
- have another thread call the blocking registry acquire path
- trigger `destroy()` while the waiter is pending
- assert only the public status result and that the operations complete without hanging

### 7. Documentation updates

Add or update docs in `packages/core/README.md` and/or `packages/core/docs`.

Document:

- what `FileLock` is for
- the default friendly behaviour (`createIfMissing: true`, `createParentPath: true`)
- the strict opt-out flags
- `timeoutMs` semantics
- the lifecycle contract for `acquire`, `tryAcquire`, `release`, `close`, and `Symbol.dispose`
- that dedicated `.lock` files may remain on disk after release, which is expected
- that lock support depends on the underlying filesystem and platform capabilities

The docs should set expectations clearly for local filesystems and make it obvious that the API is advisory OS locking, not a distributed lock service.

## File-By-File Checklist

`packages/core/src/FileLock.ts`

- add timeout-aware acquire path
- add stable `FileLockError.code`
- improve cleanup error preservation
- document/test explicit lifecycle semantics

`packages/core/src/zig/file-lock.zig`

- make native `open()` strict existing-file-only
- add `timed_out` status
- add registry-level acquire loop with timeout and `closing` checks
- keep try-acquire immediate

`packages/core/src/zig/lib.zig`

- export `fileLockAcquireWithTimeout`
- route existing acquire through the new registry logic

`packages/core/src/zig.ts`

- declare new FFI symbol
- centralize and exhaustively handle file-lock statuses
- add timeout-aware wrapper method
- validate timeout inputs
- surface stable error codes

`packages/core/src/zig-structs.ts`

- no change expected unless implementation later chooses richer result structs

`packages/core/src/tests/file-lock.test.ts`

- add timeout tests
- add lifecycle tests
- add stress/flake-resistance tests

`packages/core/src/tests/file-lock.fixture.ts`

- replace Bun-only sleep helper
- add only the fixture modes needed by the tests

`packages/core/src/zig/tests/file-lock_test.zig`

- add timeout and closing coverage
- add strict-create coverage
- add repeated lifecycle coverage

`packages/core/README.md` and/or `packages/core/docs/*`

- document the final public contract

## Recommended Implementation Order

1. Rework native acquire semantics in `packages/core/src/zig/file-lock.zig` so the registry no longer blocks forever inside a lock call.
2. Add the timeout FFI export in `packages/core/src/zig/lib.zig` and wire it through `packages/core/src/zig.ts`.
3. Update `packages/core/src/FileLock.ts` to add timeout usage and stable error codes.
4. Expand the TypeScript behavioural tests and fixture.
5. Expand the Zig native tests.
6. Update docs.
7. Run local verification only.

## Local Verification Plan

Because this work changes Zig/native code, local verification should include both build and test passes.

Recommended commands:

- from the repo root: `bun run build`
- from `packages/core`: `bun test src/tests/file-lock.test.ts`
- from `packages/core`: `bun run test:native`

To reduce flake risk before handing off for the later CI run:

- repeat the contention/timeouts behavioural tests multiple times locally
- repeat the native timeout/closing tests multiple times locally if they are timing-sensitive

This plan intentionally does not include CI workflow changes or CI execution. Final cross-platform verification across Linux, macOS, and Windows will happen later after the implementation is complete.

## Done Criteria

This follow-up is complete when all of the following are true:

- blocking acquire supports a timeout
- pending acquires can stop promptly when destroy/close begins
- status handling is exhaustive, including `unexpected` and `timed_out`
- public errors expose stable machine-readable codes
- tests cover timeouts, lifecycle, and contention behaviour
- the behavioural tests remain black-box and do not assert internals
- the docs describe the real public contract clearly
