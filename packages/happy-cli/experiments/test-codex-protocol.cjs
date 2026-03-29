/**
 * Minimal Codex app-server protocol smoke test (current path).
 *
 * What this shows:
 * 1. Raw JSON-RPC handshake for app-server over stdio
 * 2. thread/start + turn/start request flow
 * 3. Completion signal via task_complete/turn_aborted notifications
 */

const { spawn } = require("child_process");
const { createInterface } = require("readline");

const proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", d => process.stderr.write(d));

const rl = createInterface({ input: proc.stdout });
let threadId = null;
let turnDone = false;
rl.on("line", (line) => {
    try {
        const msg = JSON.parse(line);
        if (msg.method) {
            const p = JSON.stringify(msg.params || {}).substring(0, 300);
            console.log(`[notif] ${msg.method} ${p}`);
        }
        if (msg.id === 1 && msg.result) {
            proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            proc.stdin.write(JSON.stringify({
                id: 2, method: "thread/start",
                params: { model: null, modelProvider: null, profile: null,
                    cwd: process.cwd(), approvalPolicy: null, sandbox: null,
                    config: null, baseInstructions: null, developerInstructions: null,
                    compactPrompt: null, includeApplyPatchTool: null }
            }) + "\n");
        }
        if (msg.id === 2 && msg.result) {
            threadId = msg.result.thread.id;
            console.log("[thread]", threadId);
            proc.stdin.write(JSON.stringify({
                id: 3, method: "turn/start",
                params: { threadId: threadId,
                    input: [{ type: "text", text: "Say exactly: hi. Nothing else. Do not use tools." }],
                    cwd: process.cwd(), approvalPolicy: "on-request",
                    sandboxPolicy: { type: "readOnly" }, model: "gpt-5.2-codex", effort: null,
                    summary: "auto", outputSchema: null }
            }) + "\n");
        }
        if (msg.id === 3) {
            console.log("[turn/start resp]", JSON.stringify(msg).substring(0, 200));
        }
        // Check for task_complete
        const eventType = msg.params?.msg?.type;
        if (eventType === "task_complete" || eventType === "turn_aborted") {
            console.log("[DONE]", eventType);
            turnDone = true;
            proc.kill("SIGTERM");
            setTimeout(() => process.exit(0), 500);
        }
    } catch {}
});

proc.stdin.write(JSON.stringify({
    id: 1, method: "initialize",
    params: { clientInfo: { name: "test", title: "test", version: "0.0.1" }, capabilities: null }
}) + "\n");

setTimeout(() => {
    if (!turnDone) console.log("TIMEOUT - no task_complete");
    proc.kill("SIGKILL");
    process.exit(0);
}, 30000);
