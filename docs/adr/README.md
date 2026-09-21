# Architecture decision records

One decision per file. Status is `accepted`, `deferred`, `superseded` or `proposed`.
Never edit an accepted ADR to change its decision — write a new one that supersedes it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-three-layer-pipeline.md) | Pipeline logic, trigger and delivery are three separate layers | accepted |
| [0002](0002-dagger-for-pipeline-logic.md) | Dagger (TypeScript SDK) holds the pipeline logic | accepted |
| [0003](0003-squawk-over-atlas.md) | Squawk, not Atlas, lints migrations | accepted |
| [0004](0004-automated-gates-replace-qa.md) | Four fail-closed gates replace the missing QA stage | accepted |
| [0005](0005-migrations-never-at-startup.md) | Migrations are applied by the pipeline, never at app startup | accepted |
| [0006](0006-bare-server-over-paas.md) | Bare server + Kamal, not PaaS | accepted |
| [0007](0007-defer-infrastructure-as-code.md) | OpenTofu is deferred until hosting is chosen | deferred |
| [0008](0008-stack-adapters.md) | Stack-specific logic behind one adapter interface; core never branches on stack | accepted |
| [0009](0009-shipkit-cli-wrapper.md) | A thin `shipkit` CLI wraps `dagger call`; raw Dagger stays reachable | accepted |
