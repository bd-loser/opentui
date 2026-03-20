import { writeFileSync } from "node:fs"

import { FileLock } from "../FileLock"

const [mode, lockPath, readyPath, value] = process.argv.slice(2)

if (!mode || !lockPath) {
  throw new Error("Expected mode and lock path")
}

switch (mode) {
  case "hold": {
    const ms = Number(value ?? "0")
    const lock = FileLock.acquire(lockPath)

    try {
      if (readyPath) writeFileSync(readyPath, "ready")
      await Bun.sleep(ms)
    } finally {
      lock.close()
    }
    break
  }
  case "hang": {
    const lock = FileLock.acquire(lockPath)

    try {
      if (readyPath) writeFileSync(readyPath, "ready")
      await Bun.sleep(60_000)
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
  case "wait": {
    const start = Date.now()
    const lock = FileLock.acquire(lockPath)

    try {
      console.log(JSON.stringify({ acquired: true, waited: Date.now() - start }))
    } finally {
      lock.close()
    }
    break
  }
  default:
    throw new Error(`Unknown mode: ${mode}`)
}
