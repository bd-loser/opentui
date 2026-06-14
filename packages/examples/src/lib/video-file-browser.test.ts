import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { isSupportedVideoFileName, listVideoDirectory, resolveVideoDirectoryPath } from "./video-file-browser.js"

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe("video file browser", () => {
  test("accepts only the enabled MOV/MP4 container extensions", () => {
    expect(isSupportedVideoFileName("clip.mp4")).toBe(true)
    expect(isSupportedVideoFileName("CLIP.MOV")).toBe(true)
    expect(isSupportedVideoFileName("clip.m4v")).toBe(false)
    expect(isSupportedVideoFileName("clip.webm")).toBe(false)
  })

  test("resolves entered paths from the current browser directory", () => {
    expect(resolveVideoDirectoryPath("/media/videos", " ../archive ")).toBe(resolve("/media/archive"))
    expect(resolveVideoDirectoryPath("/media/videos", "/tmp/clips")).toBe(resolve("/tmp/clips"))
  })

  test("lists visible directories and supported files with directories first", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "opentui-video-browser-"))
    await Promise.all([
      mkdir(join(temporaryDirectory, "z-directory")),
      mkdir(join(temporaryDirectory, "a-directory")),
      mkdir(join(temporaryDirectory, ".hidden-directory")),
      writeFile(join(temporaryDirectory, "b-video.mp4"), ""),
      writeFile(join(temporaryDirectory, "a-video.MOV"), ""),
      writeFile(join(temporaryDirectory, "ignored.webm"), ""),
      writeFile(join(temporaryDirectory, ".hidden.mp4"), ""),
    ])

    const entries = await listVideoDirectory(temporaryDirectory)

    expect(entries.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "directory:a-directory",
      "directory:z-directory",
      "file:a-video.MOV",
      "file:b-video.mp4",
    ])
  })

  test("rejects unreadable directories", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "opentui-video-browser-"))
    await expect(listVideoDirectory(join(temporaryDirectory, "missing"))).rejects.toThrow()
  })
})
