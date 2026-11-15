import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

test("a new space chooses what it can use, and a skill can be limited to some spaces", async ({
  page,
}, testInfo) => {
  await signup(page, `availability-${Date.now()}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });

  await openNewSpace(page);
  const create = page.getByRole("dialog", { name: "New space" });
  await create.getByLabel("Name").fill("Clients");
  await create.getByRole("button", { name: "Create space", exact: true }).click();

  // What the user added reaches every space, so it starts ticked and can be left out here.
  const chooser = page.getByRole("dialog", { name: "What can this space use?" });
  const item = chooser.getByRole("checkbox", { name: "weekly-review", exact: true });
  await expect(item).toBeChecked();
  await captureScreenshot(page, testInfo, "new-space-items");
  await item.click();
  await expect(item).not.toBeChecked();
  await chooser.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(chooser).toHaveCount(0);

  // Continue switches to the new space and opens its own Chief in the background. Let that land
  // before leaving it, or its late remount overrides the click below or closes the Skills dialog.
  const chiefs = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Chief/ });
  await expect(chiefs.nth(1)).toHaveAttribute("aria-current", "page");
  const personalChief = chiefs.first();
  await personalChief.click();
  await expect(personalChief).toHaveAttribute("aria-current", "page");
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const skills = page.getByRole("dialog", { name: "Skills", exact: true });
  const yours = skills.getByTestId("your-skills");
  await yours.getByRole("button", { name: /weekly-review/ }).click();
  const availability = yours.getByTestId("availability");
  await expect(availability).toContainText("Available in");
  await availability.getByRole("button", { name: /Personal/ }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Personal" })).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Clients" })).not.toBeChecked();
  await captureScreenshot(page, testInfo, "skill-available-in");
});
