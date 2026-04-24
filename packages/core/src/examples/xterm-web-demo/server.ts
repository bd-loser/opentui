#!/usr/bin/env bun
//
// opentui × xterm.js — minimal counter demo.
//
// Launches a Bun HTTP + WebSocket server. Each browser tab gets its own
// CliRenderer wired to a duplex stream pair: rendered ANSI flows through the
// NativeSpanFeed → WebSocket → xterm.js, and keystrokes flow back
// xterm.js → WebSocket → CliRenderer.stdin.
//
// Run:
//   bun run packages/core/src/examples/xterm-web-demo/server.ts
// Then open http://localhost:3000/.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable, Writable } from "node:stream"
import type { ServerWebSocket } from "bun"

import { BoxRenderable, CliRenderEvents, CliRenderer, TextRenderable, createCliRenderer, type KeyEvent } from "../../index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf8")

interface Session {
  renderer: CliRenderer | null
  stdin: Readable | null
  card: BoxRenderable | null
  counterText: TextRenderable | null
  sessionInfoText: TextRenderable | null
  liveStatusText: TextRenderable | null
  cols: number
  rows: number
  sessionId: string
  theme: SessionTheme
  closed: boolean
  pendingWrite: ((error?: Error | null) => void) | null
}

interface SessionTheme {
  borderColor: string
  cardColor: string
  counterColor: string
  accentColor: string
  noteColor: string
}

const SESSION_THEMES: SessionTheme[] = [
  {
    borderColor: "#38bdf8",
    cardColor: "#1e293b",
    counterColor: "#fde68a",
    accentColor: "#67e8f9",
    noteColor: "#86efac",
  },
  {
    borderColor: "#f472b6",
    cardColor: "#3b1e31",
    counterColor: "#f9a8d4",
    accentColor: "#f5d0fe",
    noteColor: "#fdba74",
  },
  {
    borderColor: "#a78bfa",
    cardColor: "#2e2061",
    counterColor: "#ddd6fe",
    accentColor: "#c4b5fd",
    noteColor: "#93c5fd",
  },
]

const ACTIVE_SESSIONS = new Set<ServerWebSocket<Session>>()
const LIVE_FRAMES = ["[=     ]", "[==    ]", "[===   ]", "[ ===  ]", "[  === ]", "[   == ]", "[    = ]"]
const CARD_WIDTH = 46
const CARD_HEIGHT = 12

let liveFrameIndex = 0
let sharedCounter = 0
let sharedOffsetX = 0
let sharedOffsetY = 0

function formatSigned(value: number) {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value)}`
}

function formatScore(value: number) {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value).toString().padStart(3, "0")}`
}

function createSessionId() {
  return crypto.randomUUID().slice(0, 4).toUpperCase()
}

function pickSessionTheme(sessionId: string) {
  return SESSION_THEMES[sessionId.charCodeAt(0) % SESSION_THEMES.length]
}

function finishPendingWrite(session: Session) {
  const pendingWrite = session.pendingWrite
  if (!pendingWrite) return
  session.pendingWrite = null
  pendingWrite()
}

function setTextContent(renderable: TextRenderable | null, content: string) {
  if (!renderable) return
  try {
    renderable.content = content
  } catch {
    // Renderer teardown can destroy TextBuffer instances before the WS close
    // callback clears our references.
  }
}

