import { expect, test } from "@playwright/test"

test("dashboard renders and supports core interactions", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByText("MRIQC Aggregator")).toBeVisible()
  await expect(page.getByRole("button", { name: /deduplicated/i })).toBeVisible()
  await expect(page.getByText("Probability Distribution").first()).toBeVisible()

  await page.getByPlaceholder("Search measures...").fill("snr")
  await expect(page.getByText(/signal-to-noise ratio/i).first()).toBeVisible()

  await page.getByRole("button", { name: /select all/i }).click()
  await expect(page.getByText(/bold · 12 selected metrics/i)).toBeVisible()

  const cards = page.locator("section").filter({ has: page.getByText("Probability Distribution") })
  await expect(cards).toHaveCount(12)

  await page.getByRole("button", { name: /collapse all/i }).click()

  const tooltipButton = page.locator('button[aria-label^="About "]').first()
  await tooltipButton.hover()
  await expect(page.locator('[data-slot="tooltip-content"]').first()).toBeVisible()
})
