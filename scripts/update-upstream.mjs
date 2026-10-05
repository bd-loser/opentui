#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"

const [tag, commit] = process.argv.slice(2)
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`Expected stable tag, got ${tag}`)
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Expected full commit SHA, got ${commit}`)

const path = new URL("../androidtui.json", import.meta.url)
const config = JSON.parse(readFileSync(path, "utf8"))
config.upstream.tag = tag
config.upstream.commit = commit

// Publish exactly the upstream version — no -android.N test slots. The
// watcher only fires on a new upstream tag, so `base` is always fresh; the
// workflow's "npm version is unused" check still guards against dispatching
// a build for a version that's already published.
const base = tag.slice(1)
if (config.releaseVersion !== base) {
  const previous = config.releaseVersion
  config.releaseVersion = base
  console.log(`Note: staging ${previous} -> ${base}.`)
}

writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Pinned OpenTUI ${tag} at ${commit}`)
