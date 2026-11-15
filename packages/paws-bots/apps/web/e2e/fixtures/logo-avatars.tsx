import type { ProductEvent } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { LogoAvatarActivity } from "@rakazo/core";
import {
  createLogoAvatarActivityStore,
  initialLogoAvatarSignals,
  logoAvatarActivity,
  logoAvatarTraits,
  reduceLogoAvatarSignals,
  seededLogoAvatarColor,
} from "@rakazo/core";
import { BotAvatar, BotAvatarActivityProvider, Button, LogoAvatar } from "@rakazo/ui-web";
import { Fragment, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
const officialMark = new URL("../../../www/public/brand/rakazo-mark.png", import.meta.url).href;
const team = [
  { id: "inbox-01", name: "Inbox", color: "orange" },
  { id: "scout-02", name: "Scout", color: "green" },
  { id: "studio-03", name: "Studio", color: "violet" },
  { id: "atlas-04", name: "Atlas", color: "blue" },
  { id: "ledger-05", name: "Ledger", color: "yellow" },
  { id: "muse-06", name: "Muse", color: "magenta" },
].map((bot) => ({ ...bot, value: BOT_COLOR_LIST.find((color) => color.id === bot.color)!.hex }));
const poses = [
  {
    activity: "idle",
    name: "Idle",
    detail: "Mostly still + a quiet blink",
    signal: "No active run",
  },
  {
    activity: "reading",
    name: "Reading",
    detail: "Read three lines, turn the page",
    signal: "read_file / web_fetch",
  },
  {
    activity: "writing",
    name: "Writing",
    detail: "Eyes down, keys in rhythm",
    signal: "Streamed reply / write_file",
  },
  {
    activity: "thinking",
    name: "Thinking",
    detail: "Glance, consider, look again",
    signal: "Reported reasoning stream",
  },
  {
    activity: "computer",
    name: "Computer use",
    detail: "Point, click, select",
    signal: "Active computer / browser tool",
  },
] as const;
const portrait = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#a9d6e8"/><circle cx="24" cy="22" r="11" fill="#d7a17d"/><path d="M4 48c2-10 9-15 20-15s18 5 20 15" fill="#31465d"/></svg>')}`;

type Sample = { label: string; type: ProductEvent["type"]; payload?: ProductEvent["payload"] };
const samples: Sample[] = [
  { label: "Start run", type: "run.started", payload: { trigger: "user" } },
  { label: "Thinking starts", type: "thread.meta", payload: { activity: { thinking: true } } },
  { label: "Thinking ends", type: "thread.meta", payload: { activity: { thinking: false } } },
  {
    label: "Read file",
    type: "agent.tool.called",
    payload: { name: "read_file", executionId: "read-1" },
  },
  {
    label: "Finish reading",
    type: "agent.tool.completed",
    payload: { name: "read_file", executionId: "read-1", outcome: "succeeded" },
  },
  {
    label: "Stream reply",
    type: "thread.progress",
    payload: { delta: "Here is the summary.", streaming: true },
  },
  {
    label: "Use computer",
    type: "agent.tool.called",
    payload: { name: "computer_act", executionId: "computer-1" },
  },
  { label: "Ask for input", type: "run.waiting_input" },
  { label: "Resume run", type: "run.started", payload: { trigger: "resume" } },
  { label: "Run fails", type: "run.failed", payload: { error: "Example failure" } },
  { label: "Restart", type: "run.started", payload: { trigger: "user" } },
  { label: "Interrupt", type: "run.cancelled" },
];

function Study() {
  const [selected, setSelected] = useState<LogoAvatarActivity>("reading");
  const [teamActivity, setTeamActivity] = useState<LogoAvatarActivity>("reading");
  const [rerenders, setRerenders] = useState(0);
  const [motion, setMotion] = useState(params.get("still") !== "1");
  const [signals, setSignals] = useState(() => initialLogoAvatarSignals("prototype-bot"));
  const [eventName, setEventName] = useState("No event");
  const activity = logoAvatarActivity(signals);
  const send = (sample: Sample) => {
    setSignals((previous) =>
      reduceLogoAvatarSignals(previous, {
        threadId: "demo-thread",
        botId: "prototype-bot",
        runId: "demo-run",
        seq: previous.cursor + 1,
        type: sample.type,
        payload: sample.payload ?? {},
      }),
    );
    setEventName(sample.type);
  };
  return (
    <main className="mx-auto max-w-[1260px] p-8 text-foreground" data-rerenders={rerenders}>
      <header className="mb-7 flex items-center justify-between gap-5 border-b border-border pb-6">
        <div className="flex items-center gap-4">
          <img src={officialMark} alt="Official Rakazo logo" className="size-14 rounded-xl" />
          <div>
            <p className="mb-1 text-label text-muted-foreground">RAKAZO · LOGO AVATAR STUDY</p>
            <h1 className="text-heading2 font-semibold">Different colours. Their own rhythm.</h1>
          </div>
        </div>
        <div className="flex items-center gap-3 text-label text-muted-foreground">
          <span>Local prototype · {theme}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMotion(!motion)}
            aria-pressed={!motion}
          >
            {motion ? "Pause motion" : "Play motion"}
          </Button>
        </div>
      </header>
      <section
        aria-label="Independent bots in the same state"
        className="mb-6 rounded-2xl border border-border bg-card p-5"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-body-lg font-medium">Same activity, independent timing</h2>
            <p className="mt-1 text-label text-muted-foreground">
              All six are {teamActivity === "computer" ? "using the computer" : teamActivity}.
              Stable identity, colour and rhythm.
            </p>
          </div>
          <div className="flex gap-1">
            {poses
              .filter((pose) => pose.activity !== "idle")
              .map((pose) => (
                <Button
                  key={pose.activity}
                  variant={teamActivity === pose.activity ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={teamActivity === pose.activity}
                  onClick={() => setTeamActivity(pose.activity)}
                  aria-label={`Team: ${pose.name}`}
                >
                  {pose.name}
                </Button>
              ))}
          </div>
        </div>
        <div className="grid grid-cols-6 gap-4" data-testid="same-state-bots">
          {team.map((bot) => (
            <div className="text-center" key={bot.id}>
              <div className="flex items-end justify-center gap-3">
                <LogoAvatar
                  identity={bot.id}
                  avatarValue={bot.value}
                  activity={teamActivity}
                  size={76}
                  motion={motion}
                  label={`${bot.name} ${teamActivity}`}
                />
                <LogoAvatar
                  identity={bot.id}
                  avatarValue={bot.value}
                  activity={teamActivity}
                  size={38}
                  motion={motion}
                />
              </div>
              <p className="mt-3 text-body-sm font-medium">{bot.name}</p>
              <p className="text-caption text-muted-foreground">76 / 38 px</p>
            </div>
          ))}
        </div>
      </section>
      <section aria-label="Requested expressions" className="grid grid-cols-5 gap-4">
        {poses.map((pose, index) => (
          <article
            className="flex flex-col items-center rounded-2xl border border-border bg-card px-3 pb-5 pt-6"
            key={pose.activity}
          >
            <LogoAvatar
              identity={team[index]!.id}
              avatarValue={team[index]!.value}
              activity={pose.activity}
              size={126}
              motion={motion}
              label={pose.name}
            />
            <h2 className="mb-1 mt-4 text-heading3 font-medium">{pose.name}</h2>
            <p className="text-center text-label text-muted-foreground">{pose.detail}</p>
            <div className="my-4 flex items-end justify-center gap-3" aria-hidden="true">
              {[38, 32, 24].map((size) => (
                <LogoAvatar
                  key={size}
                  identity={team[index]!.id}
                  avatarValue={team[index]!.value}
                  activity={pose.activity}
                  size={size}
                  motion={motion}
                />
              ))}
            </div>
            <p className="text-caption text-muted-foreground">38 / 32 / 24 px</p>
            <p className="mt-4 border-t border-border pt-3 text-center text-caption text-muted-foreground">
              {pose.signal}
            </p>
          </article>
        ))}
      </section>
      <section
        className="mt-6 grid grid-cols-[1fr_1fr] gap-5"
        aria-label="Transitions and runtime events"
      >
        <article className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-body-lg font-medium">Pose switcher</h2>
            <span className="text-caption text-muted-foreground">Demonstration only</span>
          </div>
          <div className="mb-5 flex flex-wrap gap-1.5">
            {poses.map((pose) => (
              <Button
                key={pose.activity}
                size="sm"
                variant={selected === pose.activity ? "secondary" : "ghost"}
                onClick={() => setSelected(pose.activity)}
                aria-pressed={selected === pose.activity}
              >
                {pose.name}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-4 rounded-xl bg-background p-4">
            <LogoAvatar
              activity={selected}
              identity="inbox-01"
              avatarValue={team[0]!.value}
              size={64}
              motion={motion}
              label={`Selected pose: ${selected}`}
            />
            <div>
              <p className="text-body-lg font-medium">Inbox</p>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {selected === "thinking"
                  ? "Thinking pose preview"
                  : `${selected.charAt(0).toUpperCase()}${selected.slice(1)} preview`}
              </p>
            </div>
            <div className="ms-auto">
              <LogoAvatar
                activity={selected}
                identity="inbox-01"
                avatarValue={team[0]!.value}
                size={26}
                motion={motion}
              />
            </div>
          </div>
        </article>
        <article className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-body-lg font-medium">Real event format → expression</h2>
            <span className="text-caption text-muted-foreground">
              Fixture replay · no live connection
            </span>
          </div>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {samples.map((sample) => (
              <Button key={sample.label} size="sm" variant="ghost" onClick={() => send(sample)}>
                {sample.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-3" role="status">
            <LogoAvatar
              activity={activity}
              identity="prototype-bot"
              avatarValue={team[3]!.value}
              size={48}
              motion={motion}
            />
            <div>
              <p className="text-body-lg font-medium" data-testid="resolved-activity">
                {activity}
              </p>
              <p
                className="mt-1 font-mono text-caption text-muted-foreground"
                data-testid="event-source"
              >
                {eventName}
              </p>
            </div>
          </div>
        </article>
      </section>
      <section
        className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-border px-5 py-4"
        aria-label="Quiet states and custom avatars"
      >
        <div className="flex items-center gap-3">
          <LogoAvatar
            activity="waiting"
            identity="quiet-1"
            avatarValue={team[2]!.value}
            size={38}
            motion={motion}
          />
          <div>
            <p className="text-body-sm">Waiting on you</p>
            <p className="text-caption text-muted-foreground">Still, attentive</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <LogoAvatar
            activity="error"
            identity="quiet-2"
            avatarValue={team[3]!.value}
            size={38}
            motion={motion}
          />
          <div>
            <p className="text-body-sm">Error</p>
            <p className="text-caption text-muted-foreground">Still; no flashing</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <LogoAvatar
            activity="writing"
            identity="quiet-3"
            avatarValue={team[1]!.value}
            size={38}
            motion={false}
          />
          <div>
            <p className="text-body-sm">Reduced motion</p>
            <p className="text-caption text-muted-foreground">Static state pose</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BotAvatar color={portrait} avatarSet="rakazo" size={38} />
          <BotAvatar color="#8B5CF6::shape_3" avatarSet="rakazo" size={38} />
          <span className="text-caption text-muted-foreground">
            Custom avatars
            <br />
            kept intact
          </span>
        </div>
      </section>
      <footer className="mt-5 flex justify-between gap-4 text-caption text-muted-foreground">
        <span>
          Original logo artwork. Seeded CSS motion; pauses offscreen. Controls replay fixture
          states.
        </span>
        <span>Unknown work stays “working”. Thinking follows reported reasoning events.</span>
      </footer>
      <details className="mt-4 text-caption text-muted-foreground">
        <summary>Timing details</summary>
        <div className="mt-2 flex flex-wrap gap-5">
          {team.map((bot) => {
            const traits = logoAvatarTraits(bot.id, bot.value);
            return (
              <span key={bot.id}>
                {bot.name}: blink {traits.blinkMs} ms, offset {traits.blinkDelayMs} ms
              </span>
            );
          })}
        </div>
      </details>
      <Button
        size="sm"
        variant="ghost"
        className="mt-3"
        onClick={() => setRerenders((value) => value + 1)}
      >
        Rerender preview
      </Button>
    </main>
  );
}

function SizeComparison() {
  const fixedPose = poses.find((pose) => pose.activity === params.get("same"));
  const samples = fixedPose
    ? team.map(() => fixedPose)
    : [...poses, { ...poses[3], name: "Thinking · Muse" }];
  return (
    <main className="bg-background p-5 text-foreground" style={{ width: 1120, height: 350 }}>
      <header className="mb-5 flex items-baseline justify-between border-b border-border pb-3">
        <h1 className="text-heading3 font-semibold">
          {params.get("revision") || "Local prototype"} · {theme}
        </h1>
        <p className="text-label text-muted-foreground">
          Native 24 / 32 / 38 px below · 104 px detail above
        </p>
      </header>
      <section className="grid grid-cols-6 gap-3" aria-label="Avatar size comparison">
        {samples.map((pose, index) => (
          <article
            key={`${pose.name}-${index}`}
            className="flex flex-col items-center rounded-xl border border-border bg-card py-3"
          >
            <h2 className="mb-3 text-body-sm font-medium">{pose.name}</h2>
            <LogoAvatar
              identity={team[index]!.id}
              avatarValue={team[index]!.value}
              activity={pose.activity}
              size={104}
              label={pose.name}
            />
            <div className="mt-4 flex items-end gap-3">
              {[24, 32, 38].map((size) => (
                <div className="text-center" key={size}>
                  <LogoAvatar
                    identity={team[index]!.id}
                    avatarValue={team[index]!.value}
                    activity={pose.activity}
                    size={size}
                  />
                  <p className="mt-1 text-caption text-muted-foreground">{size}</p>
                </div>
              ))}
            </div>
            {pose.activity === "thinking" && (
              <p className="mt-2 text-caption text-muted-foreground">Demo pose</p>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}

function NativeSizeStrip() {
  const samples = [...poses, { ...poses[3], name: "Thinking B" }];
  return (
    <main className="bg-background p-4 text-foreground" style={{ width: 650, height: 300 }}>
      <h1 className="mb-4 text-body-lg font-semibold">
        {params.get("revision") || "Local prototype"} · native 1× avatars · {theme}
      </h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "44px repeat(6, 1fr)",
          alignItems: "center",
          textAlign: "center",
          gap: 8,
        }}
      >
        <span />
        {samples.map((pose) => (
          <span key={pose.name} className="text-caption text-muted-foreground">
            {pose.name}
          </span>
        ))}
        {[24, 32, 38].map((size) => (
          <Fragment key={size}>
            <span className="text-label text-muted-foreground">{size}px</span>
            {samples.map((pose, index) => (
              <div className="flex h-12 items-center justify-center" key={pose.name}>
                <LogoAvatar
                  identity={team[index]!.id}
                  avatarValue={team[index]!.value}
                  activity={pose.activity}
                  size={size}
                  label={`${pose.name} ${size}px`}
                />
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      <p className="mt-3 text-caption text-muted-foreground">
        State selection is a fixture. Each image pixel is one CSS pixel.
      </p>
    </main>
  );
}

function SeededFleet() {
  const compact = params.has("compact");
  const count = Math.max(1, Math.min(500, Number(params.get("count")) || 18));
  const [activity, setActivity] = useState<LogoAvatarActivity>("reading");
  const [renders, setRenders] = useState(0);
  const [showFleet, setShowFleet] = useState(true);
  const bots = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => {
        const id = `seed-bot-${index}`;
        return { id, color: seededLogoAvatarColor(id) };
      }),
    [count],
  );
  const source = useMemo(() => createLogoAvatarActivityStore(), []);
  return (
    <BotAvatarActivityProvider source={source}>
      <main className="mx-auto max-w-[1140px] p-6 text-foreground" data-renders={renders}>
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-heading2 font-semibold">Seeded Rakazo colours</h1>
            <p className="mt-1 text-label text-muted-foreground">
              {compact
                ? "Live status fallback · compact list"
                : "Persistent identity · stable colour and independent motion"}{" "}
              · {theme}
            </p>
          </div>
          <Button variant="outline" onClick={() => setShowFleet((value) => !value)}>
            {showFleet ? "Hide fleet" : "Show fleet"}
          </Button>
          <Button variant="outline" onClick={() => setRenders((value) => value + 1)}>
            Rerender fleet
          </Button>
        </header>
        {!compact ? (
          <nav className="mb-5 flex gap-2" aria-label="Fixture state">
            {poses.map((pose) => (
              <Button
                key={pose.activity}
                variant={activity === pose.activity ? "secondary" : "ghost"}
                onClick={() => setActivity(pose.activity)}
              >
                {pose.name}
              </Button>
            ))}
          </nav>
        ) : null}
        <section
          data-testid="seeded-fleet"
          className={compact ? "space-y-2" : "grid grid-cols-6 gap-3"}
        >
          {(showFleet ? bots : []).map((bot) =>
            compact ? (
              <article
                key={bot.id}
                className="flex h-11 items-center gap-3 rounded-lg bg-card px-3"
              >
                <BotAvatar
                  color={bot.color}
                  identity={bot.id}
                  avatarSet="rakazo"
                  status="running"
                  size={32}
                />
                <span className="text-label">{bot.id}</span>
                <span className="text-caption text-muted-foreground">{bot.color}</span>
              </article>
            ) : (
              <article
                key={bot.id}
                className="rounded-2xl border border-border bg-card p-3 text-center"
              >
                <BotAvatar
                  color={bot.color}
                  identity={bot.id}
                  avatarSet="rakazo"
                  activity={activity}
                  size={88}
                  className="mx-auto"
                />
                <p className="mt-2 text-label">{bot.id}</p>
                <p className="text-caption text-muted-foreground">{bot.color}</p>
                <div className="mt-3 flex items-end justify-center gap-2">
                  {[24, 32, 38].map((size) => (
                    <div key={size}>
                      <BotAvatar
                        color={bot.color}
                        identity={bot.id}
                        avatarSet="rakazo"
                        activity={activity}
                        size={size}
                      />
                      <p className="mt-1 text-caption text-muted-foreground">{size}</p>
                    </div>
                  ))}
                </div>
              </article>
            ),
          )}
        </section>
      </main>
    </BotAvatarActivityProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  params.has("seeded") ? (
    <SeededFleet />
  ) : params.has("strip") ? (
    <NativeSizeStrip />
  ) : params.has("compare") ? (
    <SizeComparison />
  ) : (
    <Study />
  ),
);
