import { expect, test } from "@playwright/test"

test("category counts stay aligned and do not overlap the chevron", async ({ page }) => {
  await page.goto("/")

  const categoryRow = page
    .getByRole("button", {
      name: /Smoothness/i,
    })
    .first()

  await expect(categoryRow).toBeVisible()

  const badge = categoryRow.getByText("4", { exact: true })
  const chevron = categoryRow.locator("svg.lucide-chevron-right")

  await expect(badge).toBeVisible()
  await expect(chevron).toBeVisible()

  const badgeBox = await badge.boundingBox()
  const chevronBox = await chevron.boundingBox()

  expect(badgeBox).not.toBeNull()
  expect(chevronBox).not.toBeNull()
  expect(badgeBox!.x + badgeBox!.width + 4).toBeLessThan(chevronBox!.x)
})

test("dashboard renders and supports core interactions", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByText("MRIQC Aggregator")).toBeVisible()
  await expect(page.getByRole("button", { name: /deduplicated/i })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "AFNI outlier ratio" })
  ).toBeVisible()

  await page.getByPlaceholder("Search measures...").fill("fd")
  await expect(page.getByText("Framewise displacement Mean")).toBeVisible()

  const tooltipButton = page.locator('button[aria-label^="About "]').first()
  await tooltipButton.hover()
  await expect(page.locator('[data-slot="tooltip-content"]').first()).toBeVisible()

  await page.getByPlaceholder("Search measures...").fill("")

  await page.getByRole("button", { name: /select all/i }).click()
  await expect(page.getByText(/bold · 12 selected metrics/i)).toBeVisible()
  await expect(
    page.getByText(/Selected the first 12 metrics for bold\./i)
  ).toBeVisible()

  const cards = page.locator("section").filter({ has: page.getByText("Samples") })
  await expect(cards).toHaveCount(12)

  await page.getByRole("button", { name: /collapse all/i }).click()
  await expect(page.locator('button[aria-label^="About "]').first()).not.toBeVisible()
})
