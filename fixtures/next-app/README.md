# next-app — the second fixture project

A minimal Next.js 16 site on Node 22. It exists so the kit has a real second stack to run
against: the `next` adapter is developed and tested here before it touches a client repo, and
the kit's own CI lints, tests and builds it on every push (`.github/workflows/ci.yml`).

It is as small as it can be while still proving the adapter:

```
app/api/health      the endpoint verify reads — {"status":"ok","version":"<sha>"}
app/                a root layout and one page, so `next build` has something to render
app/orders          a page that renders rows from a database the repository does not contain
lib/health.ts       the one rule worth a test, and lib/health.test.ts is that test
lib/orders.ts       the query behind /orders
e2e/site.spec.ts    the browser suite the `e2e` stage runs against the built image
playwright.config.ts  no webServer: the kit serves the image and passes the URL
ci/e2e-seed.sql     the rows /orders is tested against, mounted into the db service
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
- **A browser suite runs against the image, not the sources.** The `e2e` stage starts the
  container `build` produced, starts the database `e2e:` declares, waits for both, and runs
  Playwright against the URL it chose, passed as `E2E_BASE_URL`. `playwright.config.ts` has no
  `webServer` and no fallback base URL, so a run that was not handed one fails rather than
  testing localhost.
- **An empty database is a failing test, not a passing one.** `/orders` renders whatever the
  database holds. With no `sql:` seed it holds nothing, the page answers 200 with an empty
  list, and a test that only checked the status code would go green on a broken page — which
  is why the data is stated in `ci/e2e-seed.sql` and asserted on by content.
- **`db: none` is about migrations, not about run time.** This fixture has no DB adapter and
  no migrations, and it still needs a database while its browser tests run. The two are
  configured separately for that reason.

## Running it

```bash
npm ci
npm run lint && npm run typecheck && npm test

# the pipeline's view of the same thing
node ../../bin/shipkit ci --stage=pre
node ../../bin/shipkit ci --stage=test
# build and e2e together: the stage serves the container build produced, in memory
node ../../bin/shipkit ci --stage=build,e2e
```
