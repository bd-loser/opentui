import { writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

import { FileLock } from "../FileLock"

const [mode, lockPath, readyPath, value] = process.argv.slice(2)

if (!mode || !lockPath) {
  throw new Error("Expected mode and lock path")
}

function mustTryAcquire(path: string): FileLock {
  const lock = FileLock.tryAcquire(path)

  if (!lock) {
    throw new Error(`Failed to acquire lock: ${path}`)
  }

  return lock
}

switch (mode) {
  case "hold": {
    const ms = Number(value ?? "0")
    const lock = mustTryAcquire(lockPath)

    try {
      if (readyPath) writeFileSync(readyPath, "ready")
      await sleep(ms)
    } finally {
      lock.close()
    }
    break
  }
  case "hang": {
    const lock = mustTryAcquire(lockPath)

    try {
      if (readyPath) writeFileSync(readyPath, "ready")
      await sleep(60_000)
    } finally {
      lock.close()
    }
    break
  }
  case "try": {
    const lock = FileLock.tryAcquire(lockPath)

    try {
      console.log(JSON.stringify({ acquired: !!lock }))
    } finally {
      lock?.close()
    }
    break
  }
  default:
    throw new Error(`Unknown mode: ${mode}`)
}
