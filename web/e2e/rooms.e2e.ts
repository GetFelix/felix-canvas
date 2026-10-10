import { expect, test, type Page } from "@playwright/test";

import { leaveAll, open, openAt } from "./helpers.js";

test.afterEach(leaveAll);

/** Whether the dev stack's snapshotter folds `room`; `null` against an install, which hides it. */
async function folds(room: string): Promise<boolean | null> {
  if (process.env.CANVAS_E2E_URL) return null;
  const positions = (await (await fetch("http://127.0.0.1:8788/")).json()) as object;
  return room in positions;
}

/** The room a page is in, from its address. */
const roomOf = (page: Page) => new URL(page.url()).searchParams.get("room");

async function joined(page: Page): Promise<void> {
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("alertdialog")).toBeHidden();
}

test("someone makes a room, invites a second person, and takes them out again", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const title = `Team sketch ${Date.now() % 100_000}`;

  // Ana makes a room from the rooms list under the room name.
  const ana = await open(browser, { user: "ana" });
  await joined(ana);
  await ana.locator("#rooms-button").click();
  const list = ana.getByRole("dialog", { name: "Your rooms" });
  await expect(list).toBeVisible();
  await list.getByRole("textbox", { name: "Room name" }).fill(title);
  await list.getByRole("button", { name: "Create" }).click();
  await ana.waitForURL((url) => url.searchParams.get("room")?.startsWith("r") ?? false);
  const room = roomOf(ana)!;
  await joined(ana);
  await expect(ana.locator("#room")).toHaveText(title);
  // The snapshotter starts folding the new room without a restart.
  await expect.poll(() => folds(room), { timeout: 15_000 }).not.toBe(false);

  // Ben cannot open it before he is invited.
  const stranger = await open(browser, { user: "ben", room });
  await expect(stranger.getByRole("alertdialog")).toBeVisible({ timeout: 30_000 });
  await expect(stranger.getByRole("alertdialog").getByRole("heading")).toHaveText(
    "You don't have access to this canvas",
  );

  // Ana shares an invite link.
  await ana.locator("#share").click();
  const share = ana.getByRole("dialog", { name: "Share this room" });
  await expect(share).toBeVisible();
  await share.getByRole("button", { name: "Create invite link" }).click();
  const address = share.getByRole("textbox", { name: "Invite link" });
  await expect(address).toHaveCount(1);
  const link = new URL(await address.inputValue());
  const token = link.searchParams.get("invite")!;
  expect(token).toBeTruthy();

  // Ben opens it, signs in, and joins.
  const ben = await openAt(browser, `/?invite=${token}`, { user: "ben" });
  const card = ben.getByRole("dialog", { name: `Join “${title}”` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Ana invited you");
  await expect(card).toContainText("Signed in as Ben");
  await card.getByRole("button", { name: "Join room" }).click();
  await ben.waitForURL((url) => url.searchParams.get("room") === room);
  await joined(ben);
  await expect(ben.locator("#room")).toHaveText(title);

  // Both see each other, and the room is in Ben's list as shared with him.
  await expect(ana.locator("#avatars .avatar")).toHaveCount(2, { timeout: 15_000 });
  await ben.locator("#rooms-button").click();
  await expect(ben.getByRole("dialog", { name: "Your rooms" })).toContainText(title);
  await expect(ben.getByRole("dialog", { name: "Your rooms" })).toContainText("Shared with you");
  await ben.keyboard.press("Escape");

  // Ben is a member, not the owner: no invites and no removing people.
  await ben.locator("#share").click();
  const benShare = ben.getByRole("dialog", { name: "Share this room" });
  await expect(benShare.getByRole("button", { name: "Leave room" })).toBeVisible();
  await expect(benShare.getByRole("button", { name: "Create invite link" })).toBeHidden();
  await expect(benShare.getByRole("button", { name: /^Remove/ })).toHaveCount(0);

  // Ana takes Ben out and revokes the link.
  await ana.locator("#share").click();
  await ana.locator("#share").click();
  await expect(share.getByRole("listitem").filter({ hasText: "Ben" })).toBeVisible();
  await share.getByRole("button", { name: "Remove Ben" }).click();
  await expect(share.getByRole("listitem").filter({ hasText: "Ben" })).toHaveCount(0);
  await share.getByRole("button", { name: "Revoke invite link" }).click();
  await expect(share.getByRole("textbox", { name: "Invite link" })).toHaveCount(0);

  // Ben can no longer open the room, nor use the old link to get back in.
  await ben.reload();
  await expect(ben.getByRole("alertdialog")).toBeVisible({ timeout: 30_000 });
  await expect(ben.getByRole("alertdialog").getByRole("heading")).toHaveText(
    "You don't have access to this canvas",
  );
  await ben.goto(`/?invite=${token}`);
  await expect(ben.getByRole("dialog", { name: "This invite link no longer works" })).toBeVisible({
    timeout: 30_000,
  });

  // Ana deletes the room and lands in the lobby, where it is no longer listed.
  await share.getByRole("button", { name: "Delete room" }).click();
  const confirm = ana.getByRole("dialog", { name: "Delete this room?" });
  await confirm.getByRole("button", { name: "Delete room" }).click();
  await ana.waitForURL((url) => url.searchParams.get("room") === "lobby");
  await joined(ana);
  await ana.locator("#rooms-button").click();
  await expect(ana.getByRole("dialog", { name: "Your rooms" })).not.toContainText(title);
  await expect.poll(() => folds(room), { timeout: 15_000 }).not.toBe(true);
});
