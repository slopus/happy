import { strToU8, zipSync } from "fflate";
import type { Criterion, EvalCase, Evidence } from "./cases.js";
import type { ToolChoiceExpect } from "./tool-choice.js";
import { gradeToolChoice } from "./tool-choice.js";

export const BOT_FILES_FIXTURE_VERSION = "bot-files-v6";

/**
 * A line of the site's code. A message that names the code can summarize it; one carrying this
 * exact line pasted the code instead of sending the files.
 */
const CODE_LINE = "return cards.filter((card) => card.ready).map(renderCard);";

/** A small working site, so a careful bot has nothing to fix before sending it. */
const SITE = [
  {
    path: "site/index.html",
    content:
      '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<ul id="cards"></ul>\n<script type="module" src="app.js"></script>\n',
  },
  {
    path: "site/app.js",
    content: [
      "const cards = [",
      '  { title: "Launch", ready: true },',
      '  { title: "Pricing", ready: false },',
      "];",
      'const renderCard = (card) => "<li>" + card.title + "</li>";',
      "function renderLaunchCards() {",
      `  ${CODE_LINE}`,
      "}",
      'document.getElementById("cards").innerHTML = renderLaunchCards().join("");',
      "",
    ].join("\n"),
  },
  { path: "site/style.css", content: "body { margin: 0; font-family: sans-serif; }\n" },
];
/** A real archive of the site, so a bot that inspects it before sending finds the same files. */
const SITE_ZIP = {
  path: "site.zip",
  content: zipSync(Object.fromEntries(SITE.map((file) => [file.path, strToU8(file.content)]))),
};

const CODER =
  "You are Coder. You write and edit code for the user's projects on your computer. You have no access to the production server; Servo does.";
const SERVO = {
  name: "Servo",
  description:
    "Server admin: the only bot with access to the production server. Uploads and deploys sites.",
  // Servo's own turn is not graded; keep it to one cheap acknowledgement.
  instructions:
    "When another bot sends you work, reply in one short sentence confirming what you received. Do not deploy anything.",
};

type Scenario = {
  id: string;
  purpose: string;
  /** Servo is a direct-chat teammate, a group member, or the subject receiving the files. */
  setup: { kind: "teammate"; ownComputer?: true } | { kind: "group" } | { kind: "receiver" };
  files: NonNullable<EvalCase["computerFiles"]>;
  ask: string;
  expect: ToolChoiceExpect;
  /**
   * What must have reached the other bot. Shared paths arrive in the product's own
   * "Files on our shared computer" list, so matching that list checks a contract, not prose.
   */
  delivered?: { id: string; pass: (deliveries: NonNullable<Evidence["deliveries"]>) => boolean };
  /** The subject must list the peer's site folder or read one of its files, at their exact paths. */
  opened?: true;
};

/**
 * Whether a call opened the peer's site where it is. The eval computer always serves a seeded path,
 * so a call at the exact path succeeded; one elsewhere, or reading the folder as a file, did not.
 */
function openedPeerSite(evidence: Evidence): boolean {
  const home = evidence.peerHome;
  if (!home) return false;
  const site = `${home}/site`;
  const files = new Set(SITE.map((file) => `${home}/${file.path}`));
  return evidence.toolCalls.some((call) => {
    if (call.step !== evidence.finalStep) return false;
    const path = String(call.args.path ?? "")
      .replace(/^(~|\/home\/rakazo)?\/+/, "")
      .replace(/\/+$/, "");
    if (call.name === "list_files") return path === site;
    return call.name === "read_file" && files.has(path);
  });
}

const SHARED_LIST = "Files on our shared computer:";
const sharedSite = (d: { text: string }) =>
  d.text.includes(SHARED_LIST) && /\/site(\/|\s|$)/.test(d.text.slice(d.text.indexOf(SHARED_LIST)));

