import type { Criterion, EvalCase, Evidence } from "./cases.js";
import type { HistoryFixture, HistoryMessage } from "./history-fixtures.js";

export const SESSION_FIXTURE_VERSION = "history-session-v1";

/**
 * One ordinary working chat, short enough to fit any model many times over. The decisions the
 * last request depends on were made early; eleven unrelated small requests follow them. The last
 * request never says "remember" or "earlier" unless a person naturally would.
 */
const EXCHANGES: Array<[user: string, bot: string]> = [
  [
    "I'm getting the Harbor wholesale portal ready to launch. Can you help me keep things straight as we go?",
    "Yes. Send me things as they come up and I'll keep track.",
  ],
  [
    "Shipping first. I have three quotes for the launch-week pallets: Calder Logistics, 2 days, $1,610. Northwind Freight, 4 days, $1,240. Pelican Express, next day, $2,075. Lay them out for me.",
    "Option 1: Calder Logistics, 2 days, $1,610.\nOption 2: Northwind Freight, 4 days, $1,240.\nOption 3: Pelican Express, next day, $2,075.\n\nNorthwind is cheapest; Pelican only makes sense if the pallets are late.",
  ],
  [
    "Parking shipping for now. Give me a five step rollout plan with an owner for each step.",
    "Step 1: Freeze catalog prices (you).\nStep 2: Import the wholesale accounts (Marco).\nStep 3: Send invite emails to the pilot accounts (you).\nStep 4: Run the rollback drill on the staging portal (Priya).\nStep 5: Switch DNS and announce (Marco).",
  ],
  ["Good. Launch date is March 14.", "Noted: launch is March 14."],
  [
    "For any SQL you write me: use the reporting schema rpt_v3 and its orders_daily table. Never query orders directly, that is the live table and finance gets upset.",
    "Understood. I'll use rpt_v3.orders_daily and leave the live orders table alone.",
  ],
  [
    "Change of plan: Priya is away on the 14th, so launch moves to March 21. Everything else stays.",
    "Updated: launch is now March 21. The plan and owners are unchanged.",
  ],
  [
    "Make this friendlier: 'Your account has been provisioned and credentials will follow.'",
    "Your account is ready, and we'll send your login details shortly.",
  ],
  ["What is 9am Pacific in Lisbon?", "5pm in Lisbon, on the same day."],
  [
    "Three subject lines for the pilot invite email, short ones.",
    "1. Your wholesale portal is ready\n2. Order from us in two clicks\n3. An early look at our new portal",
  ],
  [
    "Explain a CNAME record to me in one sentence, I have to sound competent on a call.",
    "A CNAME record points one domain name at another, so the second name decides where traffic goes.",
  ],
  [
    "Shorten this FAQ answer: 'In the event that you are unable to locate your invoice, you may request a copy by contacting our support team during business hours.'",
    "Can't find an invoice? Ask support for a copy during business hours.",
  ],
  [
    "Write a polite no to a vendor who keeps asking for a demo slot.",
    "Thanks for following up. We aren't looking at new tools this quarter, so I'll pass for now and reach out if that changes.",
  ],
  [
    "Checklist for tomorrow's product photo shoot, five items max.",
    "1. Charged camera and spare battery\n2. Clean backdrop\n3. Product samples, unopened\n4. Shot list\n5. Tape and clips",
  ],
  ["What is 18 kg in pounds?", "About 39.7 pounds."],
  ["Name ideas for the top loyalty tier, three of them.", "Reserve, Founders Circle, First Pour."],
  [
    "Agenda for Thursday's standup, keep it to three points.",
    "1. What shipped since Tuesday\n2. What is blocked\n3. Who needs help before Friday",
  ],
  ["One more: a two-word name for the internal newsletter.", "Harbor Notes."],
];

type SessionScenario = "sql" | "option" | "plan" | "date";

const ASKS: Record<SessionScenario, string> = {
  sql: "Write me the SQL for total order value by region for last week.",
  option:
    "Let's book the second shipping option. Draft a two-line confirmation to them with their name and the quoted price.",
  plan: "Step 3 is done. What is step 4, and who owns it?",
  date: "Write a one-line announcement for the team channel with the launch date.",
};

function sessionFixture(scenario: SessionScenario): HistoryFixture {
  // The chat ends a few minutes ago: old timestamps make the bot treat its dates as past.
  const start = Date.now() - (EXCHANGES.length * 4 + 5) * 60_000;
  const messages = EXCHANGES.flatMap(([user, bot], index): HistoryMessage[] => [
    {
      seq: index * 2,
      role: "user",
      text: user,
      createdAt: new Date(start + index * 4 * 60_000),
    },
    {
      seq: index * 2 + 1,
      role: "bot",
      text: bot,
      createdAt: new Date(start + (index * 4 + 1) * 60_000),
    },
  ]);
  return {
    version: SESSION_FIXTURE_VERSION,
    messages,
    ask: ASKS[scenario],
    required: [],
    forbidden: [],
  };
}

const GRADERS: Record<SessionScenario, (text: string) => Criterion[]> = {
  sql: (text) => [
    { id: "reporting-schema", pass: /\brpt_v3\b/.test(text) },
    { id: "reporting-table", pass: /\borders_daily\b/.test(text) },
    { id: "no-live-table", pass: !/\b(?:from|join)\s+(?:\w+\.)?orders\b/i.test(text) },
  ],
  option: (text) => [
    { id: "vendor", pass: /northwind/i.test(text) },
    { id: "price", pass: /1,?240/.test(text) },
    { id: "no-other-quote", pass: !/1,?610|2,?075/.test(text) },
  ],
  plan: (text) => [
    { id: "step", pass: /rollback drill/i.test(text) },
    { id: "owner", pass: /priya/i.test(text) },
  ],
  date: (text) => [
    { id: "current-date", pass: /\bmar(?:ch|\.)?\s+21|\b21(?:st)?\s+(?:of\s+)?mar/i.test(text) },
  ],
};

const historyTool = (name: string) => name === "search_history" || name === "read_history";

/** A short working chat whose last request depends on decisions older than the recent window. */
export const SESSION_EVAL_CASES: EvalCase[] = (["sql", "option", "plan", "date"] as const).map(
  (scenario) => {
    const fixture = sessionFixture(scenario);
    return {
      id: `history-session-${scenario}`,
      purpose: `Short working chat: the request depends on an earlier ${scenario} decision`,
      history: fixture,
      connections: [],
      steps: [{ ask: fixture.ask }],
      grade: (e: Evidence) => [
        ...GRADERS[scenario](e.text),
        {
          id: "no-external-writes",
          pass: e.calls.every((call) => call.outcome === "read" || call.outcome === "rejected"),
        },
      ],
      observe: (e: Evidence) => ({
        "looked-up-history": e.toolCalls.some((call) => historyTool(call.name)),
      }),
    };
  },
);
