/**
 * Whether a deploy is allowed to approve itself.
 *
 * `deploy` normally refuses to touch production without a plan token — a hash of a plan a
 * person looked at (ADR 0009). That is the right default and a bad fit for the one case where
 * nobody is looking: a merge to the default branch, at 2am, of a change that does nothing a
 * human would have anything to say about.
 *
 * So this is the second half of the confirmation contract: the rule that says which plans are
 * boring enough to run unattended. Everything else still stops with EXIT.CONFIRM and prints
 * its token, exactly as before — self-approval widens who may say yes, never what yes means.
 *
 * Pure, and free of runtime imports, so the rule that decides whether production is changed
 * without a human can be tested over a table of plans rather than against a server. Turning a
 * refusal into a ShipkitError is the caller's job, for the same reason.
 *
 * Every rule here is a reason to STOP. A plan is approved only by the absence of all of them:
 * a fact the policy cannot read is never a fact in favour.
 */

import type { DeployPlan } from "./plan-token.js"

/**
 * Why this plan may not run unattended, or null when it may.
 *
 * Every reason that applies is reported, not just the first: a run that stops for a human is
 * about to cost a round trip anyway, and "it is also a first deploy" is exactly the kind of
 * thing that is discovered one refusal at a time otherwise.
 */
export function autoApproveRefusal(plan: DeployPlan): string | null {
  const reasons: string[] = []

  // The agreed policy, in its own order.
  if (plan.destructive) {
    reasons.push("the pending migrations contain destructive SQL")
  }
  // A marker is a person writing down that losing this is fine. It is consent to the loss,
  // not consent to nobody watching it happen (D6).
  if (plan.allowLoss.length > 0) {
    reasons.push(`the migrations waive data loss for ${plan.allowLoss.join(", ")}`)
  }
  if (plan.provision.length > 0) {
    reasons.push(`the deploy would change the server first: ${plan.provision.join("; ")}`)
  }
  // Not "the image might be missing": the registry was asked when the plan was built and
  // nothing answered for this tag. Either ci has not published this commit or it published
  // something else, and both are a person's problem.
  if (plan.imageDigest === null) {
    reasons.push(`no image is published for ${plan.imageTag}`)
  }

  // Beyond the agreed list, and for the same reason the list exists — these are plans whose
  // failure has no automatic way back.
  //
  // Nothing has ever run on this server, so `verify` failing has no previous version to put
  // in front of traffic. An unattended deploy that cannot roll back leaves production down
  // until someone notices.
  if (plan.currentImageTag === null) {
    reasons.push("nothing is deployed on this server yet, so a failed verify has nothing to roll back to")
  }
  // A stage selection is a person deciding to run part of the pipeline. Self-approval runs the
  // whole thing or it does not run: the gates are only a chain while all of them are in it.
  if (plan.stages) {
    reasons.push(`only part of the deploy is selected (${plan.stages.join(", ")})`)
  }

  return reasons.length === 0 ? null : reasons.join("; ")
}

/**
 * What the decision was made on, for the report.
 *
 * Recorded so the run proves it was allowed rather than asserting it was: "self-approved" on
 * its own is a claim, and the day it is wrong is the day someone needs to read which facts it
 * was wrong about.
 */
export interface ApprovalFacts {
  destructiveSql: boolean
  allowLoss: string[]
  provision: string[]
  migrations: string[]
  imageDigest: string | null
  previousVersion: string | null
  stages: string[] | "all"
}

export function approvalFacts(plan: DeployPlan): ApprovalFacts {
  return {
    destructiveSql: plan.destructive,
    allowLoss: plan.allowLoss,
    provision: plan.provision,
    migrations: plan.migrations,
    imageDigest: plan.imageDigest,
    previousVersion: plan.currentImageTag,
    stages: plan.stages ?? "all",
  }
}
