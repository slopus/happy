import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.afterEach(async ({ page }) => {
  // Polling can leave a route.fetch response in use when the assertions finish.
  await page.unrouteAll({ behavior: "wait" });
});

/**
 * The messaging surface is env-gated off in E2E (no platform credentials),
 * so the surface RPCs are fulfilled with fixture data. The screen itself —
 * navigation from account settings, layout, and both action lists — renders
 * exactly as it would against a live deployment.
 */
test("messaging settings show linked chat apps, channels, connections, and team conversations", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/installations/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          available: true,
          installations: [
            {
              id: "install-test",
              provider: "slack",
              workspaceName: "Example workspace",
              botId: "bot-1",
            },
          ],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram", "telegram-work", "lark"],
          addresses: { sendblue: "+15550001111" },
          openSignup: false,
          identities: [
            {
              id: "mi-1",
              provider: "sendblue",
              address: "+15551230001",
              botId: "bot-1",
              botName: "Chief",
            },
            {
              id: "mi-2",
              provider: "telegram-work",
              address: "424242",
              botId: "bot-2",
              botName: "Lead",
            },
          ],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/link/start", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { code: "ABCD-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }),
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cm1",
            channelId: "ch1",
            identityId: "mi-1",
            provider: "sendblue",
            name: "Family",
            status: "invited",
            memberCount: 3,
          },
        ],
      }),
    }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cn1",
            peerBotName: "Assistant",
            peerOwnerLabel: "Dana",
            status: "pending",
            incoming: true,
          },
        ],
      }),
    }),
  );

  await page.route("**/rpc/externalConversations/updatePolicy", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          teamChatAmbientEnabled: true,
          teamChatRules: "Reply when asked about launch.",
          automatedSenderPolicies: {
            B_GITHUB: { name: "GitHub", mode: "rollup", rollupHours: 6 },
          },
        },
      }),
    }),
  );

  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      json?: {
        current?: {
          id: string;
          bots: Array<{ id: string }>;
          externalConversations?: unknown[];
        };
        spaces?: Array<{ id: string; externalConversations?: unknown[] }>;
      };
    };
    const current = payload.json?.current;
    const botId = current?.bots[0]?.id;
    if (current && botId) {
      const conversation = {
        id: "clexternal000000000000001",
        spaceId: current.id,
        botId,
        provider: "slack",
        displayName: "#launch",
        participantNames: ["Ada", "Grace"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {
          B_GITHUB: { name: "GitHub", mode: "ignore" },
        },
        automatedSenders: [{ id: "B_GITHUB", name: "GitHub" }],
        threadId: "clthread00000000000000001",
        preview: "Ship Friday?",
        unread: false,
        updatedAt: new Date().toISOString(),
      };
      current.externalConversations = [conversation];
      for (const space of payload.json?.spaces ?? []) {
        if (space.id === current.id) space.externalConversations = [conversation];
      }
    }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  const stamp = Date.now();
  const userName = `Messenger ${stamp}`;
  await signup(page, `messaging-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-messaging").click();

  const messagingSettings = page.getByTestId("messaging-settings");
  await expect(messagingSettings).toBeVisible();
  await expect(messagingSettings.getByRole("button", { name: "Connect a chat app" })).toBeEnabled();
  await expect(messagingSettings.getByText("Example workspace", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "messaging-slack-workspace");
  await expect(messagingSettings.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await expect(messagingSettings.getByText("#launch")).toBeVisible();
  await messagingSettings.getByRole("button", { name: "Settings", exact: true }).click();
  const conversationSettings = page.getByTestId("external-conversation-settings");
  await expect(conversationSettings).toBeVisible();
  await expect(conversationSettings.getByText("Replies to")).toBeVisible();
  await expect(conversationSettings.getByText("Instructions for this room")).toBeVisible();
  await expect(conversationSettings.getByText("GitHub")).toBeVisible();
  await captureScreenshot(page, testInfo, "messaging-team-conversation-settings");
  await settings.getByTestId("settings-nav-general").click();
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(settings.getByTestId("settings-nav-messaging")).toHaveText("메시징");
  await settings.getByTestId("settings-nav-messaging").click();

  await expect(messagingSettings).toBeVisible();
  await expect(messagingSettings.getByText("+15551230001, Chief")).toBeVisible();
  await expect(messagingSettings.getByText("424242, Lead")).toBeVisible();
  await expect(messagingSettings.getByText("Family")).toBeVisible();
  await expect(messagingSettings.getByText("Dana's Assistant")).toBeVisible();
  // Scoped to the panel: the settings nav has its own 승인 (Approvals).
  await expect(messagingSettings.getByRole("button", { name: "승인" })).toHaveCount(2);

  await messagingSettings.getByRole("button", { name: "채팅 앱 연결" }).click();
  await page.getByRole("menuitem", { name: "iMessage", exact: true }).click();
  await expect(page.getByTestId("messaging-link-code")).toContainText("ABCD-2345");
  await expect(page.getByTestId("messaging-link-code")).toContainText("+15550001111");
  await captureScreenshot(page, testInfo, "messaging-settings-ko");
});

test("Slack setup has one Connect action that opens workspace authorization", async ({
  page,
}, testInfo) => {
  const fixture = (json: unknown) => ({
    contentType: "application/json",
    body: JSON.stringify({ json }),
  });
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill(
      fixture({
        enabled: true,
        providers: ["slack"],
        identities: [],
        openSignup: false,
      }),
    ),
  );
  let personalLinkAvailable = false;
  await page.route("**/rpc/messaging/installations/list", (route) =>
    route.fulfill(fixture({ available: true, installations: [], personalLinkAvailable })),
  );
  await page.route("**/rpc/messaging/channels/list", (route) => route.fulfill(fixture([])));
  await page.route("**/rpc/messaging/connections/list", (route) => route.fulfill(fixture([])));
  await page
    .context()
    .route("**/slack-test-authorize", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Slack authorization</h1>" }),
    );
  let installs = 0;
  let codeRequests = 0;
  await page.route("**/rpc/messaging/installations/start", (route) => {
    installs++;
    return route.fulfill(fixture({ url: new URL("/slack-test-authorize", page.url()).href }));
  });
  await page.route("**/rpc/messaging/link/start", (route) => {
    codeRequests++;
    return route.fulfill(
      fixture({ code: "ABCD-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    );
  });
  const stamp = Date.now();
  const name = `Slack setup ${stamp}`;
  await signup(page, `slack-setup-${stamp}@rakazo.test`, "password12", name);
  await completeOnboarding(page);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-nav-messaging").click();
  const settings = page.getByTestId("messaging-settings");
  await expect(settings.getByText("Chat with your bot from Slack.")).toBeVisible();
  const connect = settings.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeEnabled();
  await expect(
    settings.getByRole("button", { name: "Connect a chat app", exact: true }),
  ).toHaveCount(0);
  await expect(settings.getByText("Slack workspace", { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Link DMs", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "messaging-connect-slack");
  const popupPromise = page.waitForEvent("popup");
  await connect.click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Slack authorization" })).toBeVisible();
  expect(installs).toBe(1);
  expect(codeRequests).toBe(0);
  await popup.close();

  // A teammate installed the workspace: personal linking works without installation ownership.
  personalLinkAvailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(settings.getByRole("button", { name: "Link DMs", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "messaging-slack-member-link");
  await settings.getByRole("button", { name: "Link DMs", exact: true }).click();
  await expect(settings.getByTestId("messaging-link-code")).toContainText("ABCD-2345");
  expect(installs).toBe(1);
  expect(codeRequests).toBe(1);
});
