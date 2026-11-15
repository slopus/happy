import { expect, test } from "@playwright/test";
import type { PluginSubmission } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, makeAdmin, signup } from "./helpers";

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#888"/></svg>`;

function submission(overrides: Partial<PluginSubmission>): PluginSubmission {
  return {
    id: "submission-notes",
    email: "maker@example.test",
    name: "Planning Notes",
    website: "https://notes.example.test",
    logo: "https://plugins.example.test/notes.svg",
    source: "https://github.com/example/planning-notes",
    description: "Plans your day from your calendar and notes.",
    testing: "Connect the plugin, then ask a bot to plan tomorrow.\nIt should list three blocks.",
    claim: null,
    status: "pending",
    reason: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

test("an admin reviews plugin submissions from the emailed admin link", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `plugin-admin-${stamp}@rakazo.test`, "password12", `Plugin Admin ${stamp}`);
  await completeOnboarding(page);

  let submissions = [
    submission({}),
    submission({
      id: "submission-tasks",
      name: "Task Board",
      website: null,
      source: "https://github.com/example/task-board",
      description: "Tracks tasks across projects.",
    }),
    submission({
      id: "submission-claim",
      name: "Acme Tickets",
      email: "owner@acme.example.test",
      website: "https://acme.example.test",
      logo: null,
      source: null,
      testing: null,
      claim: "acme-tickets",
      description: "",
    }),
  ];
  const reviews: unknown[] = [];
  await page.route("**/rpc/me", (route) => makeAdmin(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, "bootstrap"));
  await page.route("https://plugins.example.test/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: LOGO }),
  );
  await page.route("**/rpc/marketplace/submissions", async (route) => {
    const { status } = route.request().postDataJSON().json as { status: string };
    await route.fulfill({
      json: { json: submissions.filter((row) => row.status === status) },
    });
  });
  await page.route("**/rpc/marketplace/review", async (route) => {
    const input = route.request().postDataJSON().json as {
      id: string;
      decision: "approve" | "reject";
      reason?: string;
    };
    reviews.push(input);
    submissions = submissions.map((row) =>
      row.id === input.id
        ? {
            ...row,
            status: input.decision === "approve" ? "approved" : "rejected",
            reason: input.reason ?? null,
            reviewedAt: "2026-10-02T09:00:00.000Z",
          }
        : row,
    );
    await route.fulfill({ json: { json: submissions.find((row) => row.id === input.id) } });
  });

  await page.goto("/admin/plugins");
  const panel = page.getByTestId("plugin-submissions");
  const rows = panel.getByTestId("plugin-submission");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("github.com/example/planning-notes");
  const claim = panel.getByRole("listitem", { name: "Acme Tickets" });
  await expect(claim).toContainText("rakazo.com/integrations/acme-tickets");
  await expect(claim.getByRole("button", { name: "Testing" })).toHaveCount(0);
  await expect(rows.first()).toContainText("maker@example.test");
  await rows.first().getByRole("button", { name: "Testing" }).click();
  await expect(rows.first()).toContainText("It should list three blocks.");
  await captureScreenshot(page, testInfo, "admin-plugin-submissions");

  const tasks = panel.getByRole("listitem", { name: "Task Board" });
  await tasks.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject Task Board" });
  const reject = dialog.getByRole("button", { name: "Reject", exact: true });
  await expect(reject).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("The repository has no manifest.");
  await captureScreenshot(page, testInfo, "admin-plugin-submission-reject");
  await reject.click();
  await expect(dialog).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  await rows.first().getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await claim.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel.getByText("No submissions", { exact: true })).toBeVisible();
  expect(reviews).toEqual([
    { id: "submission-tasks", decision: "reject", reason: "The repository has no manifest." },
    { id: "submission-notes", decision: "approve" },
    { id: "submission-claim", decision: "approve" },
  ]);

  await panel.getByRole("tab", { name: "Rejected" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("The repository has no manifest.");
});
