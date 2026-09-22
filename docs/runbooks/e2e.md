# E2E

When the browser suite goes red in CI, when it goes green on a page that is broken, and before
either of those — when deciding whether the stage is worth its minutes at all.

Read [Start with the crawler smoke](#start-with-the-crawler-smoke) first. It is the cheapest
check in this document and it catches the failure that costs the most, and it needs neither this
stage nor a browser.

## What the stage does

`e2e` is a stage of `ci`, between `build` and `db`:

```
pre -> build -> test -> e2e -> db -> push
```

In one run it:

1. starts the image `build` just produced as a service — the production image, not `next dev`;
2. starts every service declared in `e2e.services` beside it, each one at the tag the repository
   pins;
3. waits until every `ready:` path answers, the app's and each service's, before a single test
   runs;
4. runs the project's own suite in the pinned browser image, with `E2E_BASE_URL` pointing at the
   app under test;
5. records the command it ran and how many tests that run found, in the stage's report entry.

It is a gate, so it fails closed: a non-zero exit from the suite fails the stage, fails the job,
and the `Deploy` job — which needs `e2e` as well as `image` — never starts. A browser suite that
reports *after* the release is a report, not a gate: by the time it goes red, the version it
disagrees with is the one serving.

What it is not: it does not run against production, it does not run against a preview URL, and it
does not run `next dev`. It drives the artefact that would be deployed. A spec that passes
against a development server and fails against the image is the stage doing its job — the two
differ in bundling, minification, caching headers, error handling and timing.

### With no `e2e:` block

The stage skips, and says so:

```
| stage | status  | detail         |
|-------|---------|----------------|
| e2e   | skipped | not configured |
```

Skipped, never "ok". A gate nobody can see in the report has stopped being a gate (ADR 0004), and
the same applies to a gate that was never configured: the run says out loud that this project has
no browser coverage rather than leaving a green row that suggests it does. The `E2E` job in
`templates/github/ci.yml` still costs a runner and about a minute to produce that line. Keep the
job while the suite is coming; delete it — and the `e2e` entry from `needs:` on `deploy` and
`summary` — if the project is not going to have one.

## Configuring it

One block in `shipkit.yaml`. Absent, the stage skips; present, every key below is read by the
module, and anything it cannot make sense of is a configuration error (exit 2) before a container
starts.

```yaml
e2e:
  # The suite, exactly as it will be run inside the browser image. `npx --no-install` for the
  # same reason the lint and test stages use it: plain `npx` downloads whatever the registry
  # publishes under that name when the project does not depend on it, and a gate that installs
  # its own test runner is not running the project's.
  #
  # This string is copied into the report verbatim, so what a red run says it ran is what ran.
  command: npx --no-install playwright test

  # The browsers. Pinned by hand, and it must match the project's own @playwright/test version:
  # the library and the browser binaries ship together, and a mismatch fails every spec with
  # "Executable doesn't exist" rather than with anything about the site. A digest is better than
  # a tag and is what to use once the pair is known good.
  image: mcr.microsoft.com/playwright:v1.56.0-noble@sha256:<digest>

  # The port the built image listens on, and a path that answers only when the app is actually
  # up. The stage waits for it before the suite starts; without the wait the first spec races
  # the server's cold start and the suite fails somewhere that has nothing to do with the code.
  port: 3000
  ready: /api/health

  # How long, in seconds, the whole suite may take before the stage gives up on it. A hung
  # browser otherwise holds the runner until GitHub kills the job, which produces no report.
  timeout: 300

  # Extra variables for the suite. E2E_BASE_URL is set by the kit and must not be set here.
  env:
    E2E_LOCALE: uk

  # Everything the app needs at run time that is not the app. See below.
  services:
    - name: api
      image: ghcr.io/org/repo:sha-0f2c1ab9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9
      port: 8080
      ready: /health
      env:
        ASPNETCORE_ENVIRONMENT: e2e
      initSql: ci/e2e-seed.sql
```

| Key | What it decides |
|---|---|
| `command` | the suite; carried into the report verbatim |
| `image` | the browsers; pin it to the project's Playwright version |
| `port` | where the app under test listens, inside the engine's network |
| `ready` | what must answer before any spec runs |
| `timeout` | seconds for the whole suite; a hung browser fails rather than hangs |
| `env` | variables for the suite. `E2E_BASE_URL` is the kit's, not yours |
| `services` | the containers the app talks to, each pinned, each waited for |

**The base URL is `E2E_BASE_URL`.** The kit sets it to the app under test; the suite reads it. It
carries no `SHIPKIT_` prefix on purpose — the variable is read by the project's own configuration,
not by the kit. A suite that reads something else changes one line in its own config:

```ts
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
```

A Playwright project that starts its own development server with `webServer` needs
`reuseExistingServer: true` and nothing more: with `E2E_BASE_URL` pointing at an origin that is
already answering, Playwright starts nothing and drives the image.

## Services, and why their tags are pinned by hand

`e2e.services` is how the stage learns about everything the app needs and does not contain: an
API, a database, a cache, a stub for a third party. The kit does not build them — it pulls them,
starts them, binds each one under `name` so the app reaches it at `http://<name>:<port>`, and
waits for its `ready` path.

Every image needs an explicit tag, and a digest is better. A floating tag — `latest`, `main`,
`edge` — is refused when the configuration loads, which is the point in the run where "one commit
means one image" is still true and cheap to keep:

- a red run could not be told from a tag that moved overnight, and that is the debugging session
  that eats an afternoon;
- a green run would prove nothing about the next one, because nothing says the bytes will be the
  same;
- a rerun of an old commit, which is how anyone investigates a regression, would no longer
  reproduce that commit.

Pinning by hand also means that moving a dependency is a commit in the repository: reviewed, dated
and blamable. When e2e starts failing on a morning nobody touched the site, `git log -- shipkit.yaml`
is the first thing to read, and it only has an answer if the tag lives in the file.

The cost is real: a pinned service image goes stale, and somebody has to move it. That is the
trade being made — a chore on a schedule instead of a failure at random.

### The routes that need a service you do not have

The consumer this stage was built for is a Next.js site whose specs walk 32 routes in two
viewports. Some of those routes read a .NET API that is not in CI, so without it they answer 500,
and a sweep that only checks "the page loaded" turns that into a red run with no information.

There are exactly two honest answers, and "let them 500" is not one of them:

1. **Declare the API as a service** with a pinned tag and an `initSql` that gives it data. The
   sweep then covers the routes that matter most, because the routes that read data are the ones
   that break.
2. **Keep those routes out of the CI suite** — a Playwright project, a tag, a grep — and say in
   the suite where they went and why. The sweep is then smaller and honest about it.

Deciding not to cover a route is a decision; discovering after three months that it has been
failing quietly is not.

## Why an empty database makes a green test on a broken page

A service database that starts empty answers every query correctly and returns nothing. The page
that lists vehicles renders its empty state. It returns 200, it has a title, it logs no console
error, it does not scroll sideways — every assertion a whole-site sweep makes is satisfied by a
page that shows the user nothing at all. The one page that would have caught the bug is the one
that renders a row, and no row exists.

So a service that holds data gets `initSql:` — a path in the repository, fed to the service when
it starts:

```yaml
    initSql: ci/e2e-seed.sql
```

Two rules follow from this, and both are about the specs rather than the SQL:

- **The seed covers the shapes the specs assert.** One vehicle, one booking, one article, one of
  whatever the listing lists — with the fields the page actually renders. It does not need to be
  a lot of rows; it needs to be a row that is not empty.
- **The specs assert a row, not a page.** `await expect(list).toBeVisible()` passes on an empty
  list. `expect(await cards.count()).toBeGreaterThan(0)` and an assertion on what the first card
  says do not.

This is the same trap the `db` stage keeps `ci/seed.sql` for: there it is what proves a migration
did not eat rows, here it is what proves the page renders one. Both exist because the failure mode
of an empty database is a pass.

## Running the same suite locally, against the same image

The whole stage, in one command, exactly as CI runs it — Docker and Dagger required:

```sh
shipkit ci --stage=e2e
```

It builds the image from the working tree, starts the services, waits, runs the suite. This is
what to run before pushing a change to the `e2e:` block, because a mistake there is a
configuration error found in ten seconds locally or in five minutes on a runner.

For iterating on specs, do not pay for the whole stage each time. Serve the image and point the
suite at it:

```sh
# one shell: the production image, on localhost:3000
dagger call image --source=. --sha=$(git rev-parse HEAD) as-service up --ports=3000:3000

# another: the project's own suite, against that
E2E_BASE_URL=http://localhost:3000 npx --no-install playwright test e2e/smoke.spec.ts
```

`dagger call image` is the same code path `build` uses, label included, so what is answering on
3000 is the image that would be deployed rather than a lookalike. If a service is needed beside
it, bring it up the way the block declares it and give the app the same variables — at that point
`shipkit ci --stage=e2e` is usually the cheaper thing to run.

**`npm run e2e` against `next dev` is a different test.** It is the right loop for writing a spec
and the wrong one for believing its result: the development server compiles per request, ships no
production bundle, and handles errors differently. A spec that is green there and red in `e2e` is
not flaky by default — the image is the thing that ships.

## Reading a failure

What the run gives you: the `E2E` job's log, and `reports/e2e.json` uploaded as the `report-e2e`
artefact even when the job failed. The CI summary renders the same report as one row. Start with
the report — it names the command, the exit code and the tail of the output, which is the shape of
every stage failure in this kit.

| What the report says | What happened | What to do |
|---|---|---|
| `skipped`, reason `not configured` | there is no `e2e:` block | configure it, or delete the job |
| `failed`, exit 1, output full of spec names | the suite ran and refused: this is the gate doing its job | read the failing spec; reproduce with `E2E_BASE_URL` against the image, not against `next dev` |
| `failed`, exit 2 | configuration: a key the module cannot read, a floating tag, a `timeout` out of range | fix `shipkit.yaml`; nothing was started |
| `failed`, exit 3, nothing about specs | infrastructure: the app or a service never answered its `ready` path | check `port:` against what the image listens on, and whether the app can start at all without a variable it only has in production |
| `failed`, every route 500 | a service the app needs is missing or empty | declare it, or seed it (`initSql`), or take those routes out of the suite on the record |
| `ok`, 0 tests found | the suite discovered nothing | wrong `testDir` relative to the repository root, or a filter in `command` that matches no file. A green stage that ran no test is the worst possible green |

Two things not to do:

- **Do not rerun until green.** A suite that passes on the second run has told you something
  about the site or about itself, and rerunning throws that away. A gate that gets rerun until it
  passes is not a gate (ADR 0004).
- **Do not disable the suite to unblock a release.** Quarantine the one spec, by name, in the
  repository, with the reason and the date in the same commit. A quarantine list that grows is a
  signal about the specs; an empty `e2e:` block is a signal about nothing.

## Start with the crawler smoke

Before any of the above — and afterwards, permanently — the project's own test suite should carry
a crawler smoke. It is the cheapest check here and it catches the most expensive class of failure.

**What it is.** A handful of routes, requested with **no cookies** and a **Googlebot user agent**,
expecting a 200 and a non-empty `<title>`. That is all.

**Why it belongs in the unit tests.** It needs no browser, no image and no API. It goes in the
project's own `vitest` suite, which the `test` stage already runs on every push and every pull
request — seconds, before the image is even built, and on a commit that has not reached `build`.
The browser suite costs minutes and runs after it; this costs nothing and runs first.

**The class of bug it catches.** Everything a developer does is authenticated and warm: a session
cookie, a locale cookie, a consent cookie, a browser that has been on the site all day. A crawler
has none of them. A middleware that guesses a locale from a cookie and loops when there is none, an
auth wrapper that answers 302 to an anonymous request, a page that throws when a personalisation
cookie is absent — all of them are invisible to every human path through the site and fatal to the
only path a search engine takes. The consumer lost three pages out of the search index to exactly
this, and nobody noticed until the pages were gone, because every browser anyone tried them in had
cookies.

**The shape.** Put the request through the app's own pipeline — middleware first, then the route —
and assert the two things a crawler asserts:

```ts
// crawler-smoke.test.ts — runs in the `test` stage, no browser, no API
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

// The routes a search engine must be able to reach. Not every route: the ones whose
// disappearance from the index would be noticed.
const PUBLIC_ROUTES = ["/uk", "/uk/fleet", "/uk/faq", "/uk/blog"]

for (const route of PUBLIC_ROUTES) {
  test(`${route} answers a crawler with no cookies`, async () => {
    const response = await get(route, { "user-agent": GOOGLEBOT })   // no cookie header at all

    expect(response.status).toBe(200)          // not 302, not 500, and not a redirect loop
    expect(title(response)).not.toBe("")       // a page with no title is a page with no listing
  })
}
```

`get` is the project's own seam: a `fetch` when the suite can reach a server it started, otherwise
the app's request pipeline called directly — in Next, `middleware(new NextRequest(url, { headers }))`
followed by the route's handler or `generateMetadata()`. Which one a project uses is its business;
what matters is that the request carries no cookies, carries the crawler's user agent, and that
both assertions are made.

**Keep it after the browser suite exists.** The two are not the same check and the cheap one is
not a stepping stone to the expensive one:

| | crawler smoke | `e2e` |
|---|---|---|
| runs in | `test`, every push | `e2e`, after the image is built |
| costs | seconds | minutes, plus a runner |
| needs | nothing | the image, browsers, services, data |
| asserts | what a crawler sees | what a visitor sees |

The browser suite will never assert the absence of a cookie — it drives a real browser, which
keeps the ones the site sets. That is precisely the case the smoke covers, and it is the case that
cost the pages.

## See also

- `docs/runbooks/deploy.md` — the job that waits for this stage before it releases
- `docs/runbooks/registry.md` — credentials, when a service image is private
- `docs/adr/0004-automated-gates-replace-qa.md` — why a gate that does not stop anything is not a
  gate
- `docs/multi-stack-plan.md` §6 — Next.js specifically, including why this stage exists at all
  after the plan said it would not
