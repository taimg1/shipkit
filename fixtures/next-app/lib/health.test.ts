import { describe, expect, it } from "vitest"

import { healthPayload } from "./health"

describe("healthPayload", () => {
  it("reports the commit the image was built from", () => {
    expect(healthPayload("a1b2c3d4e5f6")).toEqual({ status: "ok", version: "a1b2c3d4e5f6" })
  })

  it("reports dev when no commit was baked in, so verify fails rather than matches", () => {
    expect(healthPayload(undefined).version).toBe("dev")
    expect(healthPayload("").version).toBe("dev")
  })
})
