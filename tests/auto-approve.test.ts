import { test } from "node:test"
import assert from "node:assert/strict"
import { approvalFacts, autoApproveRefusal } from "../.dagger/src/core/auto-approve.ts"
import type { DeployPlan } from "../.dagger/src/core/plan-token.ts"

/**
 * The plan a merge to main produces on a normal Tuesday: an image ci published, a server that
 * already runs the previous release, one additive migration.
 *
 * Every case below is this plan with exactly one fact changed, so what a test proves is the
 * effect of that fact and nothing else.
 */
const safe: DeployPlan = {
  env: "prod",
  url: "https://api.client.com",
  imageTag: "sha-a1b2c3d",
  currentImageTag: "sha-9f8e7d6",
  servingVersion: "9f8e7d6",
  provision: [],
  migrations: ["20260911_AddOrdersIndex"],
  sqlDigest: "abc123",
  sqlPreview: "12 lines",
  destructive: false,
  allowLoss: [],
  imageDigest: "sha256:" + "a".repeat(64),
  lastVerifiedBackup: "2026-09-10T03:00:00Z",
  stages: null,
  token: "0123456789ab",
}

const plan = (over: Partial<DeployPlan>): DeployPlan => ({ ...safe, ...over })

const table: { name: string; plan: DeployPlan; refused: RegExp | null }[] = [
  { name: "safe", plan: safe, refused: null },
  {
    name: "no migrations at all",
    plan: plan({ migrations: [], sqlPreview: "no schema change" }),
    refused: null,
  },
  {
    name: "destructive",
    plan: plan({ destructive: true }),
    refused: /destructive SQL/,
  },
  {
    name: "allow-loss",
    // Not destructive: the marker waived the gate, so `destructive` can be false and the
    // migration still throws a column away. The marker is its own reason to stop.
    plan: plan({ allowLoss: ["orders.CreatedAt"] }),
    refused: /waive data loss for orders\.CreatedAt/,
  },
  {
    name: "provisioning",
    plan: plan({ provision: ["boot the database accessory (first deploy to this server)"] }),
    refused: /change the server first/,
  },
  {
    name: "first deploy",
    plan: plan({ currentImageTag: null, servingVersion: null }),
    refused: /nothing to roll back to/,
  },
  {
    name: "image not published",
    plan: plan({ imageDigest: null }),
    refused: /no image is published for sha-a1b2c3d/,
  },
  {
    name: "part of the deploy selected",
    plan: plan({ stages: ["backup", "migrate"] }),
    refused: /only part of the deploy is selected \(backup, migrate\)/,
  },
]

for (const row of table) {
  test(`policy: ${row.name}`, () => {
    const refusal = autoApproveRefusal(row.plan)
    if (row.refused === null) {
      assert.equal(refusal, null, `expected ${row.name} to self-approve, refused: ${refusal}`)
    } else {
      assert.ok(refusal !== null, `expected ${row.name} to be refused`)
      assert.match(refusal, row.refused)
    }
  })
}

test("every reason to stop is reported, not just the first", () => {
  // A run that stops costs a round trip either way. Finding out one refusal at a time costs
  // one each.
  const refusal = autoApproveRefusal(
    plan({ destructive: true, imageDigest: null, provision: ["start kamal-proxy"] }),
  )
  assert.match(refusal!, /destructive SQL/)
  assert.match(refusal!, /start kamal-proxy/)
  assert.match(refusal!, /no image is published/)
})

test("a plan is approved by the absence of reasons, never by a missing fact", () => {
  // Anything the policy cannot read is a stop. A plan whose image could not be confirmed and
  // whose server state is unknown must not slip through as "nothing objected".
  assert.notEqual(autoApproveRefusal(plan({ imageDigest: null, currentImageTag: null })), null)
})

test("the report records the facts the decision was made on", () => {
  const facts = approvalFacts(safe)
  assert.deepEqual(facts, {
    destructiveSql: false,
    allowLoss: [],
    provision: [],
    migrations: ["20260911_AddOrdersIndex"],
    imageDigest: safe.imageDigest,
    previousVersion: "sha-9f8e7d6",
    stages: "all",
  })
})

test("the recorded facts name the stages when only some were selected", () => {
  assert.deepEqual(approvalFacts(plan({ stages: ["backup", "migrate"] })).stages, ["backup", "migrate"])
})
