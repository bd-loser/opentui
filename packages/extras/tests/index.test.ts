import { describe, expect, it } from "bun:test"
import { testExtrasSetup } from "../src/index.js"

describe("@opentui/extras", () => {
  it("exports the setup test function", () => {
    expect(testExtrasSetup()).toBe("extras-ready")
  })
})