function cleanupSession(ws: ServerWebSocket<Session>) {
  ACTIVE_SESSIONS.delete(ws)
  ws.data.card = null
  ws.data.counterText = null
  ws.data.sessionInfoText = null
  ws.data.liveStatusText = null
  if (ACTIVE_SESSIONS.size === 0) {
    sharedCounter = 0
    sharedOffsetX = 0
    sharedOffsetY = 0
    return
  }

  clampSharedOffsets()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function clampSharedOffsets() {
  if (ACTIVE_SESSIONS.size === 0) {
    sharedOffsetX = 0
    sharedOffsetY = 0
    return
  }

  let minOffsetX = Number.NEGATIVE_INFINITY
  let maxOffsetX = Number.POSITIVE_INFINITY
  let minOffsetY = Number.NEGATIVE_INFINITY
  let maxOffsetY = Number.POSITIVE_INFINITY

  for (const ws of ACTIVE_SESSIONS) {
    const centerX = Math.floor((ws.data.cols - CARD_WIDTH) / 2)
    const centerY = Math.floor((ws.data.rows - CARD_HEIGHT) / 2)
    const sessionMaxX = Math.max(0, ws.data.cols - CARD_WIDTH)
    const sessionMaxY = Math.max(0, ws.data.rows - CARD_HEIGHT)

    minOffsetX = Math.max(minOffsetX, -centerX)
    maxOffsetX = Math.min(maxOffsetX, sessionMaxX - centerX)
    minOffsetY = Math.max(minOffsetY, -centerY)
    maxOffsetY = Math.min(maxOffsetY, sessionMaxY - centerY)
  }

  sharedOffsetX = clamp(sharedOffsetX, minOffsetX, maxOffsetX)
  sharedOffsetY = clamp(sharedOffsetY, minOffsetY, maxOffsetY)
}

function renderCardPosition(session: Session) {
  if (!session.card) return

  const centerX = Math.floor((session.cols - CARD_WIDTH) / 2)
  const centerY = Math.floor((session.rows - CARD_HEIGHT) / 2)
  const maxX = Math.max(0, session.cols - CARD_WIDTH)
  const maxY = Math.max(0, session.rows - CARD_HEIGHT)

  session.card.x = clamp(centerX + sharedOffsetX, 0, maxX)
  session.card.y = clamp(centerY + sharedOffsetY, 0, maxY)
}

function renderAllCardPositions() {
  for (const ws of ACTIVE_SESSIONS) {
    renderCardPosition(ws.data)
  }
}

function nudgeSharedCard(dx: number, dy: number) {
  sharedOffsetX += dx
  sharedOffsetY += dy
  clampSharedOffsets()
  sharedCounter += 1
  renderAllCardPositions()
  renderAllCounters()
}

function closeSession(ws: ServerWebSocket<Session>, code = 1000, reason = "quit") {
  if (ws.data.closed) return
  ws.data.closed = true
  finishPendingWrite(ws.data)
  try {
    ws.close(code, reason)
  } catch {
    // Socket may already be closing.
  }
}

/**
 * Minimal duplex stream pair for the renderer. The stdin is a plain
 * Readable whose data events are driven by the WebSocket; the stdout is
 * a Writable that forwards each chunk to the WebSocket as a binary frame.
 */
function createSessionStreams(ws: ServerWebSocket<Session>, initialCols: number, initialRows: number) {
  // Renderer attaches a `data` listener to stdin and expects bytes.
  // A no-op `read()` keeps the stream in flowing mode without auto-end.
  const stdin = new Readable({ read() {} })

  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      // Copy into a fresh buffer so we don't hold a view into the feed's
      // chunk memory (which is reclaimed once this callback fires).
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
      try {
        const sendResult = ws.sendBinary(bytes)
        if (sendResult === -1) {
          ws.data.pendingWrite = callback
          return
        }
        if (sendResult === 0) {
          closeSession(ws, 1011, "socket-send-failed")
        }
      } catch {
        closeSession(ws, 1011, "socket-send-failed")
      }
      callback()
    },
  })
  ;(stdout as unknown as { columns: number }).columns = initialCols
  ;(stdout as unknown as { rows: number }).rows = initialRows

  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    rawStdin: stdin,
  }
}

function renderCounter(session: Session) {
  setTextContent(session.counterText, `Score ${formatScore(sharedCounter)}`)
}

function renderAllCounters() {
  for (const ws of ACTIVE_SESSIONS) {
    renderCounter(ws.data)
  }
}

function renderSessionInfo(session: Session) {
  setTextContent(session.sessionInfoText, `Tabs ${ACTIVE_SESSIONS.size}  Session ${session.sessionId}  ${session.cols}x${session.rows}`)
}

function renderLiveStatus(session: Session) {
  setTextContent(session.liveStatusText, `Offset ${formatSigned(sharedOffsetX)},${formatSigned(sharedOffsetY)}  ${LIVE_FRAMES[liveFrameIndex]}`)
}

function renderSharedStatus() {
  for (const ws of ACTIVE_SESSIONS) {
    renderLiveStatus(ws.data)
  }
}

setInterval(() => {
  if (ACTIVE_SESSIONS.size === 0) return
  liveFrameIndex = (liveFrameIndex + 1) % LIVE_FRAMES.length
  renderSharedStatus()
}, 140)

