import type { GoalTask } from '@slopus/happy-wire';
export function reviewAttention(task: GoalTask) {
    return { decisions: task.review?.decisions.filter(item => !item.answer) ?? [], gaps: task.review?.gaps ?? [] };
}
export function buildRetrospectivePrompt(scopePath: string, tasks: GoalTask[]): string {
    if (!tasks.length) throw new Error('Select at least one task');
    return `请使用 goal-first-ops 和 goal-first 的复盘整理能力，读取 retrospective 协议及原任务会话、过程、报告和实际产物，仅整理下面明确选中的任务。范围目录：${scopePath}。不要扩展到未选任务。\n\n${tasks.map(task => `${task.id} · ${task.title}\n任务入口：${task.indexPath}`).join('\n\n')}\n\n先读取既有目标、范围和授权，用 paws goal-review inspect/apply 维护原任务的唯一记录；补齐预期交付、验收依据、实际最终产物，区分当前与历史版本。沿用已有明确认可并绑定实际产物版本；任务完成与产物认可分开，不能因没有认可就把已完成任务退回待验收。可依据证据修正包括手动设置的进度，保存前后值、原因和依据并支持撤回。\n\n只在确实阻碍本次整理时及时问我，其余疑点集中处理。先展示需要我判断的具体事项、建议与真实工作缺口，自动整理结果与修改依据可展开查看。不把字段缺失统一当成需处理。\n\n本次复盘只整理已有工作和列出缺口，不得补做实现、测试、生成、发布等业务工作，即使它在原授权范围内；由我另行启动。不得把 AI 判断或进度修改冒充我的认可。没有可读取的会话或证据要如实说明。完成后告诉我改了哪些原任务，以及还有哪些需要判断。`;
}
