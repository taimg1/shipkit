import { expect, test } from "@playwright/test"

/**
 * The fixture's browser suite — small on purpose, and real: it drives a browser against the
 * image the pipeline just built, at the URL the pipeline chose.
 *
 * The two tests are the two things a unit test cannot say anything about. The home page proves
 * the standalone server actually serves rendered HTML. /orders proves the page reached a
 * service that lives outside the repository and rendered what it found there — the case where
 * a missing dependency produces 200 and an empty page rather than an error.
 */

test("the home page renders", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("main")).toHaveText("shipkit next fixture")
})

test("/orders renders the rows the seed put in the database", async ({ page }) => {
  await page.goto("/orders")
  // By content, not by count alone: an empty list and a list of the wrong things both pass a
  // count check often enough to be worth not writing one.
  await expect(page.getByTestId("order")).toHaveText(["SK-1001", "SK-1002"])
})
