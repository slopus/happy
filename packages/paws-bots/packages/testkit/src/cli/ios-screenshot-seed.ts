import { readFile } from "node:fs/promises";
import type { BotSecretDestination, MessageBlock } from "@rakazo/contracts";
import { encodeCardSecret, encodeContactSecret, encodeLoginSecret } from "@rakazo/contracts";
import { allocateTicketNumber, createDb, createThreadMessage, ensureBoard } from "@rakazo/db";
import { pageViewerCode } from "@rakazo/page-kit/compile";
import { PNG } from "pngjs";
import { sessionCookieHeader } from "../index.js";

const MARKER = "marigold checklist";
const READY = "The fixture workspace is ready.";
const GROUP_READY = "The fixture launch plan is ready.";
const FILE_NAME = "launch-notes.txt";
const PAGE_TITLE = "Launch dashboard";
const PAGE_SOURCE = [
  "const App = () => (",
  '  <Page title="Launch dashboard" summary="Fixture figures for the screenshot catalog.">',
  '    <Metrics metrics={[{ value: "128", label: "Signups" }, { value: "4.2%", label: "Trial to paid" }]} />',
  "  </Page>",
  ");",
  "export default App;",
].join("\n");
const IMAGE_NAME = "launch-chart.png";
const NOTES = [
  "Launch notes",
  "",
  "1. Confirm the pricing page copy.",
  "2. Collect three customer quotes.",
  "3. Publish the changelog on launch day.",
].join("\n");

export interface IosScreenshotFixture {
  botId: string;
  peerBotId: string;
  groupId: string;
  routineId: string;
  artifactId: string;
  markdownId: string;
  imageId: string;
  pdfId: string;
  archiveId: string;
  videoId: string;
  teamSpaceId: string;
  conversationId: string;
  /** A bot whose thread shows the cards a bot sends when it needs something. */
  cardsBotId: string;
}

interface BotRow {
  id: string;
  name: string;
  threadId: string;
}

interface GroupRow {
  id: string;
  name: string;
  threadId: string;
}

interface RoutineRow {
  id: string;
  name: string;
  active: boolean;
}

interface ArtifactRow {
  id: string;
  name: string;
  size: number;
}

interface MeRow {
  userId: string;
  spaceId: string;
}

/** Finishes a plan checkout in the billing provider, as paying does in production. */
export type CompleteCheckout = (customerId: string) => void;