const SCENARIOS: Scenario[] = [
  {
    id: "send-folder-on-shared-computer",
    purpose:
      "A bot passes a project folder to a teammate on its computer by path, not by pasting it.",
    setup: { kind: "teammate" },
    files: SITE,
    ask: "The site in your site folder is ready. Send it to Servo so Servo can deploy it.",
    expect: {
      calls: [{ tool: "message_bot", args: { files: "~site" } }],
      callsMustNot: [{ tool: "message_bot", args: { message: `~${CODE_LINE}` } }],
    },
    delivered: {
      id: "servo received the site's shared paths",
      pass: (deliveries) => deliveries.some((d) => d.kind === "message" && sharedSite(d)),
    },
  },
  {
    id: "send-zip-to-own-computer",
    purpose:
      "A bot whose teammate has its own computer ends up sending the zipped project, after being told a folder cannot be copied.",
    setup: { kind: "teammate", ownComputer: true },
    files: [...SITE, SITE_ZIP],
    ask: "The site is ready. Send it to Servo so Servo can deploy it. There's a zipped copy too if you need one.",
    expect: {
      calls: [{ tool: "message_bot", args: { files: "~site.zip" } }],
      callsMustNot: [{ tool: "message_bot", args: { message: `~${CODE_LINE}` } }],
    },
    delivered: {
      id: "servo received site.zip",
      pass: (deliveries) => deliveries.some((d) => d.files.includes("site.zip")),
    },
  },
  {
    id: "hand-off-folder-in-group",
    purpose:
      "In a group, a bot hands the next stage to the member who deploys, with the files attached.",
    setup: { kind: "group" },
    files: SITE,
    ask: "The site in your site folder is done. Hand it over to Servo to deploy.",
    expect: {
      calls: [{ tool: "handoff_to_bot", args: { files: "~site" } }],
      callsMustNot: [{ tool: "handoff_to_bot", args: { message: `~${CODE_LINE}` } }],
    },
    delivered: {
      id: "the handoff carries the site's shared paths",
      pass: (deliveries) => deliveries.some((d) => d.kind === "handoff" && sharedSite(d)),
    },
  },
  {
    id: "question-sends-no-files",
    purpose: "A question for a teammate goes without files, even with a project on the computer.",
    setup: { kind: "teammate" },
    files: SITE,
    ask: "Ask Servo whether the production server is up right now.",
    expect: {
      calls: [{ tool: "message_bot" }],
      callsMustNot: [{ tool: "message_bot", args: { files: "~site" } }],
    },
    delivered: {
      id: "servo received the question without files",
      pass: (deliveries) =>
        deliveries.length > 0 &&
        deliveries.every((d) => !d.files.length && !d.text.includes(SHARED_LIST)),
    },
  },
  {
    id: "receive-shared-path",
    purpose: "A bot handed a path on the shared computer opens the files there.",
    setup: { kind: "receiver" },
    files: SITE.map((file) => ({ ...file, owner: "peer" as const })),
    ask: "Please deploy the site.\n\nFiles on our shared computer:\n- {peerHome}/site",
    expect: {},
    opened: true,
  },
];

export const BOT_FILES_EVAL_CASES: EvalCase[] = SCENARIOS.map((scenario) => {
  const { setup } = scenario;
  const shared = {
    id: scenario.id,
    purpose: scenario.purpose,
    connections: [],
    pauseEndsTurn: true as const,
    computerFiles: scenario.files,
    grade: (evidence: Evidence): Criterion[] => [
      ...gradeToolChoice(scenario.expect, evidence),
      ...(scenario.delivered
        ? [{ id: scenario.delivered.id, pass: scenario.delivered.pass(evidence.deliveries ?? []) }]
        : []),
      ...(scenario.opened
        ? [{ id: "opened the site at the peer's path", pass: openedPeerSite(evidence) }]
        : []),
    ],
  };
  if (setup.kind === "group")
    return {
      ...shared,
      group: {
        members: [SERVO.name],
        roles: {
          Assistant: "Coder: writes and edits code for the user's projects.",
          Servo: SERVO.description,
        },
        instructions: { Assistant: CODER, Servo: SERVO.instructions },
      },
      steps: [{ ask: scenario.ask }],
    };
  if (setup.kind === "receiver")
    return {
      ...shared,
      botSetup: {
        instructions:
          "You are Servo, the only bot with access to the production server. You upload and deploy the sites other bots build.",
      },
      peer: {
        name: "Coder",
        description: "Writes and edits code for the user's projects.",
        instructions: "Reply to any message in one short sentence.",
      },
      steps: [{ fromPeer: scenario.ask }],
    };
  return {
    ...shared,
    botSetup: { instructions: CODER },
    peer: { ...SERVO, ...(setup.ownComputer ? { ownComputer: true as const } : {}) },
    steps: [{ ask: scenario.ask }],
  };
});
