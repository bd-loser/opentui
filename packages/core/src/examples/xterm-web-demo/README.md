# opentui x xterm.js demo

Renders an opentui app in the browser via xterm.js over WebSockets. Each browser tab gets its own `CliRenderer` backed by a `NativeSpanFeed` — rendered ANSI flows through the feed to xterm.js, and keystrokes flow back.

## Run

```sh
bun run packages/core/src/examples/xterm-web-demo/server.ts
```

Then open http://localhost:3000/.

## How it works

```
Browser                          Server (Bun)
┌──────────────┐                ┌──────────────────────┐
│  xterm.js    │  ── keystrokes ──▶  Readable (stdin)  │
│              │                │         ↓             │
│              │                │    CliRenderer         │
│              │                │         ↓             │
│  term.write  │  ◀── ANSI ────  NativeSpanFeed → WS  │
└──────────────┘                └──────────────────────┘
```

1. **server.ts** starts a Bun HTTP + WebSocket server
2. On WebSocket connect, it creates a `CliRenderer` with a custom `stdin` (Readable) and `stdout` (Writable that sends binary frames over WS)
3. Since `stdout !== process.stdout`, the renderer auto-allocates a `NativeSpanFeed` and pipes rendered bytes through it
4. **index.html** loads xterm.js with the fit addon — the terminal auto-sizes to the browser window
5. Browser resize events propagate: `fitAddon.fit()` → `term.onResize` → WS `resize` message → `renderer.resize(cols, rows)`

## Controls

| Key            | Action            |
| -------------- | ----------------- |
| `Up` / `k`     | Increment counter |
| `Down` / `j`   | Decrement counter |
| `r`            | Reset counter     |
| `q` / `Ctrl+C` | Quit session      |

## Configuration

Set `PORT` to change the listen port (default 3000):

```sh
PORT=8080 bun run packages/core/src/examples/xterm-web-demo/server.ts
```