export async function seedIosScreenshotFixture(input: {
  apiUrl: string;
  databaseUrl: string;
  email: string;
  emptyEmail: string;
  freeEmail: string;
  password: string;
  /** Present when the API bills: the main user then pays for Pro, the empty one is on a trial. */
  completeCheckout: CompleteCheckout;
}): Promise<IosScreenshotFixture> {
  const populated = await ensureUser(input.apiUrl, input.email, input.password, "Screenshot User");
  const empty = await ensureUser(input.apiUrl, input.emptyEmail, input.password, "Empty User");
  // Signs in without a plan or a survey answer, to show what a new account meets first.
  await ensureUser(input.apiUrl, input.freeEmail, input.password, "Free User");
  for (const bot of await rpc<BotRow[]>(input.apiUrl, empty.headers, "bots/list")) {
    await rpc(input.apiUrl, empty.headers, "bots/remove", { botId: bot.id, deleteMemories: false });
  }

  const bots = await rpc<BotRow[]>(input.apiUrl, populated.headers, "bots/list");
  const researcher = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Researcher",
    title: "Product research",
    description: "Finds evidence and keeps fixture notes organized.",
  });
  const writer = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Writer",
    title: "Clear writing",
    description: "Turns research into concise drafts.",
  });
  const support = await ensureBot(input.apiUrl, populated.headers, bots, {
    name: "Support",
    title: "Customer support",
    description: "Prepares friendly customer replies.",
  });
  const archived = await rpc<BotRow[]>(input.apiUrl, populated.headers, "bots/listArchived");
  if (!archived.some((bot) => bot.name === "Archived fixture")) {
    const created = await rpc<BotRow>(input.apiUrl, populated.headers, "bots/create", {
      name: "Archived fixture",
      title: "Archived",
      description: "A recoverable archived bot.",
      instructions: "Remain archived.",
      notifyOnFinish: true,
    });
    await rpc(input.apiUrl, populated.headers, "bots/archive", { botId: created.id });
  }

  const groups = await rpc<GroupRow[]>(input.apiUrl, populated.headers, "groups/list");
  let group = groups.find((item) => item.name === "Launch team");
  if (!group) {
    group = await rpc<GroupRow>(input.apiUrl, populated.headers, "groups/create", {
      name: "Launch team",
      botIds: [researcher.id, writer.id, support.id],
    });
  }
  if (!groups.some((item) => item.name === "Review pair")) {
    await rpc<GroupRow>(input.apiUrl, populated.headers, "groups/create", {
      name: "Review pair",
      botIds: [researcher.id, writer.id],
    });
  }
  const routines = await rpc<RoutineRow[]>(input.apiUrl, populated.headers, "routines/list", {
    botId: researcher.id,
  });
  let routine = routines.find((item) => item.name === "Weekly fixture review");
  if (!routine) {
    routine = await rpc<RoutineRow>(input.apiUrl, populated.headers, "routines/create", {
      botId: researcher.id,
      name: "Weekly fixture review",
      prompt: "Review the fixture launch notes and summarize the open questions.",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      active: false,
      notify: true,
    });
  }

  if (routine.active) {
    await rpc(input.apiUrl, populated.headers, "routines/update", {
      routineId: routine.id,
      active: false,
    });
  }

  // A Pro user brings their own provider; the offline fixture accepts this key.
  const credentials = await rpc<unknown[]>(input.apiUrl, populated.headers, "models/credentials");
  if (credentials.length === 0) {
    const model = { provider: "openrouter", modelId: "anthropic/claude-fable-5.1" };
    await rpc(input.apiUrl, populated.headers, "models/connect", {
      ...model,
      apiKey: "fixture-openrouter-key",
    });
    await rpc(input.apiUrl, populated.headers, "models/setDefault", model);
  }
  // Most people who reach the wallet have connected one; the emulator connects on the first poll.
  const wallet = await rpc<{ status: string }>(
    input.apiUrl,
    populated.headers,
    "paymentWallet/status",
  );
  if (wallet.status !== "connected") {
    await rpc(input.apiUrl, populated.headers, "paymentWallet/connect");
    // The first sign-in check waits out the provider's poll interval.
    const deadline = Date.now() + 15_000;
    while (
      (await rpc<{ status: string }>(input.apiUrl, populated.headers, "paymentWallet/status"))
        .status !== "connected"
    ) {
      if (Date.now() > deadline) throw new Error("The wallet emulator never connected");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const rules = await rpc<{ matchValue: string }[]>(
    input.apiUrl,
    populated.headers,
    "approvalRules/list",
  );
  if (!rules.some((rule) => rule.matchValue === "example.com")) {
    await rpc(input.apiUrl, populated.headers, "approvalRules/set", {
      effect: "always_allow",
      matchKind: "site",
      matchValue: "example.com",
    });
  }
  // One of each kind people save: a website sign-in, a card, a contact, an API token, and a
  // command variable. The card number is a well-known test number, not a real card.
  const vault = await rpc<{ name: string }[]>(input.apiUrl, populated.headers, "vault/list");
  const vaultEntries: {
    destination: BotSecretDestination;
    value: string;
    title?: string;
    alsoOn?: string[];
  }[] = [
    {
      title: "Help desk",
      destination: {
        name: "help-desk",
        origin: "https://help.example.com",
        auth: { type: "login" },
      },
      // Also on another site, with an authenticator key (RFC 6238's test key), so the item and
      // its editor show both.
      alsoOn: ["https://support.example.com"],
      value: encodeLoginSecret({
        fields: [
          { label: "Email", value: "support@example.com", hidden: false },
          { label: "Password", value: "fixture-password", hidden: true },
        ],
        otp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      }),
    },
    {
      destination: {
        name: "status-api",
        origin: "https://api.example.com",
        auth: { type: "bearer" },
      },
      value: "fixture-status-token",
    },
    {
      title: "Home",
      destination: { name: "home", origin: "", auth: { type: "contact" } },
      value: encodeContactSecret({
        name: "Sam Fixture",
        line1: "1 Example Street",
        city: "Springfield",
        postalCode: "12345",
      }),
    },
    {
      destination: { name: "visa-4242", origin: "", auth: { type: "card" } },
      value: encodeCardSecret({
        number: "4242424242424242",
        expMonth: 8,
        expYear: 2030,
        billing: "home",
      }),
    },
    {
      destination: { name: "deploy_token", origin: "", auth: { type: "command" } },
      value: "fixture-deploy-token",
    },
  ];
  for (const credential of vaultEntries) {
    if (vault.some((secret) => secret.name === credential.destination.name)) continue;
    await rpc(input.apiUrl, populated.headers, "vault/put", credential);
  }

  const stored = await rpc<ArtifactRow[]>(input.apiUrl, populated.headers, "artifacts/list", {
    botId: researcher.id,
  });
  const upload = async (name: string, mimeType: string, bytes: Buffer) =>
    stored.find((artifact) => artifact.name === name) ??
    rpc<ArtifactRow>(input.apiUrl, populated.headers, "artifacts/create", {
      botId: researcher.id,
      name,
      mimeType,
      contentBase64: bytes.toString("base64"),
    });
  const notes = await upload(FILE_NAME, "text/plain", Buffer.from(NOTES));
  const plan = await upload(
    "launch-plan.md",
    "text/markdown",
    Buffer.from(
      "# Launch plan\n\n**Owner:** Researcher\n\n- [x] Draft the announcement\n- [ ] Collect customer quotes\n- [ ] Publish the changelog\n",
    ),
  );
  const image = await upload(IMAGE_NAME, "image/png", chartPng());
  const pdf = await upload("launch-brief.pdf", "application/pdf", briefPdf());
  // An empty archive: a type no client previews.
  const archive = await upload(
    "launch-assets.zip",
    "application/zip",
    Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
  );

  // The product demo already in the repository, so the video viewer has something real to play.
  const video = await upload(
    "launch-demo.mp4",
    "video/mp4",
    await readFile(new URL("../../../../docs/screenshots/demo.mp4", import.meta.url)),
  );

  const spaces = await rpc<{ spaces: { id: string; name: string }[] }>(
    input.apiUrl,
    populated.headers,
    "spaces/list",
  );
  const teamSpace =
    spaces.spaces.find((space) => space.name === "Launch crew") ??
    (await rpc<{ id: string }>(input.apiUrl, populated.headers, "spaces/create", {
      name: "Launch crew",
    }));

  const me = await rpc<MeRow>(input.apiUrl, populated.headers, "me");
  const emptyMe = await rpc<MeRow>(input.apiUrl, empty.headers, "me");
  const db = createDb(input.databaseUrl, { applicationName: "ios-screenshots" });
  try {
    await ensureThreadCopy(db.prisma, {
      threadId: researcher.threadId,
      botId: researcher.id,
      peer: writer,
      artifact: notes,
    });
    const conversation = await ensureTeamConversation(db.prisma, {
      spaceId: me.spaceId,
      userId: me.userId,
      botId: researcher.id,
    });
    await ensureActivity(db.prisma, {
      threadId: researcher.threadId,
      botId: researcher.id,
      spaceId: me.spaceId,
      userId: me.userId,
    });
    await ensureText(db.prisma, group.threadId, "bot", writer.id, GROUP_READY);
    await ensurePage(db.prisma, {
      threadId: researcher.threadId,
      botId: researcher.id,
      spaceId: me.spaceId,
      userId: me.userId,
    });
    await ensureTickets(db.prisma, me.spaceId, me.userId, [researcher.id, writer.id]);
    await ensureMemoryNotes(db.prisma, {
      spaceId: me.spaceId,
      userId: me.userId,
      botId: researcher.id,
    });
    await ensureRequestCards(db.prisma, { threadId: support.threadId, botId: support.id });
    await ensurePayments(db.prisma, {
      spaceId: me.spaceId,
      userId: me.userId,
      researcher,
      writer,
    });
    const billing = { apiUrl: input.apiUrl, prisma: db.prisma, complete: input.completeCheckout };
    await ensurePlan({ ...billing, headers: populated.headers, userId: me.userId, trial: false });
    await ensurePlan({ ...billing, headers: empty.headers, userId: emptyMe.userId, trial: true });
    // After the plan, since a bot only runs for an account with billing access.
    await ensureWaitingKeyRequest(input.apiUrl, populated.headers, support.id);
    for (const userId of [me.userId, emptyMe.userId]) {
      // Hosted sign-ups answer a survey first; the free user's flow shows it.
      await db.prisma.signupSurvey.upsert({
        where: { userId },
        create: { userId, use: "work" },
        update: {},
      });
    }
    return {
      botId: researcher.id,
      peerBotId: writer.id,
      groupId: group.id,
      routineId: routine.id,
      artifactId: notes.id,
      markdownId: plan.id,
      imageId: image.id,
      pdfId: pdf.id,
      archiveId: archive.id,
      videoId: video.id,
      teamSpaceId: teamSpace.id,
      conversationId: conversation.id,
      cardsBotId: support.id,
    };
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}

/** A note the bot remembered and one every bot in the space shares, for the memory screens. */
async function ensureMemoryNotes(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { spaceId: string; userId: string; botId: string },
) {
  const notes = [
    {
      scope: "bot",
      botId: input.botId,
      path: "preferences.md",
      content:
        "# Preferences\n\n- Cite a source for every claim.\n- Keep summaries under five bullets.\n",
    },
    {
      scope: "user",
      botId: null,
      path: "team.md",
      content:
        "# Launch team\n\n- Dana owns the announcement.\n- Lee reviews every customer quote.\n",
    },
  ];
  for (const note of notes) {
    const existing = await prisma.memoryDocument.findFirst({
      where: { spaceId: input.spaceId, scope: note.scope, botId: note.botId, path: note.path },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.memoryDocument.create({
      data: { ...note, spaceId: input.spaceId, userId: input.userId },
    });
  }
}

/** A page the bot built, named in its reply with the card under it, for the page screens. */
async function ensurePage(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string; spaceId: string; userId: string },
) {
  const existing = await prisma.page.findFirst({
    where: { userId: input.userId, spaceId: input.spaceId, title: PAGE_TITLE },
    select: { id: true },
  });
  if (existing) return;
  const page = await prisma.page.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      title: PAGE_TITLE,
      versions: {
        create: {
          version: 1,
          title: PAGE_TITLE,
          source: PAGE_SOURCE,
          code: pageViewerCode(PAGE_SOURCE),
        },
      },
    },
  });
  await createThreadMessage(prisma, {
    threadId: input.threadId,
    role: "bot",
    botId: input.botId,
    blocks: [
      { kind: "text", text: `I made a [${PAGE_TITLE}](page:${page.id}) from the launch notes.` },
      { kind: "page", pageId: page.id, version: 1, title: PAGE_TITLE },
    ],
  });
}

