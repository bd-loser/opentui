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

import { BoxRenderable, CliRenderer, TextRenderable, createCliRenderer, type KeyEvent } from "../../index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf8")

interface Session {
  renderer: CliRenderer | null
  stdin: Readable | null
  counterText: TextRenderable | null
  counter: number
  cols: number
  rows: number
  closed: boolean
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
        ws.sendBinary(bytes)
      } catch {
        // Socket may have closed between the feed commit and us getting here.
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
  if (!session.counterText) return
  session.counterText.content = `Counter: ${session.counter}`
}

function setupCounterUI(renderer: CliRenderer, session: Session) {
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
    width: 44,
    height: 9,
    backgroundColor: "#1e293b",
    borderStyle: "double",
    borderColor: "#38bdf8",
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
    content: `Counter: ${session.counter}`,
    fg: "#fde68a",
  })
  card.add(counterText)

  const hint = new TextRenderable(renderer, {
    id: "xterm-demo-hint",
    content: "↑/k: +1   ↓/j: −1   r: reset   q: quit",
    fg: "#94a3b8",
  })
  card.add(hint)

  container.add(card)
  renderer.root.add(container)

  session.counterText = counterText

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (!session.renderer) return
    const sequence = key.sequence ?? ""

    if ((key.ctrl && key.name === "c") || key.name === "q") {
      try {
        ws_closeFromKey(session)
      } catch {
        // ignore
      }
      return
    }

    if (key.name === "up" || key.name === "k" || sequence === "+" || sequence === "=") {
      session.counter += 1
      renderCounter(session)
      return
    }

    if (key.name === "down" || key.name === "j" || sequence === "-" || sequence === "_") {
      session.counter -= 1
      renderCounter(session)
      return
    }

    if (key.name === "r") {
      session.counter = 0
      renderCounter(session)
      return
    }
  })
}

function ws_closeFromKey(session: Session) {
  if (session.closed) return
  session.closed = true
  // Mild exit message before teardown — goes out through the feed.
  try {
    session.renderer?.destroy()
  } catch (err) {
    console.error("error destroying renderer on key-close", err)
  }
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
    targetFps: 30,
  })

  ws.data.renderer = renderer
  setupCounterUI(renderer, ws.data)
}

function handleResize(ws: ServerWebSocket<Session>, cols: number, rows: number) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  ws.data.cols = cols
  ws.data.rows = rows
  if (ws.data.renderer) {
    ws.data.renderer.resize(cols, rows)
  }
}

const server = Bun.serve<Session>({
  port: Number(process.env.PORT ?? 3000),
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, {
        data: {
          renderer: null,
          stdin: null,
          counterText: null,
          counter: 0,
          cols: 80,
          rows: 24,
          closed: false,
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
      } catch (err) {
        console.error("failed to start session", err)
        ws.close(1011, "session-start-failed")
      }
    },

    message(ws, message) {
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
      if (ws.data.renderer) {
        try {
          ws.data.renderer.destroy()
        } catch (err) {
          console.error("error destroying renderer on WS close", err)
        }
      }
      try {
        ws.data.stdin?.push(null)
      } catch {
        // ignore
      }
    },
  },
})

console.log(`opentui × xterm demo ready on http://localhost:${server.port}/`)
