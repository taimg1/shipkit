import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  /**
   * Ships the server as `.next/standalone`: server.js next to only the packages it imports.
   * It is what makes the runtime stage of the Dockerfile possible at all — no npm install,
   * no sources, and roughly a gigabyte less image.
   */
  output: "standalone",

  /**
   * The commit, inlined at BUILD time. Next reads server env at runtime, and nothing sets
   * GIT_SHA in the container — so without this the /health version would be empty in exactly
   * the place `verify` looks at it.
   */
  env: { GIT_SHA: process.env.GIT_SHA ?? "dev" },

  /** Nothing to gain from telling every visitor which framework serves them. */
  poweredByHeader: false,
}

export default nextConfig