async function ensureBot(
  apiUrl: string,
  headers: Record<string, string>,
  bots: BotRow[],
  profile: { name: string; title: string; description: string },
) {
  const existing = bots.find((bot) => bot.name === profile.name);
  if (existing) return existing;
  return rpc<BotRow>(apiUrl, headers, "bots/create", {
    ...profile,
    instructions: profile.description,
    notifyOnFinish: true,
  });
}

async function ensureThreadCopy(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string; peer: BotRow; artifact: ArtifactRow },
) {
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId },
    select: { blocks: true },
  });
  const serialized = messages.map((message) => JSON.stringify(message.blocks));
  if (!serialized.some((blocks) => blocks.includes(READY))) {
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Summarize the launch notes." }],
    });
    // A bot-to-bot exchange, which the chat links to its own transcript.
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: input.peer.id,
          toBotName: input.peer.name,
          text: "Can you draft the announcement from these notes?",
        },
      ],
    });
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: input.peer.id,
          fromBotName: input.peer.name,
          text: "Done. The draft leads with the customer quotes.",
        },
      ],
    });
    await createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      blocks: [
        {
          kind: "text",
          text: [
            READY,
            "",
            "**Checklist** with *italic* and `code`.",
            "",
            `The unique search phrase is ${MARKER}.`,
            "",
            "![Remote diagram](https://example.com/diagram.png)",
          ].join("\n"),
        },
        {
          kind: "file",
          artifactId: input.artifact.id,
          mimeType: "text/plain",
          name: FILE_NAME,
          size: input.artifact.size,
        },
      ],
    });
  }
}

