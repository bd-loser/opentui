import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type RenderContext,
  type ScrollbackComponent,
  type ScrollbackSnapshot,
  type ThemeMode,
} from "../index.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const DEFAULT_FOOTER_HEIGHT = 14
const MIN_FOOTER_HEIGHT = 10
const MIN_MAIN_SCREEN_HEIGHT = 6

type ChatRole = "user" | "assistant" | "system"

interface DemoPalette {
  appBackground: string
  footerBorder: string
  footerBackground: string
  headerText: string
  helpText: string
  statusText: string
  typingText: string
  inputFrameBorder: string
  inputFrameBackground: string
  promptText: string
  inputPlaceholder: string
  inputText: string
  inputFocusedText: string
  inputFocusedBackground: string
  inputCursor: string
  chatUserBorder: string
  chatAssistantBorder: string
  chatSystemBorder: string
  chatBodyText: string
  bulletBorder: string
  bulletBodyText: string
  toolBorder: string
  toolBodyText: string
}

const DARK_PALETTE: DemoPalette = {
  appBackground: "#091324",
  footerBorder: "#395172",
  footerBackground: "#10243f",
  headerText: "#f8fafc",
  helpText: "#bfd3ea",
  statusText: "#8fb3d8",
  typingText: "#f5c063",
  inputFrameBorder: "#5d7ea6",
  inputFrameBackground: "#0c1e35",
  promptText: "#7ef0c1",
  inputPlaceholder: "#5f7894",
  inputText: "#e2f1ff",
  inputFocusedText: "#ffffff",
  inputFocusedBackground: "#0f2744",
  inputCursor: "#f8fafc",
  chatUserBorder: "#67c7a2",
  chatAssistantBorder: "#7ba7d8",
  chatSystemBorder: "#d7a46c",
  chatBodyText: "#f1f7ff",
  bulletBorder: "#6293c2",
  bulletBodyText: "#dbeaf8",
  toolBorder: "#8a7cd3",
  toolBodyText: "#eee7ff",
}

const LIGHT_PALETTE: DemoPalette = {
  appBackground: "#ecf3fb",
  footerBorder: "#87a3bf",
  footerBackground: "#f7fbff",
  headerText: "#1f3852",
  helpText: "#395876",
  statusText: "#496988",
  typingText: "#8c5b17",
  inputFrameBorder: "#9ab0c6",
  inputFrameBackground: "#ffffff",
  promptText: "#0a7a4f",
  inputPlaceholder: "#8298ad",
  inputText: "#1d3348",
  inputFocusedText: "#13283b",
  inputFocusedBackground: "#f1f7fe",
  inputCursor: "#1f3852",
  chatUserBorder: "#1e9a66",
  chatAssistantBorder: "#366fa8",
  chatSystemBorder: "#b27d2a",
  chatBodyText: "#1f3852",
  bulletBorder: "#4177a8",
  bulletBodyText: "#294766",
  toolBorder: "#6550b5",
  toolBodyText: "#3f2f7d",
}

function resolveDemoPalette(themeMode: ThemeMode | null): DemoPalette {
  return themeMode === "light" ? LIGHT_PALETTE : DARK_PALETTE
}

interface ChatMessageEntry {
  role: ChatRole
  text: string
  timestamp: Date
  palette: DemoPalette
}

interface BulletListEntry {
  title: string
  items: string[]
  palette: DemoPalette
}

interface ToolCardEntry {
  title: string
  rows: string[]
  palette: DemoPalette
}

interface RenderableSnapshotEntry {
  width: number
  height: number
  build: (context: RenderContext) => BoxRenderable
}

function formatTimestamp(timestamp: Date): string {
  const hh = timestamp.getHours().toString().padStart(2, "0")
  const mm = timestamp.getMinutes().toString().padStart(2, "0")
  const ss = timestamp.getSeconds().toString().padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return ""
  }

  if (text.length <= width) {
    return text
  }

  if (width <= 3) {
    return text.slice(0, width)
  }

  return `${text.slice(0, width - 3)}...`
}

