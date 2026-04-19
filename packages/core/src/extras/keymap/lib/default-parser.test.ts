import { describe, expect, test } from "bun:test"
import { parseKeySequenceLike } from "./default-parser.js"
import { stringifyKeySequence, stringifyKeyStroke } from "./utils.js"

describe("default keymap parser", () => {
  test("captures display for parsed sequences and stringifies tokens on demand", () => {
    const sequence = parseKeySequenceLike(
      "<leader>dd",
      new Map([
        [
          "<leader>",
          {
            stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
            matchKey: "x:1:0:0:0:0",
          },
        ],
      ]),
    )

    expect(sequence).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
        matchKey: "x:1:0:0:0:0",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
    ])
    expect(stringifyKeySequence(sequence)).toBe("ctrl+xdd")
    expect(stringifyKeySequence(sequence, { preferDisplay: true })).toBe("<leader>dd")
    expect(stringifyKeyStroke(sequence[0]!)).toBe("ctrl+x")
    expect(stringifyKeyStroke(sequence[0]!, { preferDisplay: true })).toBe("<leader>")
  })

  test("preserves non-token display strings when explicitly requested", () => {
    const sequence = parseKeySequenceLike("return")

    expect(sequence).toEqual([
      {
        stroke: { name: "return", ctrl: false, shift: false, meta: false, super: false },
        display: "return",
        matchKey: "return:0:0:0:0:0",
      },
    ])
    expect(stringifyKeySequence(sequence)).toBe("enter")
    expect(stringifyKeySequence(sequence, { preferDisplay: true })).toBe("return")
  })

  test("parses special and modifier keys and rejects invalid key sequences", () => {
    const leaderToken = new Map([
      [
        "<leader>",
        {
          stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
          matchKey: "x:1:0:0:0:0",
        },
      ],
    ])

    expect(parseKeySequenceLike("+")).toEqual([
      {
        stroke: { name: "+", ctrl: false, shift: false, meta: false, super: false },
        display: "+",
        matchKey: "+:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike(" ")).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
        matchKey: "space:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike({ name: " " })).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
        matchKey: "space:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike("ctrl+shift+alt+super+x")).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: true, meta: true, super: true },
        display: "ctrl+shift+meta+super+x",
        matchKey: "x:1:1:1:1:0",
      },
    ])
    expect(stringifyKeyStroke(parseKeySequenceLike("meta+super+x")[0]!)).toBe("meta+super+x")
    expect(parseKeySequenceLike("ctrl+hyper+x")).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false, hyper: true },
        display: "ctrl+hyper+x",
        matchKey: "x:1:0:0:0:1",
      },
    ])
    expect(stringifyKeyStroke(parseKeySequenceLike("hyper+x")[0]!)).toBe("hyper+x")
    expect(parseKeySequenceLike("zz")).toEqual([
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
        matchKey: "z:0:0:0:0:0",
      },
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
        matchKey: "z:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike("   ")).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
        matchKey: "space:0:0:0:0:0",
      },
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
        matchKey: "space:0:0:0:0:0",
      },
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
        matchKey: "space:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike("<leader>")).toEqual([])
    expect(parseKeySequenceLike("g<leader>d")).toEqual([
      {
        stroke: { name: "g", ctrl: false, shift: false, meta: false, super: false },
        display: "g",
        matchKey: "g:0:0:0:0:0",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike("<leader>zz")).toEqual([
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
        matchKey: "z:0:0:0:0:0",
      },
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
        matchKey: "z:0:0:0:0:0",
      },
    ])
    expect(parseKeySequenceLike("<leader>", leaderToken)).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
        matchKey: "x:1:0:0:0:0",
      },
    ])

    expect(() => parseKeySequenceLike("")).toThrow("Invalid key sequence: sequence cannot be empty")
    expect(() => parseKeySequenceLike("<leader")).toThrow('Invalid key sequence "<leader": unterminated token')
    expect(() => parseKeySequenceLike("ctrl+shift")).toThrow('Invalid key "ctrl+shift": missing key name')
    expect(() => parseKeySequenceLike("ctrl+a+b")).toThrow(
      'Invalid key "ctrl+a+b": multiple key names are not supported',
    )
    expect(() => parseKeySequenceLike({ name: "   " } as any)).toThrow("Invalid key name: key name cannot be empty")
  })
})