async function ensureActivity(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string; spaceId: string; userId: string },
) {
  const existing = await prisma.run.findFirst({
    where: { threadId: input.threadId, status: "completed" },
    select: { id: true },
  });
  if (existing) return;
  const source = await prisma.message.findFirst({
    where: { threadId: input.threadId, role: "user" },
    select: { id: true },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      prompt: "Prepare the fixture workspace",
      status: "completed",
    },
  });
  await prisma.run.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: source?.id,
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });
}

/** A small bar chart, so the image viewer has something to show. */
function chartPng() {
  const png = new PNG({ width: 480, height: 320 });
  const bars = [120, 200, 160, 260, 220];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const bar = Math.floor((x - 40) / 84);
      const inBar = x >= 40 && (x - 40) % 84 < 60 && bar < bars.length;
      const filled = inBar && png.height - 30 - y < (bars[bar] ?? 0) && y < png.height - 30;
      const offset = (y * png.width + x) * 4;
      const shade = filled ? 40 + bar * 30 : 248;
      png.data[offset] = shade;
      png.data[offset + 1] = shade;
      png.data[offset + 2] = filled ? shade + 20 : 248;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A chat-app channel the bot answers in, so Messaging lists a conversation to open. */
async function ensureTeamConversation(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { spaceId: string; userId: string; botId: string },
) {
  const key = { provider: "slack", workspaceId: "T-fixture", externalKey: "C-launch" };
  const existing = await prisma.externalConversation.findUnique({
    where: { provider_workspaceId_externalKey: key },
    select: { id: true },
  });
  if (existing) return existing;
  const conversation = await prisma.externalConversation.create({
    data: {
      ...key,
      conversationId: "C-launch",
      displayName: "#launch",
      participantNames: ["Dana", "Lee"],
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
    },
    select: { id: true },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: input.spaceId, userId: input.userId, externalConversationId: conversation.id },
    select: { id: true },
  });
  await createThreadMessage(prisma, {
    threadId: thread.id,
    role: "user",
    blocks: [{ kind: "text", text: "Dana: Is the launch checklist ready?" }],
  });
  await createThreadMessage(prisma, {
    threadId: thread.id,
    role: "bot",
    botId: input.botId,
    blocks: [{ kind: "text", text: "Yes. Two items are left: customer quotes and the changelog." }],
  });
  return conversation;
}

