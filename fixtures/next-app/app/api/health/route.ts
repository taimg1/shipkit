import { NextResponse } from "next/server"

import { healthPayload } from "@/lib/health"

/**
 * The endpoint `verify` reads after every release: 200 with the commit that is serving.
 *
 * `force-dynamic` because a prerendered route handler is evaluated once, at build time, and
 * this one exists to describe the running container.
 *
 * `process.env.GIT_SHA` is not read at runtime — next.config inlines it during the build, from
 * the GIT_SHA build argument the kit passes.
 */
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json(healthPayload(process.env.GIT_SHA))
}