function setupCounterUI(ws: ServerWebSocket<Session>, renderer: CliRenderer, session: Session) {
  renderer.setBackgroundColor("#0f172a")

  const container = new BoxRenderable(renderer, {
    id: "xterm-demo-root",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 0,
  })

  const card = new BoxRenderable(renderer, {
    id: "xterm-demo-card",
    position: "absolute",
    left: 0,
    top: 0,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    backgroundColor: session.theme.cardColor,
    borderStyle: "double",
    borderColor: session.theme.borderColor,
    title: " opentui × xterm.js ",
    titleAlignment: "center",
    border: true,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 1,
  })

  const counterText = new TextRenderable(renderer, {
    id: "xterm-demo-counter",
    content: `Shared counter: ${sharedCounter}`,
    fg: session.theme.counterColor,
  })
  card.add(counterText)

  const transportText = new TextRenderable(renderer, {
    id: "xterm-demo-transport",
    content: "shared server state in xterm",
    fg: "#e2e8f0",
  })
  card.add(transportText)

  const multiTabText = new TextRenderable(renderer, {
    id: "xterm-demo-multi-tab",
    content: "move here, mirror everywhere",
    fg: "#cbd5e1",
  })
  card.add(multiTabText)

  const sessionInfoText = new TextRenderable(renderer, {
    id: "xterm-demo-session-info",
    content: "",
    fg: session.theme.accentColor,
  })
  card.add(sessionInfoText)

  const liveStatusText = new TextRenderable(renderer, {
    id: "xterm-demo-live-status",
    content: "",
    fg: session.theme.noteColor,
  })
  card.add(liveStatusText)

  const hint = new TextRenderable(renderer, {
    id: "xterm-demo-hint",
    content: "hjkl move   +/- score   r reset",
    fg: session.theme.noteColor,
  })
  card.add(hint)

  container.add(card)
  renderer.root.add(container)

  session.card = card
  session.counterText = counterText
  session.sessionInfoText = sessionInfoText
  session.liveStatusText = liveStatusText
  renderCardPosition(session)
  renderSessionInfo(session)
  renderLiveStatus(session)

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (!session.renderer) return
    const sequence = key.sequence ?? ""

    if ((key.ctrl && key.name === "c") || key.name === "q") {
      closeSession(ws)
      return
    }

    if (key.name === "h") {
      nudgeSharedCard(-2, 0)
      return
    }

    if (key.name === "l") {
      nudgeSharedCard(2, 0)
      return
    }

    if (key.name === "k") {
      nudgeSharedCard(0, -1)
      return
    }

    if (key.name === "j") {
      nudgeSharedCard(0, 1)
      return
    }

    if (key.name === "up" || sequence === "+" || sequence === "=") {
      sharedCounter += 1
      renderAllCounters()
      return
    }

    if (key.name === "down" || sequence === "-" || sequence === "_") {
      sharedCounter -= 1
      renderAllCounters()
      return
    }

    if (key.name === "r") {
      sharedCounter = 0
      renderAllCounters()
      return
    }
  })
}

async function startSession(ws: ServerWebSocket<Session>) {
  const { stdin, stdout, rawStdin } = createSessionStreams(ws, ws.data.cols, ws.data.rows)
  ws.data.stdin = rawStdin

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: ws.data.cols,
    height: ws.data.rows,
    exitOnCtrlC: false, // we handle quit ourselves so we can tidy the socket
    exitSignals: [],
    targetFps: 30,
  })

  renderer.on(CliRenderEvents.DESTROY, () => {
    cleanupSession(ws)
  })

  ws.data.renderer = renderer
  setupCounterUI(ws, renderer, ws.data)
}

function handleResize(ws: ServerWebSocket<Session>, cols: number, rows: number) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  ws.data.cols = cols
  ws.data.rows = rows
  clampSharedOffsets()
  renderAllCardPositions()
  renderSessionInfo(ws.data)
  if (ws.data.renderer) {
    ws.data.renderer.resize(cols, rows)
  }
}

const server = Bun.serve<Session>({
  port: Number(process.env.PORT ?? 3000),
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      const sessionId = createSessionId()
      const theme = pickSessionTheme(sessionId)
      const ok = srv.upgrade(req, {
        data: {
          renderer: null,
          stdin: null,
          card: null,
          counterText: null,
          sessionInfoText: null,
          liveStatusText: null,
          cols: 80,
          rows: 24,
          sessionId,
          theme,
          closed: false,
          pendingWrite: null,
        } satisfies Session,
      })
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    return new Response("Not found", { status: 404 })
  },
  websocket: {
    async open(ws) {
      try {
        await startSession(ws)
        ACTIVE_SESSIONS.add(ws)
        clampSharedOffsets()
        renderAllCardPositions()
        renderAllCounters()
        renderSharedStatus()
      } catch (err) {
        console.error("failed to start session", err)
        ws.close(1011, "session-start-failed")
      }
    },

    drain(ws) {
      finishPendingWrite(ws.data)
    },

    message(ws, message) {
      if (ws.data.closed) return

      // Binary frames are raw keyboard bytes from xterm.
      if (message instanceof Buffer || message instanceof Uint8Array) {
        if (!ws.data.stdin) return
        const bytes = message instanceof Buffer ? message : Buffer.from(message)
        ws.data.stdin.push(bytes)
        return
      }

      // JSON control frames (currently just `resize`).
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as { type?: string; cols?: number; rows?: number }
          if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
            handleResize(ws, parsed.cols, parsed.rows)
          }
        } catch {
          // Ignore malformed control frames.
        }
      }
    },

    close(ws) {
      ws.data.closed = true
      finishPendingWrite(ws.data)
      cleanupSession(ws)
      renderAllCardPositions()
      renderAllCounters()
      renderSharedStatus()
      if (ws.data.renderer) {
        try {
          ws.data.renderer.destroy()
        } catch (err) {
          console.error("error destroying renderer on WS close", err)
        }
      }
      ws.data.renderer = null
      try {
        ws.data.stdin?.push(null)
      } catch {
        // ignore
      }
      ws.data.stdin = null
    },
  },
})

console.log(`opentui × xterm demo ready on http://localhost:${server.port}/`)