/** A one-page PDF with a heading and two lines, built by hand so no PDF library is needed. */
function briefPdf() {
  const text = [
    "BT /F1 28 Tf 72 720 Td (Launch brief) Tj ET",
    "BT /F1 14 Tf 72 680 Td (Ship the announcement on Tuesday.) Tj ET",
    "BT /F1 14 Tf 72 656 Td (Quotes and changelog are the last open items.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const TICKETS = [
  { title: "Draft the launch announcement", status: "doing" },
  { title: "Collect customer quotes", status: "todo" },
  { title: "Review pricing page copy", status: "review" },
  { title: "Publish the changelog", status: "done" },
] as const;

/** Board cards in several columns. Only an API with the board enabled shows them. */
/** Two payments bots made with the wallet, as the spending limit lists them. */
async function ensurePayments(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { spaceId: string; userId: string; researcher: BotRow; writer: BotRow },
) {
  const payments = [
    {
      key: "groceries",
      bot: input.researcher,
      site: "groceries.example.com",
      amount: 2_340,
      hours: 2,
    },
    { key: "books", bot: input.writer, site: "books.example.com", amount: 1_299, hours: 30 },
  ];
  for (const payment of payments) {
    const operationKey = `ios-screenshot-payment-${payment.key}`;
    const data = {
      userId: input.userId,
      spaceId: input.spaceId,
      botId: payment.bot.id,
      threadId: payment.bot.threadId,
      site: payment.site,
      amount: payment.amount,
      currency: "usd",
      createdAt: new Date(Date.now() - payment.hours * 3_600_000),
    };
    await prisma.payment.upsert({
      where: { operationKey },
      create: { operationKey, ...data },
      update: data,
    });
  }
}

async function ensureTickets(
  prisma: ReturnType<typeof createDb>["prisma"],
  spaceId: string,
  userId: string,
  botIds: string[],
) {
  const board = await ensureBoard(prisma, spaceId);
  if (await prisma.ticket.count({ where: { boardId: board.id } })) return;
  for (const [index, ticket] of TICKETS.entries()) {
    await prisma.$transaction(async (tx) =>
      tx.ticket.create({
        data: {
          boardId: board.id,
          spaceId,
          number: await allocateTicketNumber(tx, board.id),
          title: ticket.title,
          status: ticket.status,
          assigneeBotId: botIds[index % botIds.length],
          createdByUserId: userId,
          completedAt: ticket.status === "done" ? new Date() : null,
        },
      }),
    );
  }
}

/** Subscribes through the API and the billing provider, so every billing screen reads it back. */
async function ensurePlan(input: {
  apiUrl: string;
  headers: Record<string, string>;
  prisma: ReturnType<typeof createDb>["prisma"];
  complete: CompleteCheckout;
  userId: string;
  trial: boolean;
}) {
  const status = await rpc<{ access: boolean }>(input.apiUrl, input.headers, "billing/status");
  if (status.access) return;
  await rpc(input.apiUrl, input.headers, "billing/checkout", { client: "mobile" });
  const member = await input.prisma.member.findFirstOrThrow({
    where: { userId: input.userId },
    select: { organizationId: true },
  });
  const account = await input.prisma.billingAccount.findUniqueOrThrow({
    where: { organizationId: member.organizationId },
    select: { customerId: true },
  });
  input.complete(account.customerId);
  await rpc(input.apiUrl, input.headers, "billing/refresh");
  if (!input.trial) await rpc(input.apiUrl, input.headers, "billing/endTrial");
}

const CARDS_READY = "Set up the weekly support digest.";

/** The cards a bot shows when it needs something: a key, a sign-in, a site, an app, a choice. */
async function ensureRequestCards(
  prisma: ReturnType<typeof createDb>["prisma"],
  input: { threadId: string; botId: string },
) {
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId },
    select: { blocks: true },
  });
  if (messages.some((message) => JSON.stringify(message.blocks).includes(CARDS_READY))) return;
  const bot = (blocks: MessageBlock[]) =>
    createThreadMessage(prisma, {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      blocks,
    });
  await createThreadMessage(prisma, {
    threadId: input.threadId,
    role: "user",
    blocks: [{ kind: "text", text: CARDS_READY }],
  });
  await bot([
    { kind: "text", text: "I'll read new tickets from the help desk and draft replies." },
    {
      kind: "app_connect",
      provider: "gmail",
      name: "Gmail",
      description: "Search, read, and draft emails",
      logo: null,
      status: "pending",
    },
  ]);
  await bot([
    {
      kind: "ask",
      text: "Sign in to the help desk so I can see the ticket queue.",
      input: "secret",
      purpose: "password",
      credential: {
        name: "help-desk",
        origin: "https://help.example.com",
        auth: { type: "login" },
      },
      status: "answered",
    },
  ]);
  await bot([
    {
      kind: "ask",
      text: "Can I open status.example.com to check for outages?",
      site: "status.example.com",
      status: "answered",
      answer: "Allow",
    },
  ]);
  await bot([
    {
      kind: "choice",
      question: "Which tone should replies use?",
      options: [
        { id: "warm", letter: "A", label: "Warm and casual" },
        { id: "brief", letter: "B", label: "Brief and direct" },
        { id: "formal", letter: "C", label: "Formal" },
      ],
    },
  ]);
  await bot([
    { kind: "computer", state: "Needs you", text: "Approve the sign-in code on your phone." },
  ]);
  await bot([
    {
      kind: "ask",
      approvalEffectId: "ios-screenshot-pay",
      text: "Pay on freshcart.test?",
      detailFormat: "text",
      receipt: {
        button: "Place order",
        items: [
          { name: "Bananas × 6", amount: "$3.00" },
          { name: "Oat milk 1L × 2", amount: "$8.40" },
          { name: "Delivery", amount: "$6.00" },
        ],
        amount: "$17.40",
        amountSource: "page",
      },
      status: "answered",
      answer: "allow",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  ]);
}

