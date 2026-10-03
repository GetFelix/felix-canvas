import { expect, test } from "@playwright/test";

import { leaveAll, open } from "./helpers.js";

test.afterEach(leaveAll);

test("someone who is not a member is shown that they cannot open the room", async ({ browser }) => {
  const page = await open(browser, { user: "ben", room: "studio" });
  const card = page.getByRole("alertdialog");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading")).toHaveText("You don't have access to this canvas");
  await expect(card).toContainText("Signed in as ben");
  await expect(page.locator("#toolbar")).toBeHidden();
  await expect(page.locator("#joining")).toBeHidden();

  await card.getByRole("link", { name: "Go to the lobby" }).click();
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#room")).toHaveText("lobby");
  await expect(page.getByRole("alertdialog")).toBeHidden();
});

test("a member opens the same room", async ({ browser }) => {
  const page = await open(browser, { user: "ana", room: "studio" });
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#room")).toHaveText("studio");
  await expect(page.getByRole("alertdialog")).toBeHidden();
});
