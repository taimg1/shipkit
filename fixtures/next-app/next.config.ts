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
  env: {
    GIT_SHA: process.env.GIT_SHA ?? "dev",
    // The same mechanism a real Next project needs for NEXT_PUBLIC_*: a value that exists
    // only while the image is built. The fixture reports it back so that a build which lost
    // it fails a test instead of being noticed in a browser.
    NEXT_PUBLIC_FIXTURE_LABEL: process.env.NEXT_PUBLIC_FIXTURE_LABEL ?? "",
  },

  /** Nothing to gain from telling every visitor which framework serves them. */
  poweredByHeader: false,
}

export default nextConfig
