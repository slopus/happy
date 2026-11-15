import type { Criterion, EvalCase } from "./cases.js";

export const GROUP_ROUTING_FIXTURE_VERSION = "group-routing-v2";

type Group = {
  /** Descriptions by member; the subject is always "Assistant", the first member. */
  roles: Record<string, string>;
  instructions?: Record<string, string>;
};

/** A team where every role has a clear owner, led by a generalist. */
const TEAM: Group = {
  roles: {
    Assistant: "Chief of staff: scheduling, meeting notes and general questions.",
    Mika: "Marketing: launch copy, social posts and campaigns.",
    Theo: "Engineering: code, bugs, deploys and technical questions.",
    Ines: "Finance: budgets, invoices and spending.",
    Ravi: "Customer support: refunds, customer tickets and help-center articles.",
  },
};

/** Two peers with no natural owner; each holds facts only it knows. */
const PENSIONS: Group = {
  roles: {
    Assistant: "Workplace pension: looks after the user's employer pension account.",
    Kai: "Personal pension: looks after the user's private pension account.",
  },
  instructions: {
    Assistant:
      "The user's workplace pension balance is £42,300. Its annual fee is 0.45%. The employer adds 5% of salary each month.",
    Kai: "The user's personal pension balance is £18,900. Its annual fee is 0.85%. Nobody else contributes to it.",
  },
};

type Scenario = {
  id: string;
  purpose: string;
  group: Group;
  ask: string;
  /** Members that must post. */
  owners?: string[];
  /** How many members may post. */
  posts: { min: number; max: number };
};

const SCENARIOS: Scenario[] = [
  {
    id: "routing-first-member-owns-it",
    purpose: "The first member answers its own work without other members joining in.",
    group: TEAM,
    ask: "Can you move my 3pm meeting with the design team to Thursday at the same time?",
    owners: ["Assistant"],
    posts: { min: 1, max: 1 },
  },
  {
    id: "routing-engineering-question",
    purpose: "A technical question reaches the engineer.",
    group: TEAM,
    ask: "Our deploy failed with a migration lock timeout. What should I check first?",
    owners: ["Theo"],
    posts: { min: 1, max: 2 },
  },
  {
    id: "routing-support-question",
    purpose: "A refund question reaches support.",
    group: TEAM,
    ask: "A customer on an annual plan wants a refund after 40 days. How should we reply to them?",
    owners: ["Ravi"],
    posts: { min: 1, max: 2 },
  },
  {
    id: "routing-one-answerer",
    purpose: "A request for one piece of work reaches its author.",
    group: TEAM,
    ask: "Can one of you write a one-line post announcing the launch?",
    owners: ["Mika"],
    posts: { min: 1, max: 2 },
  },
  {
    id: "routing-no-owner",
    purpose: "A question no role owns gets an answer without the whole group piling on.",
    group: TEAM,
    ask: "What's a good name for our team offsite in March?",
    posts: { min: 1, max: 2 },
  },
  {
    id: "routing-roll-call",
    purpose: "A message meant for every member reaches every member.",
    group: TEAM,
    ask: "Quick round: each of you, tell me one thing you can help with this week.",
    posts: { min: 4, max: 5 },
  },
  {
    id: "routing-greeting",
    purpose: "A greeting does not get a greeting from every member.",
    group: TEAM,
    ask: "Morning all!",
    posts: { min: 0, max: 2 },
  },
  {
    id: "routing-sign-off",
    purpose: "A sign-off needs at most one reply.",
    group: TEAM,
    ask: "Thanks everyone, that's all for today.",
    posts: { min: 0, max: 1 },
  },
  {
    id: "routing-peer-question",
    purpose: "A question about the second of two peers reaches that peer.",
    group: PENSIONS,
    ask: "What's the annual fee on my personal pension?",
    owners: ["Kai"],
    posts: { min: 1, max: 2 },
  },
  {
    id: "routing-peers-compare",
    purpose: "A question that needs both peers gets both of them.",
    group: PENSIONS,
    ask: "Compare my two pensions: which one charges the lower annual fee?",
    owners: ["Assistant", "Kai"],
    posts: { min: 2, max: 2 },
  },
];

export const GROUP_ROUTING_EVAL_CASES: EvalCase[] = SCENARIOS.map((scenario) => {
  const members = Object.keys(scenario.group.roles).filter((name) => name !== "Assistant");
  return {
    id: scenario.id,
    purpose: scenario.purpose,
    group: { members, roles: scenario.group.roles, instructions: scenario.group.instructions },
    connections: [],
    pauseEndsTurn: true,
    steps: [{ ask: scenario.ask, unaddressed: true }],
    grade: (e): Criterion[] => {
      const posted = Object.entries(e.memberReplies ?? {})
        .filter(([, text]) => text.trim())
        .map(([name]) => name);
      return [
        ...(scenario.owners ?? []).map((owner) => ({
          id: `${owner.toLowerCase()}-answered`,
          pass: posted.includes(owner),
        })),
        { id: `at-least-${scenario.posts.min}-posting`, pass: posted.length >= scenario.posts.min },
        { id: `at-most-${scenario.posts.max}-posting`, pass: posted.length <= scenario.posts.max },
      ];
    },
  };
});
