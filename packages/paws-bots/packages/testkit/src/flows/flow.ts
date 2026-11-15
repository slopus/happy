import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { JudgeInput } from "../evals/judge.js";

export type Criterion = { id: string; pass: boolean; detail?: string };

/** What a flow can reach while it sets up and grades: the bot's real computer. */
export type FlowComputer = {
  sandbox: SandboxProvider;
  computer: ComputerRef;
  context: AdapterContext;
};

export type TranscriptEntry = {
  from: "user" | "bot";
  text: string;
  /** The routine wake that produced this bot message, counted from 1. */
  wake?: number;
  /** Set on the person's answer to a card asking to approve one of the bot's tool calls. */
  toolApproval?: boolean;
  at: string;
};

export type FlowEvidence<World> = {
  world: World;
  transcript: TranscriptEntry[];
  routines: Array<{
    name: string;
    prompt: string;
    crons: string[];
    active: boolean;
    timezone: string;
    /** When the routine next runs, as stored; a start date the bot chose lives here. */
    nextRunAt: string | null;
  }>;
  toolNames: string[];
  /** Site or computer state the flow reads after each phase, keyed by phase name. */
  observations: Record<string, unknown>;
  endedBy: "user-done" | "turn-limit" | "deadline" | "spend-cap" | "takeover" | "error";
};

/**
 * A flow is a goal a simulated person pursues with a bot over a real computer.
 * The flow owns its world (sites, accounts, hidden facts), the person's brief,
 * and how the outcome is graded. Nothing in it scripts the bot's actions.
 */
export type Flow<World = unknown> = {
  id: string;
  purpose: string;
  setup(computer: FlowComputer): Promise<World>;
  /** Who the simulated person is and what they want; hidden from the bot. */
  persona(world: World): string;
  /** The person's IANA timezone, adopted on first sign-in as the web app does. */
  timezone: string;
  /** Facts that change while the flow runs, such as a code texted to the person's phone. */
  liveFacts?(computer: FlowComputer, world: World): Promise<string | undefined>;
  /** Routine wakes to force after the conversation, standing in for real time passing. */
  routineWakes?: number;
  /**
   * Only force a wake when the routine is due this soon. The bot's clock does not move, so a
   * routine the bot scheduled further out is left alone rather than run early.
   */
  wakeHorizonMs?: number;
  /** Called after the conversation and after each wake; returns state to keep as evidence. */
  observe(computer: FlowComputer, world: World): Promise<unknown>;
  grade(evidence: FlowEvidence<World>): Criterion[];
  judge?(evidence: FlowEvidence<World>): JudgeInput;
  /** Reviewed judge inputs with the expected verdict; the judge must agree before it grades. */
  judgeCalibration?: Array<{ input: JudgeInput; pass: boolean }>;
};

export const check = (id: string, pass: boolean, detail?: string): Criterion => ({
  id,
  pass,
  ...(detail ? { detail } : {}),
});

export async function runCommand(
  { sandbox, computer, context }: FlowComputer,
  script: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let code = -1;
  let stdout = "";
  let stderr = "";
  for await (const event of sandbox.execute(computer, { argv: ["bash", "-lc", script] }, context)) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else if (event.type === "exit") code = event.code;
  }
  return { code, stdout, stderr };
}
