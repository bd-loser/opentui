# @opentui/keymap

Keymap package for OpenTUI and browser-based UIs.

It provides a shared keymap core, adapter-specific entrypoints for HTML and OpenTUI, and framework helpers for React and Solid.

Use the HTML entrypoint for DOM-based hosts and the OpenTUI entrypoint for terminal renderers. The React and Solid entrypoints build on the OpenTUI adapter.

Entry points:

- `@opentui/keymap`: core keymap API
- `@opentui/keymap/addons`: universal addons
- `@opentui/keymap/addons/opentui`: universal addons plus OpenTUI-specific addons
- `@opentui/keymap/html`: core API plus the HTML adapter
- `@opentui/keymap/opentui`: core API plus the OpenTUI adapter
- `@opentui/keymap/react`: React hooks for the OpenTUI adapter
- `@opentui/keymap/solid`: Solid hooks for the OpenTUI adapter

## Installation

```bash
bun install @opentui/keymap
```

## Development

```bash
bun run build
bun run test
bun src/keymap-benchmark.ts
bun run serve:keymap-html
```

- `bun src/keymap-benchmark.ts` runs the benchmark suite from `src/keymap-benchmark.ts`.
- `bun run serve:keymap-html` builds the package and serves the HTML demo locally.
