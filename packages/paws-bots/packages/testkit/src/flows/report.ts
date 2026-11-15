import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowResult } from "./runner.js";

type Report = FlowResult & { sandbox: string; botModel?: string; userModel?: string };

const html = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );

/** Stitches the distinct frames into a video, holding each until the next change (capped). */
export function writeScreenVideo(dir: string, frames: FlowResult["frames"]): string | undefined {
  if (frames.length < 2) return undefined;
  const lines = frames.flatMap((frame, index) => {
    const next = frames[index + 1];
    const seconds = next ? (Date.parse(next.at) - Date.parse(frame.at)) / 1000 : 2;
    return [`file '${frame.file}'`, `duration ${Math.min(Math.max(seconds, 0.4), 3).toFixed(2)}`];
  });
  // The concat demuxer ignores the last duration unless the file repeats.
  lines.push(`file '${frames.at(-1)!.file}'`);
  writeFileSync(path.join(dir, "frames.txt"), `${lines.join("\n")}\n`);
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "frames.txt",
        "-vf",
        "scale=1280:-2,format=yuv420p",
        "-r",
        "10",
        "screen.mp4",
      ],
      { cwd: dir, stdio: "pipe", timeout: 120_000 },
    );
    return "screen.mp4";
  } catch {
    // ffmpeg is optional; the timeline still has every frame.
    return undefined;
  }
}

/** One page: verdict, checks, the screen video, then chat and screen frames on one timeline. */
export function htmlReport(report: Report, video: string | undefined) {
  const items = [
    ...report.transcript.map((entry) => ({ at: entry.at, kind: "chat" as const, entry })),
    ...report.frames.map((frame) => ({ at: frame.at, kind: "frame" as const, frame })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const start = Date.parse(items[0]?.at ?? new Date().toISOString());
  const clock = (at: string) => {
    const seconds = Math.max(0, Math.round((Date.parse(at) - start) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const timeline = items
    .map((item) =>
      item.kind === "chat"
        ? `<div class="msg ${item.entry.from}"><span class="t">${clock(item.at)} ${item.entry.from === "user" ? "Person" : "Bot"}${item.entry.wake ? ` · routine wake ${item.entry.wake}` : ""}</span><div class="bubble">${html(item.entry.text)}</div></div>`
        : `<figure><span class="t">${clock(item.at)} screen</span><a href="${item.frame.file}"><img loading="lazy" src="${item.frame.file}" alt="Bot screen at ${clock(item.at)}"></a></figure>`,
    )
    .join("\n");
  const checks = [
    ...report.criteria.map(
      (c) =>
        `<li class="${c.pass ? "pass" : "fail"}">${c.pass ? "✓" : "✗"} ${html(c.id)}${c.detail ? ` <small>${html(c.detail)}</small>` : ""}</li>`,
    ),
    ...(report.judgment
      ? [
          `<li class="${report.judgment.pass ? "pass" : "fail"}">${report.judgment.pass ? "✓" : "✗"} judge <small>${html(report.judgment.reason)}</small></li>`,
        ]
      : []),
  ].join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${html(report.flow)}: ${report.status}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#111}
h1{margin:0 0 4px}.meta{color:#555;margin-bottom:16px}ul{padding-left:0;list-style:none}
li{margin:3px 0}.pass{color:#166534}.fail{color:#b91c1c}small{color:#555}
video{width:100%;border:1px solid #ddd;border-radius:8px;margin:12px 0}
.msg{display:flex;flex-direction:column;margin:10px 0}.msg.user{align-items:flex-end}
.bubble{white-space:pre-wrap;padding:10px 14px;border-radius:14px;max-width:75%;background:#f1f1f1}
.msg.user .bubble{background:#111;color:#fff}.t{font-size:12px;color:#777;margin:0 4px 2px}
figure{margin:10px 0}figure img{width:480px;border:1px solid #ddd;border-radius:6px;display:block}
</style>
<h1>${html(report.flow)}: ${report.status}</h1>
<div class="meta">${html(report.sandbox)} · bot ${html(report.botModel ?? "")} · person ${html(report.userModel ?? "")} · ended by ${report.endedBy} after ${Math.round(report.durationMs / 1000)}s · ${report.toolCalls} tool calls · bot cost $${report.botCostUsd.toFixed(3)}${report.error ? ` · error: ${html(report.error)}` : ""}</div>
<ul>${checks}</ul>
${video ? `<video controls src="${video}"></video>` : ""}
<h2>Timeline</h2>
${timeline}
`;
}
