/** Opt-in real-model fixtures, not an acceptance-rate benchmark. Creates native test
 * threads only; no Happy session writes or tools. Each sample leaves its root unchanged. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '../src/codex/codexAppServerClient';
import { createComposerPredictionHandlers } from '../src/codex/composerPrediction';
import type { ComposerPredictionResponse } from '@slopus/happy-wire';

const fixtures: Array<{ id: string; input: string; accepts: (result: ComposerPredictionResponse) => boolean }> = [
    {
        id: 'decision-with-fallback-and-boundary',
        input: '我想接入本机已安装的 DeepSeek Harness，微信群有人 @ 我后，结合上下文告诉我谁找我、什么事、需要我做什么。AI 失败也要正常收到原始提醒。先对齐目标和任务拆分，暂时不要写代码，也先不生成回复草稿。请给出 A 原始提醒、B 理解后提醒、C 辅助回复三个方案的简短对比，最后问我先做哪一个。不要使用工具。',
        accepts: result => result.status === 'ready' && /B|理解|上下文/.test(result.text ?? '')
            && /失败|原始|兜底/.test(result.text ?? '') && /暂|先|不要/.test(result.text ?? '') && /代码|目标|拆分/.test(result.text ?? ''),
    },
    {
        id: 'performance-investigation-before-editing',
        input: '输入预测已有了，但真实工程建议太泛，首次约 7 秒。我希望先确认提示词和推理档位各有什么影响；保持主模型和上下文不变，先做质量与延迟对照，不要先改线上配置。请给出简短的调查计划，最后询问我是否先用同一组工程对话比较 low 和 medium。不要使用工具。',
        accepts: result => result.status === 'ready' && /low/i.test(result.text ?? '') && /medium/i.test(result.text ?? '')
            && /质量|接受|有用/.test(result.text ?? '') && /延迟|耗时|时间/.test(result.text ?? '') && /线上|配置|主模型|上下文/.test(result.text ?? ''),
    },
    {
        id: 'finished-work-abstention',
        input: '这是离线对话文案演练：已确认修复完成、所有测试通过、部署也已验收，我没有其他待办要求。请只回复一句完成报告，不要增加问题或提出后续任务，不要使用工具。',
        accepts: result => result.status === 'none',
    },
];
const cwd = await mkdtemp(join(tmpdir(), 'paws-prediction-quality-'));
const client = new CodexAppServerClient();
let completedTurnId: string | undefined;
let rootStarts = 0;
client.setEventHandler(event => {
    if (event.type === 'task_complete' && typeof event.turn_id === 'string') completedTurnId = event.turn_id;
    if (event.type === 'task_started') rootStarts++;
});
client.setApprovalHandler(async () => 'denied');
const results: unknown[] = [];
try {
    await client.connect();
    for (const fixture of fixtures) {
        completedTurnId = undefined;
        const starts = rootStarts;
        const thread = await client.startThread({ model: 'gpt-6.1-sol', cwd, approvalPolicy: 'never', sandbox: 'read-only' });
        const turn = await client.sendTurnAndWait(fixture.input, { effort: 'low', turnTimeoutMs: 60_000 });
        if (turn.aborted || !completedTurnId) throw new Error(`Fixture root did not complete: ${fixture.id}`);
        const before = await client.readThread({ threadId: thread.threadId, includeTurns: true });
        const handlers = createComposerPredictionHandlers({ client, isBusy: () => false, onUnsupported() {} });
        const started = Date.now();
        const result = await handlers.request({ requestId: `quality-${fixture.id}`, sourceTurnId: completedTurnId });
        const elapsedMs = Date.now() - started;
        const after = await client.readThread({ threadId: thread.threadId, includeTurns: true });
        const rootHistoryUnchanged = JSON.stringify(before.thread.turns) === JSON.stringify(after.thread.turns);
        const singleRootStart = rootStarts - starts === 1;
        const passed = fixture.accepts(result) && rootHistoryUnchanged && singleRootStart;
        const row = { fixture: fixture.id, model: thread.model, effort: 'low', elapsedMs, result, rootHistoryUnchanged, singleRootStart, passed };
        results.push(row);
        console.log(JSON.stringify(row));
        if (!passed) process.exitCode = 1;
    }
    console.log(JSON.stringify({ fixtures: results.length, passed: !process.exitCode, note: 'Small authored fixtures; not a general quality or latency benchmark.' }));
} finally {
    await client.disconnect({ waitForExit: true });
    await rm(cwd, { recursive: true, force: true });
}