function splitLongToken(token: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const segments: string[] = []

  for (let offset = 0; offset < token.length; offset += clampedWidth) {
    segments.push(token.slice(offset, offset + clampedWidth))
  }

  return segments
}

function wrapText(text: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const normalized = text.replace(/\r/g, "")
  const paragraphs = normalized.split("\n")
  const wrapped: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      wrapped.push("")
      continue
    }

    const words = paragraph.split(/\s+/)
    let current = ""

    for (const word of words) {
      if (word.length === 0) {
        continue
      }

      if (current.length === 0) {
        if (word.length <= clampedWidth) {
          current = word
        } else {
          const segments = splitLongToken(word, clampedWidth)
          current = segments.pop() ?? ""
          wrapped.push(...segments)
        }
        continue
      }

      const candidate = `${current} ${word}`
      if (candidate.length <= clampedWidth) {
        current = candidate
        continue
      }

      wrapped.push(current)

      if (word.length <= clampedWidth) {
        current = word
      } else {
        const segments = splitLongToken(word, clampedWidth)
        current = segments.pop() ?? ""
        wrapped.push(...segments)
      }
    }

    wrapped.push(current)
  }

  return wrapped.length > 0 ? wrapped : [""]
}

function roleBorderColor(role: ChatRole, palette: DemoPalette): string {
  switch (role) {
    case "user":
      return palette.chatUserBorder
    case "assistant":
      return palette.chatAssistantBorder
    case "system":
      return palette.chatSystemBorder
  }
}

function createSnapshot(root: BoxRenderable, width: number, height: number): ScrollbackSnapshot {
  return {
    root,
    width,
    height,
  }
}

const chatMessageComponent: ScrollbackComponent<ChatMessageEntry> = {
  scrollback: (entry, ctx) => {
    const roleLabel = entry.role.toUpperCase()
    const cardWidth = Math.max(16, Math.min(ctx.width, 80))
    const bodyWidth = Math.max(1, cardWidth - 2)
    const wrappedMessage = wrapText(entry.text, bodyWidth)
    const cardHeight = Math.max(3, wrappedMessage.length + 2)

    const card = new BoxRenderable(ctx.renderContext, {
      id: `chat-card-${entry.role}-${entry.timestamp.getTime()}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: cardWidth,
      height: cardHeight,
      border: true,
      borderStyle: "single",
      borderColor: roleBorderColor(entry.role, entry.palette),
      backgroundColor: "transparent",
      title: `${roleLabel} ${formatTimestamp(entry.timestamp)}`,
    })

    const body = new TextRenderable(ctx.renderContext, {
      id: `chat-card-text-${entry.timestamp.getTime()}`,
      position: "absolute",
      left: 1,
      top: 1,
      width: bodyWidth,
      height: Math.max(1, cardHeight - 2),
      content: wrappedMessage.join("\n"),
      fg: entry.palette.chatBodyText,
    })

    card.add(body)

    return createSnapshot(card, cardWidth, cardHeight)
  },
}

const bulletListComponent: ScrollbackComponent<BulletListEntry> = {
  scrollback: (entry, ctx) => {
    const lines: string[] = []
    const cardWidth = Math.max(20, Math.min(ctx.width, 82))
    const bodyWidth = Math.max(1, cardWidth - 2)
    const itemWidth = Math.max(1, bodyWidth - 2)

    for (const item of entry.items) {
      const wrappedItem = wrapText(item, itemWidth)
      wrappedItem.forEach((line, index) => {
        lines.push(`${index === 0 ? "- " : "  "}${line}`)
      })
    }

    const cardHeight = Math.max(3, lines.length + 2)
    const card = new BoxRenderable(ctx.renderContext, {
      id: `bullet-card-${Date.now()}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: cardWidth,
      height: cardHeight,
      border: true,
      borderStyle: "single",
      borderColor: entry.palette.bulletBorder,
      backgroundColor: "transparent",
      title: truncateToWidth(entry.title, Math.max(1, cardWidth - 4)),
    })

    const body = new TextRenderable(ctx.renderContext, {
      id: `bullet-card-text-${Date.now()}`,
      position: "absolute",
      left: 1,
      top: 1,
      width: bodyWidth,
      height: Math.max(1, cardHeight - 2),
      content: lines.join("\n"),
      fg: entry.palette.bulletBodyText,
    })

    card.add(body)

    return createSnapshot(card, cardWidth, cardHeight)
  },
}

