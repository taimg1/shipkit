import { describe, expect, it } from "vitest"

import { healthPayload } from "./health"

describe("healthPayload", () => {
  it("reports the commit the image was built from", () => {
    expect(healthPayload("a1b2c3d4e5f6", "shipkit-fixture")).toEqual({
      status: "ok",
      version: "a1b2c3d4e5f6",
      label: "shipkit-fixture",
    })
  })

  it("echoes the build argument, which only exists while the image is built", () => {
    expect(healthPayload("a1b2c3d4e5f6", "shipkit-fixture").label).toBe("shipkit-fixture")
    expect(healthPayload("a1b2c3d4e5f6").label).toBe("")
  })

  it("reports dev when no commit was baked in, so verify fails rather than matches", () => {
    expect(healthPayload(undefined).version).toBe("dev")
    expect(healthPayload("").version).toBe("dev")
  })
})
