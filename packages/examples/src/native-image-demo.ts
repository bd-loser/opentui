#!/usr/bin/env bun

import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { basename, dirname, extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  BoxRenderable,
  CliRenderer,
  ImageRenderable,
  InputRenderable,
  InputRenderableEvents,
  NativeVideo,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
  VideoRenderable,
  createCliRenderer,
  type ImageSource,
  type ImageRenderProtocol,
  type KeyEvent,
  type SelectOption,
  type VideoMetadata,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { listVideoDirectory, resolveVideoDirectoryPath, type VideoFileEntry } from "./lib/video-file-browser.js"

// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import gifPath from "./assets/image-demo.gif" with { type: "image/gif" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import pngPath from "./assets/image-demo.png" with { type: "image/png" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import jpegPath from "./assets/dragon.jpg" with { type: "image/jpeg" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import webpPath from "./assets/image-demo.webp" with { type: "image/webp" }
// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import videoPath from "./assets/dragon.mp4" with { type: "video/mp4" }

const P = {
  page: "#090d18",
  header: "#10172a",
  footer: "#0d1323",
  text: "#f4f7ff",
  muted: "#8d98b5",
  cyan: "#55d6d0",
  violet: "#a78bfa",
  coral: "#fb7185",
  lime: "#a3e635",
  cards: ["#111c2d", "#17192e", "#211827", "#14231f"],
} as const

type FitMode = "fit" | "cover"

interface GalleryItem {
  name: string
  sourceType: string
  source: ImageSource
  accent: string
  card: string
}

interface VideoFileOption extends SelectOption {
  value: VideoFileEntry | { type: "parent" | "empty"; path: string; name: string }
}

let root: BoxRenderable | null = null
let server: Server | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let capabilityListener: (() => void) | null = null
let controlsText: TextRenderable | null = null
let previews: ImageRenderable[] = []
let galleryView: BoxRenderable | null = null
let videoView: BoxRenderable | null = null
let videoPlayerView: BoxRenderable | null = null
let videoHost: BoxRenderable | null = null
let video: VideoRenderable | null = null
let videoStatus: TextRenderable | null = null
let videoFileView: BoxRenderable | null = null
let videoFilePath: TextRenderable | null = null
let videoFilePathInput: InputRenderable | null = null
let videoFileMessage: TextRenderable | null = null
let videoFileSelect: SelectRenderable | null = null
let videoMetadata: VideoMetadata | null = null
let selectedVideoPath = videoPath
let videoFileDirectory = resolve(process.cwd())
let videoFileVisible = false
let videoFilePathVisible = false
let videoFileRequestId = 0
let resumeAfterVideoFile = false
let showingVideo = false
let fitMode: FitMode = "fit"
let protocol: ImageRenderProtocol = "auto"

const protocols: ImageRenderProtocol[] = ["auto", "kitty", "sixel", "blocks"]

function updateControls(): void {
  if (!controlsText) return
  const effective = previews[0]?.effectiveProtocol ?? "blocks"
  controlsText.content = videoFileVisible
    ? videoFilePathVisible
      ? "ENTER  GO TO DIRECTORY     ESC  BACK"
      : "↑/↓  CHOOSE     ENTER  OPEN     G  GO TO DIRECTORY     BACKSPACE  PARENT     ESC  CANCEL"
    : showingVideo
      ? `V  GALLERY     O  OPEN FILE     SPACE  ${video?.playing ? "PAUSE" : "PLAY"}     ←/→  0.25S     F  ${fitMode.toUpperCase()}     P  ${protocol.toUpperCase()} → ${effective.toUpperCase()}`
      : `V  VIDEO     F  ${fitMode.toUpperCase()}     P  ${protocol.toUpperCase()} → ${effective.toUpperCase()}     ESC  MENU`
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`
}

function updateVideoStatus(): void {
  if (!videoStatus || !videoMetadata || !video) return
  const quality = video.qualityTier
  videoStatus.fg = P.cyan
  videoStatus.content = `${basename(selectedVideoPath)}  |  ${video.effectiveProtocol.toUpperCase()}  |  QUALITY ${quality.index + 1}/${quality.total} ${quality.label}${quality.lossless ? " LOSSLESS" : ""}  |  ${videoMetadata.width}×${videoMetadata.height}  ${videoMetadata.fps.toFixed(0)} SOURCE → ${video.presentationFps.toFixed(1)} DISPLAY FPS  ${formatTime(video.currentTime)} / ${formatTime(video.duration)}  ${video.playing ? "PLAYING" : "PAUSED"}`
}

function createVideo(renderer: CliRenderer, source: string, autoplay: boolean): VideoRenderable {
  let nextVideo: VideoRenderable
  nextVideo = new VideoRenderable(renderer, {
    id: "native-video-preview",
    source,
    fit: fitMode,
    protocol,
    autoplay,
    loop: true,
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    onReady: (metadata) => {
      if (video !== nextVideo) return
      videoMetadata = metadata
      updateVideoStatus()
    },
    onPlay: () => {
      if (video !== nextVideo) return
      updateVideoStatus()
      updateControls()
    },
    onPause: () => {
      if (video !== nextVideo) return
      updateVideoStatus()
      updateControls()
    },
    onSeek: () => {
      if (video === nextVideo) updateVideoStatus()
    },
    onTimeUpdate: () => {
      if (video === nextVideo) updateVideoStatus()
    },
    onError: (error) => {
      if (video !== nextVideo || !videoStatus) return
      videoStatus.content = `VIDEO FAILED  ${error.message}`
      videoStatus.fg = P.coral
    },
  })
  return nextVideo
}

function updateVideoFileHeader(message = ""): void {
  if (videoFilePath) videoFilePath.content = videoFileDirectory
  if (videoFileMessage) {
    videoFileMessage.content = message
    videoFileMessage.fg = message.startsWith("Cannot") ? P.coral : P.muted
    videoFileMessage.visible = message.length > 0
  }
}

function videoFileOption(entry: VideoFileEntry): VideoFileOption {
  return {
    name: entry.type === "directory" ? `${entry.name}/` : entry.name,
    description: "",
    color: entry.type === "directory" ? P.violet : P.text,
    selectedColor: entry.type === "directory" ? "#d8c9ff" : P.cyan,
    attributes: entry.type === "directory" ? TextAttributes.BOLD : TextAttributes.NONE,
    detail: entry.type === "file" ? extname(entry.name).slice(1).toUpperCase() : undefined,
    detailColor: P.muted,
    selectedDetailColor: P.violet,
    value: entry,
  }
}

function setVideoFileOptions(directory: string, entries: VideoFileEntry[]): void {
  videoFileDirectory = directory
  const parent = dirname(directory)
  const options: VideoFileOption[] =
    parent === directory
      ? []
      : [
          {
            name: "../",
            description: "",
            color: P.violet,
            selectedColor: "#d8c9ff",
            attributes: TextAttributes.BOLD,
            detail: "UP",
            detailColor: P.muted,
            value: { type: "parent", path: parent, name: ".." },
          },
        ]
  options.push(...entries.map(videoFileOption))
  if (options.length === 0) {
    options.push({
      name: "No videos here",
      description: "",
      color: P.muted,
      value: { type: "empty", path: directory, name: "" },
    })
  }

  if (videoFileSelect) {
    videoFileSelect.options = options
    videoFileSelect.setSelectedIndex(0)
  }
  updateVideoFileHeader()
}

async function refreshVideoFiles(directory: string = videoFileDirectory): Promise<void> {
  const requestId = ++videoFileRequestId
  const nextDirectory = resolve(directory)
  updateVideoFileHeader("Loading...")

  try {
    const entries = await listVideoDirectory(nextDirectory)
    if (requestId !== videoFileRequestId || !videoFileVisible) return
    setVideoFileOptions(nextDirectory, entries)
  } catch (error) {
    if (requestId !== videoFileRequestId || !videoFileVisible) return
    const message = error instanceof Error ? error.message : String(error)
    updateVideoFileHeader(`Cannot read directory: ${message}`)
  }
}

function showVideoFilePathInput(): void {
  if (!videoFilePath || !videoFilePathInput || !videoFileSelect) return
  videoFilePathVisible = true
  videoFilePath.visible = false
  videoFilePathInput.visible = true
  videoFileSelect.blur()
  videoFilePathInput.value = videoFileDirectory
  videoFilePathInput.focus()
  videoFilePathInput.selectAll()
  updateVideoFileHeader()
  updateControls()
}

function hideVideoFilePathInput(): void {
  if (!videoFilePath || !videoFilePathInput || !videoFileSelect) return
  videoFileRequestId++
  videoFilePathVisible = false
  videoFilePathInput.blur()
  videoFilePathInput.visible = false
  videoFilePath.visible = true
  videoFileSelect.focus()
  updateVideoFileHeader()
  updateControls()
}

async function jumpToVideoDirectory(value: string): Promise<void> {
  const input = value.trim()
  if (!input || !videoFileVisible || !videoFilePathVisible) return
  const requestId = ++videoFileRequestId
  const nextDirectory = resolveVideoDirectoryPath(videoFileDirectory, input)

  try {
    const entries = await listVideoDirectory(nextDirectory)
    if (requestId !== videoFileRequestId || !videoFileVisible || !videoFilePathVisible) return
    setVideoFileOptions(nextDirectory, entries)
    hideVideoFilePathInput()
  } catch {
    // Keep the current directory and path input unchanged.
  }
}

function showVideoFiles(): void {
  if (!videoPlayerView || !videoFileView || !videoFileSelect) return
  resumeAfterVideoFile = video?.playing ?? false
  video?.pause()
  videoFileVisible = true
  videoFilePathVisible = false
  videoPlayerView.visible = false
  videoFileView.visible = true
  videoFileSelect.focus()
  updateControls()
  void refreshVideoFiles()
}

function hideVideoFiles(resumePlayback = true): void {
  if (!videoPlayerView || !videoFileView || !videoFileSelect) return
  videoFileRequestId++
  videoFileVisible = false
  videoFilePathVisible = false
  videoFilePathInput?.blur()
  if (videoFilePathInput) videoFilePathInput.visible = false
  if (videoFilePath) videoFilePath.visible = true
  videoFileSelect.blur()
  videoFileView.visible = false
  videoPlayerView.visible = true
  if (resumePlayback && resumeAfterVideoFile) video?.play()
  resumeAfterVideoFile = false
  updateControls()
}

function loadVideoFile(renderer: CliRenderer, filePath: string): void {
  updateVideoFileHeader(`Checking ${basename(filePath)}...`)
  videoFileSelect?.blur()

  try {
    const validation = NativeVideo.open(filePath)
    validation.dispose()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateVideoFileHeader(`Cannot open ${basename(filePath)}: ${message}`)
    videoFileSelect?.focus()
    return
  }

  const shouldPlay = resumeAfterVideoFile
  const previousVideo = video
  const nextVideo = createVideo(renderer, filePath, shouldPlay)
  previousVideo?.destroy()
  video = nextVideo
  videoMetadata = null
  selectedVideoPath = filePath
  videoHost?.add(nextVideo)
  hideVideoFiles(false)
  if (videoStatus) {
    videoStatus.fg = P.cyan
    videoStatus.content = `${basename(filePath)}  |  LOADING NATIVE H264...`
  }
}

async function handleVideoFileOption(renderer: CliRenderer, option: SelectOption): Promise<void> {
  const entry = (option as VideoFileOption).value
  if (entry.type === "empty") return
  if (entry.type === "parent" || entry.type === "directory") {
    await refreshVideoFiles(entry.path)
    return
  }
  loadVideoFile(renderer, entry.path)
}

function createCard(renderer: CliRenderer, item: GalleryItem, index: number): BoxRenderable {
  const card = new BoxRenderable(renderer, {
    id: `native-image-card-${index}`,
    width: "auto",
    height: "100%",
    minWidth: 18,
    flexBasis: 24,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: item.card,
  })

  card.add(
    new BoxRenderable(renderer, {
      id: `native-image-accent-${index}`,
      width: "100%",
      height: 1,
      flexGrow: 0,
      flexShrink: 0,
      backgroundColor: item.accent,
    }),
  )

  const heading = new BoxRenderable(renderer, {
    id: `native-image-heading-${index}`,
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "column",
    paddingLeft: 2,
    paddingTop: 1,
    backgroundColor: item.card,
  })
  heading.add(
    new TextRenderable(renderer, {
      id: `native-image-title-${index}`,
      content: item.name,
      fg: P.text,
      attributes: TextAttributes.BOLD,
    }),
  )
  heading.add(
    new TextRenderable(renderer, {
      id: `native-image-source-${index}`,
      content: item.sourceType,
      fg: item.accent,
    }),
  )
  card.add(heading)

  const metadata = new TextRenderable(renderer, {
    id: `native-image-metadata-${index}`,
    content: "LOADING\nNative decoder",
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    paddingLeft: 2,
    paddingTop: 1,
    fg: P.muted,
    bg: item.card,
  })

  const preview = new ImageRenderable(renderer, {
    id: `native-image-preview-${index}`,
    source: item.source,
    fit: fitMode,
    protocol,
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 5,
    onLoad: (image) => {
      const info = image.info()
      metadata.content = `${info.format.toUpperCase()}  ${info.width}×${info.height}\nRGBA8  ${info.hasAlpha ? "ALPHA" : "OPAQUE"}`
    },
    onError: (error) => {
      metadata.content = `LOAD FAILED\n${error instanceof Error ? error.message : String(error)}`
      metadata.fg = P.coral
    },
  })
  previews.push(preview)
  card.add(preview)
  card.add(metadata)
  return card
}

async function startImageServer(gif: Uint8Array): Promise<string> {
  server = createServer((request, response) => {
    if (request.url !== "/image") {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(gif)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject)
    server!.listen(0, "127.0.0.1", () => {
      server!.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Image demo server did not expose a TCP port")
  return `http://127.0.0.1:${address.port}/image`
}

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  renderer.setBackgroundColor(P.page)

  const [webpBytes, gifBytes] = await Promise.all([readFile(webpPath), readFile(gifPath)])
  const gifUrl = await startImageServer(gifBytes)

  root = new BoxRenderable(renderer, {
    id: "native-image-demo",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: P.page,
  })
  renderer.root.add(root)

  const header = new BoxRenderable(renderer, {
    id: "native-image-header",
    width: "100%",
    height: 4,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 3,
    paddingRight: 3,
    backgroundColor: P.header,
  })
  header.add(
    new TextRenderable(renderer, {
      id: "native-image-heading",
      content: "NATIVE IMAGE LAB",
      fg: P.text,
      attributes: TextAttributes.BOLD,
    }),
  )
  root.add(header)

  const gallery = new BoxRenderable(renderer, {
    id: "native-image-gallery",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: P.page,
  })
  galleryView = gallery
  root.add(gallery)

  const items: GalleryItem[] = [
    { name: "LOCAL PNG", sourceType: "filesystem path", source: pngPath, accent: P.cyan, card: P.cards[0] },
    {
      name: "JPEG URL",
      sourceType: "file: URL",
      source: pathToFileURL(jpegPath),
      accent: P.violet,
      card: P.cards[1],
    },
    { name: "WEBP BYTES", sourceType: "Uint8Array", source: webpBytes, accent: P.coral, card: P.cards[2] },
    { name: "GIF FETCH", sourceType: "HTTP response", source: gifUrl, accent: P.lime, card: P.cards[3] },
  ]
  for (const [index, item] of items.entries()) gallery.add(createCard(renderer, item, index))

  videoView = new BoxRenderable(renderer, {
    id: "native-video-view",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: P.page,
    visible: false,
  })
  videoPlayerView = new BoxRenderable(renderer, {
    id: "native-video-player-view",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: P.page,
  })
  videoHost = new BoxRenderable(renderer, {
    id: "native-video-host",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: P.page,
  })
  videoStatus = new TextRenderable(renderer, {
    id: "native-video-status",
    content: "NATIVE H264  READY ON V",
    width: "100%",
    height: 2,
    flexGrow: 0,
    flexShrink: 0,
    fg: P.cyan,
    bg: P.footer,
  })
  video = createVideo(renderer, videoPath, false)
  videoHost.add(video)
  videoPlayerView.add(videoHost)
  videoPlayerView.add(videoStatus)
  videoView.add(videoPlayerView)

  videoFileView = new BoxRenderable(renderer, {
    id: "native-video-file-view",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 2,
    backgroundColor: P.page,
    visible: false,
  })
  const videoFilePanel = new BoxRenderable(renderer, {
    id: "native-video-file-panel",
    width: "100%",
    maxWidth: 96,
    height: "100%",
    maxHeight: 34,
    minHeight: 12,
    flexDirection: "column",
    backgroundColor: P.header,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  })
  const videoFileHeader = new BoxRenderable(renderer, {
    id: "native-video-file-header",
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: P.header,
  })
  videoFileHeader.add(
    new TextRenderable(renderer, {
      id: "native-video-file-heading",
      content: "CHOOSE A VIDEO",
      fg: P.text,
      bg: P.header,
      attributes: TextAttributes.BOLD,
    }),
  )
  videoFilePath = new TextRenderable(renderer, {
    id: "native-video-file-path",
    content: videoFileDirectory,
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
    fg: P.cyan,
    bg: P.header,
  })
  videoFilePathInput = new InputRenderable(renderer, {
    id: "native-video-file-path-input",
    width: "100%",
    value: "",
    placeholder: "Enter an absolute or relative directory path",
    textColor: P.text,
    backgroundColor: "#1a2137",
    cursorColor: P.cyan,
    placeholderColor: P.muted,
    selectionBg: "#39456d",
    selectionFg: P.text,
    visible: false,
  })
  videoFilePathInput.on(InputRenderableEvents.ENTER, (value: string) => {
    void jumpToVideoDirectory(value)
  })
  videoFileMessage = new TextRenderable(renderer, {
    id: "native-video-file-message",
    content: "",
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
    fg: P.muted,
    bg: P.header,
    visible: false,
  })
  videoFileSelect = new SelectRenderable(renderer, {
    id: "native-video-file-select",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    options: [],
    backgroundColor: P.header,
    focusedBackgroundColor: P.header,
    textColor: P.text,
    focusedTextColor: P.text,
    selectedBackgroundColor: "#312e52",
    selectedTextColor: P.cyan,
    descriptionColor: P.muted,
    selectedDescriptionColor: P.violet,
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    fastScrollStep: 8,
  })
  videoFileSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    void handleVideoFileOption(renderer, option)
  })
  const videoFileSupport = new TextRenderable(renderer, {
    id: "native-video-file-support",
    content: "Shows MP4 and MOV files. Video must use H.264; AAC audio is optional.",
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
    fg: P.muted,
    bg: P.header,
  })
  videoFilePanel.add(videoFileHeader)
  videoFilePanel.add(videoFilePath)
  videoFilePanel.add(videoFilePathInput)
  videoFilePanel.add(videoFileMessage)
  videoFilePanel.add(videoFileSelect)
  videoFilePanel.add(videoFileSupport)
  videoFileView.add(videoFilePanel)
  videoView.add(videoFileView)
  root.add(videoView)

  const footer = new BoxRenderable(renderer, {
    id: "native-image-footer",
    width: "100%",
    height: 3,
    flexGrow: 0,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: P.footer,
  })
  controlsText = new TextRenderable(renderer, {
    id: "native-image-controls",
    content: "",
    fg: P.muted,
    attributes: TextAttributes.BOLD,
  })
  footer.add(controlsText)
  root.add(footer)
  updateControls()

  keyListener = (key: KeyEvent) => {
    if (videoFileVisible) {
      if (videoFilePathVisible) {
        if (key.name === "escape") {
          key.preventDefault()
          key.stopPropagation()
          hideVideoFilePathInput()
        }
        return
      }

      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        hideVideoFiles()
      } else if (key.name === "g" && !key.ctrl && !key.meta) {
        key.preventDefault()
        key.stopPropagation()
        showVideoFilePathInput()
      } else if (key.name === "backspace") void refreshVideoFiles(dirname(videoFileDirectory))
      else if (key.name === "r") void refreshVideoFiles()
      return
    }

    if (key.name === "v" && !key.ctrl && !key.meta) {
      showingVideo = !showingVideo
      if (galleryView) galleryView.visible = !showingVideo
      if (videoView) videoView.visible = showingVideo
      if (showingVideo) video?.play()
      else video?.pause()
    } else if (showingVideo && key.name === "o") {
      showVideoFiles()
    } else if (showingVideo && key.name === "space") {
      video?.toggle()
    } else if (showingVideo && key.name === "left") {
      video?.seekBy(key.shift ? -5 : -0.25)
    } else if (showingVideo && key.name === "right") {
      video?.seekBy(key.shift ? 5 : 0.25)
    } else if (key.name === "f") fitMode = fitMode === "fit" ? "cover" : "fit"
    else if (key.name === "p") protocol = protocols[(protocols.indexOf(protocol) + 1) % protocols.length]
    else return

    for (const preview of previews) {
      preview.fit = fitMode
      preview.protocol = protocol
    }
    if (video) {
      video.fit = fitMode
      video.protocol = protocol
    }
    updateControls()
  }
  renderer.keyInput.prependListener("keypress", keyListener)
  capabilityListener = updateControls
  renderer.on("capabilities", capabilityListener)
}

export function destroy(renderer: CliRenderer): void {
  if (keyListener) renderer.keyInput.off("keypress", keyListener)
  if (capabilityListener) renderer.off("capabilities", capabilityListener)
  keyListener = null
  capabilityListener = null
  root?.destroyRecursively()
  root = null
  previews = []
  galleryView = null
  videoView = null
  videoPlayerView = null
  videoHost = null
  video = null
  videoStatus = null
  videoFileView = null
  videoFilePath = null
  videoFilePathInput = null
  videoFileMessage = null
  videoFileSelect = null
  videoMetadata = null
  selectedVideoPath = videoPath
  videoFileDirectory = resolve(process.cwd())
  videoFileVisible = false
  videoFilePathVisible = false
  videoFileRequestId++
  resumeAfterVideoFile = false
  showingVideo = false
  controlsText = null
  fitMode = "fit"
  protocol = "auto"
  server?.close()
  server = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