const toolCardComponent: ScrollbackComponent<ToolCardEntry> = {
  scrollback: (entry, ctx) => {
    const cardWidth = Math.max(18, Math.min(ctx.width, 76))
    const bodyWidth = Math.max(1, cardWidth - 2)
    const lines: string[] = []

    entry.rows.forEach((row, rowIndex) => {
      const wrappedRows = wrapText(row, bodyWidth)
      for (const wrappedRow of wrappedRows) {
        lines.push(wrappedRow)
      }

      if (rowIndex < entry.rows.length - 1) {
        lines.push("")
      }
    })

    const cardHeight = Math.max(3, lines.length + 2)
    const card = new BoxRenderable(ctx.renderContext, {
      id: `tool-card-${Date.now()}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: cardWidth,
      height: cardHeight,
      border: true,
      borderStyle: "double",
      borderColor: entry.palette.toolBorder,
      backgroundColor: "transparent",
      title: truncateToWidth(entry.title, Math.max(1, cardWidth - 4)),
    })

    const body = new TextRenderable(ctx.renderContext, {
      id: `tool-card-text-${Date.now()}`,
      position: "absolute",
      left: 1,
      top: 1,
      width: bodyWidth,
      height: Math.max(1, cardHeight - 2),
      content: lines.join("\n"),
      fg: entry.palette.toolBodyText,
    })

    card.add(body)

    return createSnapshot(card, cardWidth, cardHeight)
  },
}

const renderableSnapshotComponent: ScrollbackComponent<RenderableSnapshotEntry> = {
  scrollback: (entry, ctx) => {
    const width = Math.max(1, Math.min(entry.width, ctx.width))
    const height = Math.max(1, entry.height)
    const root = entry.build(ctx.renderContext)
    return createSnapshot(root, width, height)
  },
}

class SplitFooterChatDemo {
  private footerContainer: BoxRenderable
  private headerText: TextRenderable
  private helpText: TextRenderable
  private statusText: TextRenderable
  private typingText: TextRenderable
  private inputFrame: BoxRenderable
  private promptText: TextRenderable
  private input: InputRenderable

  private publishQueue: Promise<void> = Promise.resolve()
  private pendingAssistantReply: ReturnType<typeof setTimeout> | null = null
  private commitCount: number = 0
  private messageCount: number = 0
  private assistantTyping: boolean = false
  private statusMessage: string = "Ready"
  private destroyed: boolean = false
  private palette: DemoPalette

  constructor(private renderer: CliRenderer) {
    this.palette = resolveDemoPalette(this.renderer.themeMode)
    this.renderer.footerHeight = this.clampFooterHeight(DEFAULT_FOOTER_HEIGHT)
    this.renderer.screenMode = "split-footer"
    this.renderer.externalOutputMode = "capture-stdout"
    this.renderer.setBackgroundColor(this.palette.appBackground)

    this.footerContainer = new BoxRenderable(this.renderer, {
      id: "split-chat-footer-container",
      position: "absolute",
      left: 0,
      top: 0,
      width: this.renderer.width,
      height: this.renderer.height,
      zIndex: 10,
      border: true,
      borderStyle: "double",
      borderColor: this.palette.footerBorder,
      backgroundColor: this.palette.footerBackground,
      title: "Direct Mode Chat",
      titleAlignment: "center",
    })

    this.headerText = new TextRenderable(this.renderer, {
      id: "split-chat-header",
      content: "Split footer chat + snapshot commits",
      position: "absolute",
      left: 2,
      top: 1,
      width: Math.max(1, this.renderer.width - 4),
      height: 1,
      zIndex: 11,
      fg: this.palette.headerText,
    })

    this.helpText = new TextRenderable(this.renderer, {
      id: "split-chat-help",
      content: "Type /help, /tree for renderable snapshots, /footer <n> to resize",
      position: "absolute",
      left: 2,
      top: 2,
      width: Math.max(1, this.renderer.width - 4),
      height: 1,
      zIndex: 11,
      fg: this.palette.helpText,
    })

    this.statusText = new TextRenderable(this.renderer, {
      id: "split-chat-status",
      content: "",
      position: "absolute",
      left: 2,
      top: 3,
      width: Math.max(1, this.renderer.width - 4),
      height: 1,
      zIndex: 11,
      fg: this.palette.statusText,
    })

    this.typingText = new TextRenderable(this.renderer, {
      id: "split-chat-typing",
      content: "",
      position: "absolute",
      left: 2,
      top: 4,
      width: Math.max(1, this.renderer.width - 4),
      height: 1,
      zIndex: 11,
      fg: this.palette.typingText,
    })

    this.inputFrame = new BoxRenderable(this.renderer, {
      id: "split-chat-input-frame",
      position: "absolute",
      left: 2,
      top: Math.max(5, this.renderer.height - 4),
      width: Math.max(4, this.renderer.width - 4),
      height: 3,
      zIndex: 11,
      border: true,
      borderStyle: "single",
      borderColor: this.palette.inputFrameBorder,
      backgroundColor: this.palette.inputFrameBackground,
    })

    this.promptText = new TextRenderable(this.renderer, {
      id: "split-chat-prompt",
      content: "you >",
      position: "absolute",
      left: 3,
      top: Math.max(6, this.renderer.height - 3),
      width: 5,
      height: 1,
      zIndex: 12,
      fg: this.palette.promptText,
      bg: "transparent",
    })

    this.input = new InputRenderable(this.renderer, {
      id: "split-chat-input",
      position: "absolute",
      left: 9,
      top: Math.max(6, this.renderer.height - 3),
      width: Math.max(1, this.renderer.width - 12),
      height: 1,
      zIndex: 12,
      placeholder: "Type a message and press Enter...",
      placeholderColor: this.palette.inputPlaceholder,
      textColor: this.palette.inputText,
      focusedTextColor: this.palette.inputFocusedText,
      backgroundColor: this.palette.inputFrameBackground,
      focusedBackgroundColor: this.palette.inputFocusedBackground,
      cursorColor: this.palette.inputCursor,
      value: "",
      maxLength: 400,
    })

    this.footerContainer.add(this.headerText)
    this.footerContainer.add(this.helpText)
    this.footerContainer.add(this.statusText)
    this.footerContainer.add(this.typingText)
    this.footerContainer.add(this.inputFrame)
    this.footerContainer.add(this.promptText)
    this.footerContainer.add(this.input)
    this.renderer.root.add(this.footerContainer)

    this.input.on(InputRenderableEvents.INPUT, this.handleInputChange)
    this.input.on(InputRenderableEvents.ENTER, this.handleInputSubmit)
    this.renderer.keyInput.on("keypress", this.handleKeyPress)
    this.renderer.on("resize", this.handleResize)
    this.renderer.on(CliRenderEvents.THEME_MODE, this.handleThemeMode)

    this.relayout()
    this.applyPalette()
    this.refreshStatus("Type /help, then send a prompt to publish your first snapshot commit")
    this.input.focus()
  }

  private clampFooterHeight(nextHeight: number): number {
    const maxFooterHeight = Math.max(1, this.renderer.terminalHeight - MIN_MAIN_SCREEN_HEIGHT)
    const minFooterHeight = Math.min(MIN_FOOTER_HEIGHT, maxFooterHeight)
    return Math.min(Math.max(nextHeight, minFooterHeight), maxFooterHeight)
  }

  private relayout(): void {
    this.footerContainer.width = this.renderer.width
    this.footerContainer.height = this.renderer.height

    const contentWidth = Math.max(1, this.renderer.width - 4)
    this.headerText.width = contentWidth
    this.helpText.width = contentWidth
    this.statusText.width = contentWidth
    this.typingText.width = contentWidth

    const inputTop = Math.max(5, this.renderer.height - 4)
    this.inputFrame.top = inputTop
    this.inputFrame.width = Math.max(4, this.renderer.width - 4)

    this.promptText.top = inputTop + 1
    this.input.top = inputTop + 1

    const inputLeft = this.promptText.x + this.promptText.width + 1
    const availableInputWidth = Math.max(1, this.inputFrame.width - (inputLeft - this.inputFrame.x) - 2)
    this.input.x = inputLeft
    this.input.width = availableInputWidth
  }

  private applyPalette(): void {
    this.renderer.setBackgroundColor(this.palette.appBackground)
    this.footerContainer.borderColor = this.palette.footerBorder
    this.footerContainer.backgroundColor = this.palette.footerBackground
    this.headerText.fg = this.palette.headerText
    this.helpText.fg = this.palette.helpText
    this.statusText.fg = this.palette.statusText
    this.typingText.fg = this.palette.typingText
    this.inputFrame.borderColor = this.palette.inputFrameBorder
    this.inputFrame.backgroundColor = this.palette.inputFrameBackground
    this.promptText.fg = this.palette.promptText
    this.input.placeholderColor = this.palette.inputPlaceholder
    this.input.textColor = this.palette.inputText
    this.input.focusedTextColor = this.palette.inputFocusedText
    this.input.backgroundColor = this.palette.inputFrameBackground
    this.input.focusedBackgroundColor = this.palette.inputFocusedBackground
    this.input.cursorColor = this.palette.inputCursor
  }

  private refreshStatus(message?: string): void {
    if (message) {
      this.statusMessage = message
    }

    const statusParts = [
      `commits ${this.commitCount}`,
      `messages ${this.messageCount}`,
      `footer ${this.renderer.footerHeight}`,
      `width ${this.renderer.width}`,
      `widthMethod ${this.renderer.widthMethod}`,
    ]
    this.statusText.content = `${statusParts.join(" | ")} | ${this.statusMessage}`
    this.typingText.content = this.assistantTyping ? "assistant is composing a response..." : ""
  }

  private publishToScrollback<Data>(component: ScrollbackComponent<Data>, data: Data): void {
    this.publishQueue = this.publishQueue
      .then(async () => {
        if (this.destroyed) return

        await this.renderer.writeToScrollback(component, data)

        if (this.destroyed) return

        this.commitCount += 1
        this.refreshStatus()
      })
      .catch((error) => {
        if (!this.destroyed) {
          this.refreshStatus("scrollback publish failed")
          console.error("split-mode-demo publish failed", error)
        }
      })
  }

  private appendChat(role: ChatRole, text: string): void {
    this.messageCount += 1
    this.publishToScrollback(chatMessageComponent, {
      role,
      text,
      timestamp: new Date(),
      palette: this.palette,
    })
  }

  private appendBulletList(title: string, items: string[]): void {
    this.publishToScrollback(bulletListComponent, {
      title,
      items,
      palette: this.palette,
    })
  }

  private appendToolCard(title: string, rows: string[]): void {
    this.publishToScrollback(toolCardComponent, {
      title,
      rows,
      palette: this.palette,
    })
  }

  private appendRenderableSnapshot(
    width: number,
    height: number,
    build: (context: RenderContext) => BoxRenderable,
  ): void {
    this.publishToScrollback(renderableSnapshotComponent, {
      width,
      height,
      build,
    })
  }

  private appendComponentTreeShowcase(title: string): void {
    const cardWidth = Math.max(32, Math.min(this.renderer.width, 88))
    const cardHeight = 11
    const palette = this.palette

    this.appendRenderableSnapshot(cardWidth, cardHeight, (snapshotContext) => {
      const frame = new BoxRenderable(snapshotContext, {
        id: "showcase-frame",
        position: "absolute",
        left: 0,
        top: 0,
        width: cardWidth,
        height: cardHeight,
        border: true,
        borderStyle: "double",
        borderColor: palette.toolBorder,
        backgroundColor: "transparent",
        title,
      })

      const banner = new BoxRenderable(snapshotContext, {
        id: "showcase-banner",
        position: "absolute",
        left: 1,
        top: 1,
        width: Math.max(1, cardWidth - 2),
        height: 1,
        backgroundColor: palette.footerBackground,
      })

      const bannerText = new TextRenderable(snapshotContext, {
        id: "showcase-banner-text",
        position: "absolute",
        left: 2,
        top: 1,
        width: Math.max(1, cardWidth - 4),
        height: 1,
        content: "nested renderable tree snapshot",
        fg: palette.headerText,
      })

      const leftPanel = new BoxRenderable(snapshotContext, {
        id: "showcase-left-panel",
        position: "absolute",
        left: 2,
        top: 3,
        width: Math.max(10, Math.floor((cardWidth - 6) * 0.5)),
        height: 5,
        border: true,
        borderStyle: "single",
        borderColor: palette.chatAssistantBorder,
        backgroundColor: "transparent",
        title: "metrics",
      })

      const rightPanel = new BoxRenderable(snapshotContext, {
        id: "showcase-right-panel",
        position: "absolute",
        left: Math.max(3, Math.floor(cardWidth * 0.55)),
        top: 3,
        width: Math.max(8, cardWidth - Math.max(3, Math.floor(cardWidth * 0.55)) - 2),
        height: 5,
        border: true,
        borderStyle: "single",
        borderColor: palette.chatUserBorder,
        backgroundColor: "transparent",
        title: "tools",
      })

      const metricBarA = new BoxRenderable(snapshotContext, {
        id: "showcase-metric-bar-a",
        position: "absolute",
        left: 3,
        top: 4,
        width: Math.max(2, Math.floor((cardWidth - 10) * 0.3)),
        height: 1,
        backgroundColor: palette.chatSystemBorder,
      })

      const metricBarB = new BoxRenderable(snapshotContext, {
        id: "showcase-metric-bar-b",
        position: "absolute",
        left: 3,
        top: 6,
        width: Math.max(2, Math.floor((cardWidth - 10) * 0.4)),
        height: 1,
        backgroundColor: palette.chatAssistantBorder,
      })

      const toolLine = new TextRenderable(snapshotContext, {
        id: "showcase-tool-line",
        position: "absolute",
        left: Math.max(4, Math.floor(cardWidth * 0.55) + 1),
        top: 5,
        width: Math.max(1, cardWidth - Math.max(4, Math.floor(cardWidth * 0.55) + 1) - 2),
        height: 1,
        content: "render -> snapshot -> native commit",
        fg: palette.toolBodyText,
      })

      const footerLine = new TextRenderable(snapshotContext, {
        id: "showcase-footer-line",
        position: "absolute",
        left: 2,
        top: 9,
        width: Math.max(1, cardWidth - 4),
        height: 1,
        content: "actual renderable tree commit (no UTF-8 payload bridge)",
        fg: palette.helpText,
      })

      frame.add(banner)
      frame.add(bannerText)
      frame.add(leftPanel)
      frame.add(rightPanel)
      frame.add(metricBarA)
      frame.add(metricBarB)
      frame.add(toolLine)
      frame.add(footerLine)
      return frame
    })
  }

  private publishWelcomeEntries(): void {
    this.appendChat(
      "system",
      `Split footer ready. Render width ${this.renderer.width}, width method ${this.renderer.widthMethod}.`,
    )

    this.appendBulletList("Commands", [
      "/help - show command guide",
      "/card - append a tool-card component",
      "/tree - append a nested renderable tree snapshot",
      "/demo - append a short multi-component transcript",
      "/welcome - append the initial onboarding entries",
      "/footer <n> - change footer height",
    ])

    this.appendToolCard("component snapshot", [
      "source: split-mode-demo",
      "path: renderer.writeToScrollback(component, data)",
      "payload: native snapshot commit",
      "ownership: placement and pinning stay native",
    ])
  }

  private handleInputChange = (value: string): void => {
    this.refreshStatus(`draft length ${value.length}`)
  }

  private handleInputSubmit = (value: string): void => {
    const trimmedValue = value.trim()
    if (trimmedValue.length === 0) {
      this.refreshStatus("empty draft ignored")
      return
    }

    this.input.value = ""
    this.appendChat("user", trimmedValue)

    if (trimmedValue.startsWith("/")) {
      this.handleCommand(trimmedValue)
      return
    }

    this.scheduleAssistantReply(trimmedValue)
  }

  private handleCommand(commandLine: string): void {
    const [command, ...args] = commandLine.split(/\s+/)

    switch (command.toLowerCase()) {
      case "/help": {
        this.appendBulletList("Interactive commands", [
          "/help - print this help block",
          "/card - render one tool-card component entry",
          "/tree - render a nested renderable tree with backgrounds",
          "/demo - render a mini sequence of different component entries",
          "/welcome - enqueue onboarding entries",
          "/footer <n> - resize the split footer to a specific height",
        ])
        this.refreshStatus("help published")
        return
      }

      case "/card": {
        this.appendToolCard("tool call: summarize-state", [
          "status: ok",
          `current footer: ${this.renderer.footerHeight}`,
          `render width: ${this.renderer.width}`,
          "result: one snapshot component entry appended",
        ])
        this.refreshStatus("tool card published")
        return
      }

      case "/tree": {
        this.appendComponentTreeShowcase("component tree snapshot")
        this.refreshStatus("renderable tree snapshot published")
        return
      }

      case "/demo": {
        this.publishDemoSequence()
        this.refreshStatus("demo sequence queued")
        return
      }

      case "/welcome": {
        this.publishWelcomeEntries()
        this.refreshStatus("welcome entries queued")
        return
      }

      case "/footer": {
        if (args.length === 0) {
          this.appendChat("system", "usage: /footer <height>")
          this.refreshStatus("missing footer height")
          return
        }

        const requestedHeight = Number.parseInt(args[0], 10)
        if (!Number.isFinite(requestedHeight)) {
          this.appendChat("system", `invalid footer height: ${args[0]}`)
          this.refreshStatus("invalid footer height")
          return
        }

        const clampedHeight = this.clampFooterHeight(requestedHeight)
        this.renderer.footerHeight = clampedHeight
        this.relayout()
        this.appendChat("system", `footer height set to ${clampedHeight}`)
        this.refreshStatus(`footer resized to ${clampedHeight}`)
        return
      }

      default: {
        this.appendChat("system", `unknown command: ${command}`)
        this.refreshStatus("unknown command")
      }
    }
  }

  private publishDemoSequence(): void {
    this.appendChat(
      "assistant",
      "This demo uses writeToScrollback(component, data). Each call commits one snapshot artifact.",
    )

    this.appendToolCard("render pipeline", [
      "1) TS builds a renderable tree from component + data",
      "2) renderer snapshots the tree into a native buffer",
      "3) native commit appends snapshot then repaints footer",
    ])

    this.appendBulletList("Why this shape is useful", [
      "lets us iterate on commit primitives with realistic chat turns",
      "keeps split placement ownership native",
      "avoids reintroducing TS scrollback placement state",
    ])

    this.appendComponentTreeShowcase("demo: arbitrary renderable tree")
  }

  private scheduleAssistantReply(userText: string): void {
    if (this.pendingAssistantReply) {
      clearTimeout(this.pendingAssistantReply)
      this.pendingAssistantReply = null
    }

    this.assistantTyping = true
    this.refreshStatus("assistant thinking")

    const delayMs = Math.min(1200, 300 + userText.length * 10)
    this.pendingAssistantReply = setTimeout(() => {
      this.pendingAssistantReply = null

      if (this.destroyed) {
        return
      }

      const response = this.buildAssistantReply(userText)
      this.appendChat("assistant", response)
      this.assistantTyping = false
      this.refreshStatus("assistant reply queued")
    }, delayMs)
  }

  private buildAssistantReply(userText: string): string {
    const normalized = userText.toLowerCase()

    if (normalized.includes("stage 3")) {
      return "Stage 3 now means snapshot commits through writeToScrollback while split placement stays native."
    }

    if (normalized.includes("component")) {
      return "Each transcript turn can be a renderable tree snapshot committed as one append-only artifact."
    }

    if (normalized.includes("resize")) {
      return "Try /footer 10 or /footer 18 to exercise resize transitions while keeping append-only commits."
    }

    return `Got it: \"${truncateToWidth(userText, 80)}\". Try /demo for a multi-component publish sequence.`
  }

  private adjustFooterHeight(delta: number): void {
    const nextHeight = this.clampFooterHeight(this.renderer.footerHeight + delta)
    if (nextHeight === this.renderer.footerHeight) {
      this.refreshStatus("footer already at limit")
      return
    }

    this.renderer.footerHeight = nextHeight
    this.relayout()
    this.appendChat("system", `footer height adjusted to ${nextHeight}`)
    this.refreshStatus(`footer adjusted to ${nextHeight}`)
  }

  private handleKeyPress = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "l") {
      this.input.value = ""
      this.refreshStatus("draft cleared")
      return
    }

    if (key.ctrl && key.name === "r") {
      this.publishDemoSequence()
      this.refreshStatus("demo sequence queued")
      return
    }

    if (key.ctrl && key.name === "up") {
      this.adjustFooterHeight(1)
      return
    }

    if (key.ctrl && key.name === "down") {
      this.adjustFooterHeight(-1)
      return
    }

    if (key.name === "escape") {
      this.input.focus()
      this.refreshStatus("input focused")
    }
  }

  private handleThemeMode = (mode: ThemeMode): void => {
    this.palette = resolveDemoPalette(mode)
    this.applyPalette()
    this.refreshStatus(`theme ${mode}`)
  }

  private handleResize = (): void => {
    const clampedFooterHeight = this.clampFooterHeight(this.renderer.footerHeight)
    if (clampedFooterHeight !== this.renderer.footerHeight) {
      this.renderer.footerHeight = clampedFooterHeight
    }

    this.relayout()
    this.refreshStatus("layout resized")
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true

    if (this.pendingAssistantReply) {
      clearTimeout(this.pendingAssistantReply)
      this.pendingAssistantReply = null
    }

    this.input.off(InputRenderableEvents.INPUT, this.handleInputChange)
    this.input.off(InputRenderableEvents.ENTER, this.handleInputSubmit)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("resize", this.handleResize)
    this.renderer.off(CliRenderEvents.THEME_MODE, this.handleThemeMode)

    this.input.destroy()
    this.renderer.root.remove(this.footerContainer.id)

    if (!this.renderer.isDestroyed) {
      this.renderer.externalOutputMode = "passthrough"
      this.renderer.screenMode = "main-screen"
    }
  }
}

let activeDemo: SplitFooterChatDemo | null = null

export function run(rendererInstance: CliRenderer): void {
  if (activeDemo) {
    activeDemo.destroy()
  }

  activeDemo = new SplitFooterChatDemo(rendererInstance)
}

export function destroy(_rendererInstance: CliRenderer): void {
  if (!activeDemo) {
    return
  }

  activeDemo.destroy()
  activeDemo = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: true,
    useMouse: true,
    screenMode: "split-footer",
    footerHeight: DEFAULT_FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