/**
 * A live request for a key: its card only offers a field while the bot's run waits for the
 * answer, so the offline scripted bot asks for real, as the web tests have it do.
 */
async function ensureWaitingKeyRequest(
  apiUrl: string,
  headers: Record<string, string>,
  botId: string,
) {
  type Snapshot = { run?: { status: string; error?: string | null } | null };
  let last: Snapshot["run"] = null;
  const waiting = async () => {
    last = (await rpc<Snapshot>(apiUrl, headers, "threads/get", { botId })).run;
    return last?.status === "waiting_input";
  };
  if (await waiting()) return;
  await rpc(apiUrl, headers, "threads/send", {
    botId,
    text: "Check the status API too, and request a masked api key if you need one.",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await waiting()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The scripted bot never asked for a key; its run: ${JSON.stringify(last)}`);
}

async function ensureText(
  prisma: ReturnType<typeof createDb>["prisma"],
  threadId: string,
  role: "user" | "bot",
  botId: string,
  text: string,
) {
  const messages = await prisma.message.findMany({
    where: { threadId },
    select: { blocks: true },
  });
  if (messages.some((message) => JSON.stringify(message.blocks).includes(text))) return;
  await createThreadMessage(prisma, {
    threadId,
    role,
    botId,
    blocks: [{ kind: "text", text }],
  });
}

async function ensureUser(apiUrl: string, email: string, password: string, name: string) {
  const signup = await postAuth(apiUrl, "sign-up", { email, password, name });
  const session = signup.ok ? signup : await postAuth(apiUrl, "sign-in", { email, password });
  if (!session.ok || !session.token) {
    throw new Error(
      `Could not sign in fixture user (${session.status})${session.message ? `: ${session.message}` : ""}`,
    );
  }
  return {
    headers: {
      authorization: `Bearer ${session.token}`,
      cookie: session.cookie,
      origin: "rakazo://",
    },
  };
}

async function postAuth(
  apiUrl: string,
  action: "sign-in" | "sign-up",
  body: { email: string; password: string; name?: string },
) {
  const response = await fetch(`${apiUrl}/api/auth/${action}/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const message =
    parsed &&
    typeof parsed === "object" &&
    "message" in parsed &&
    typeof parsed.message === "string"
      ? parsed.message
      : undefined;
  return {
    ok: response.ok,
    status: response.status,
    message,
    // The signed bearer; the server refuses the raw session token.
    token: response.headers.get("set-auth-token") ?? "",
    cookie: sessionCookieHeader(response),
  };
}

async function rpc<T>(
  apiUrl: string,
  headers: Record<string, string>,
  procedure: string,
  body: unknown = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    const message = parsed.error?.message ?? text.slice(0, 180);
    throw new Error(`${procedure} failed (${response.status}): ${message}`);
  }
  return parsed.json as T;
}
