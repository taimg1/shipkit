# next-app — the second fixture project

A minimal Next.js 16 site on Node 22. It exists so the kit has a real second stack to run
against: the `next` adapter is developed and tested here before it touches a client repo, and
the kit's own CI lints, tests and builds it on every push (`.github/workflows/ci.yml`).

It is as small as it can be while still proving the adapter:

```
app/api/health      the endpoint verify reads — {"status":"ok","version":"<sha>"}
app/                a root layout and one page, so `next build` has something to render
lib/health.ts       the one rule worth a test, and lib/health.test.ts is that test
next.config.ts      output: standalone, and GIT_SHA inlined at build time
eslint.config.mjs   the project's linter — `lint: eslint` in shipkit.yaml names it
Dockerfile          multi-stage; the commit arrives as the GIT_SHA build argument
shipkit.yaml        what the kit reads: stack next, db none, publish false
```

## What it proves

- **`db: none` is a real path.** No database is started for the test stage, and the db, backup
  and migrate stages are skipped explicitly rather than silently (ADR 0004).
- **A green run that tested nothing is still a failure.** `vitest` exits 0 when a test file
  contains no test at all — it prints `Tests  no tests`. The adapter reads vitest's counts and
  the core refuses a run whose total is zero.
- **The commit survives the build.** Next reads server environment variables at runtime, and
  nothing sets `GIT_SHA` in the container; `env` in next.config is what carries the build
  argument into the bundle, and `/api/health` reports it.

## Running it

```bash
npm ci
npm run lint && npm run typecheck && npm test

# the pipeline's view of the same thing
node ../../bin/shipkit ci --stage=pre
node ../../bin/shipkit ci --stage=test
```
