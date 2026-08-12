import type { Machine } from '@/sync/storageTypes';
import type { AgentLauncher } from './launchAgent';

export const APP_BUILDER_AGENT_ID = 'builtin:app-builder';
export const RELATIONSHIP_ADVISOR_AGENT_ID = 'builtin:relationship-advisor';

export function createRelationshipAdvisorAgent(options: { title: string; subtitle: string }): AgentLauncher {
    return {
        id: RELATIONSHIP_ADVISOR_AGENT_ID,
        name: options.title,
        glyph: '聊',
        color: '#D65A4A',
        machineId: '',
        path: options.subtitle,
        presets: [],
        kind: 'standard',
        spaceType: 'default',
        imageStyleIds: [],
        imageVariantsPerStyle: 1,
        runtime: 'relationship-advisor',
        builtin: true,
    };
}

// 内置 App 生成 agent 的两段预设不再内联整套工作流，而是「意图 + 加载 skill + 硬确认门」：
// app-flow（全局安装的引擎，按需拉 build/delivery/reviewer 子能力）驱动全程，
// happy-app-experience 提供本机自托管做法，gpt-image-2 委托 Codex 出图。
// 三个 skill 都已全局安装（~/.claude/skills/），会话启动即可被发现，无需 bootstrap 复制。
// 完整方法论沉淀在 skill 里、按需加载，不再一次性灌爆上下文。
// 设计见 docs/plans/2026-07-12-app-agent-skillify-design.md。
const APP_BUILDER_PROMPT = `我要从 0 到 1 做一款独立 App。请加载 app-flow skill，按它的薄驾驭层驱动全程
（它会按需拉起 app-flow-build / app-flow-delivery / app-flow-reviewer 三个子能力）。

配套 skill：
- 涉及 Happy 自托管 OTA、OSS/FC、runtimeVersion 约定、APK/Release 边界等本机具体做法，
  加载 happy-app-experience skill 参考（它只提供经验，不强制技术栈）。
- 需要 App 图标/splash/插画/空状态/营销图时，用 gpt-image-2 skill 生成
  （对 Claude Code 它会委托 Codex 出图）。

仓库自包含：独立项目建好后，把 app-flow / app-flow-build / app-flow-delivery / app-flow-reviewer
四个 skill 从 ~/.claude/skills/ 复制进「新项目/.claude/skills/」（源是符号链接，用 cp -RL
解引用成真实文件），让仓库自带这套工作流。

硬确认门：先与我确认 App 名称/包名/首版本/runtimeVersion 和核心场景再动手；
push、GitHub Release、production OTA、部署 FC 等外部动作，先说明命令与影响并等我确认。`;

const APP_BUGFIX_PROMPT = `我要修这款 App 的问题，用 app-flow 驱动，走「只读诊断 → 最小修复」。

启动：
1. 先确认当前工作目录就是目标 App 项目（不是就先切进该项目再继续）。
2. 加载 app-flow skill；先用日志/测试/manifest/复现锁定根因，别猜，再做最小修复。
3. 涉及 OTA / OSS/FC / channel / runtimeVersion / APK / Release，加载 happy-app-experience 参考。
4. 修完跑相关静态检查/测试；涉及 OTA 先发 preview 并核对 manifest；
   production OTA 或 APK Release 前先与我确认。`;

function getMachineName(machine: Machine | undefined): string {
    if (!machine) return '';
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id;
}

function pickMachine(machines: Machine[], preferredMachineId?: string | null): Machine | undefined {
    if (preferredMachineId) {
        const preferred = machines.find((m) => m.id === preferredMachineId);
        if (preferred) return preferred;
    }
    return machines.find((m) => m.active) ?? machines[0];
}

export function createAppBuilderAgent(options: {
    machines: Machine[];
    preferredMachineId?: string | null;
    preferredPath?: string | null;
    title: string;
    presetBuildLabel: string;
    presetBugfixLabel: string;
}): AgentLauncher | null {
    const machine = pickMachine(options.machines, options.preferredMachineId);
    if (!machine) return null;

    return {
        id: APP_BUILDER_AGENT_ID,
        name: options.title,
        glyph: 'A',
        color: '#0F766E',
        machineId: machine.id,
        path: options.preferredPath || machine.metadata?.homeDir || '~',
        kind: 'standard',
        spaceType: 'default',
        imageStyleIds: [],
        imageVariantsPerStyle: 1,
        presets: [
            { label: options.presetBuildLabel, prompt: APP_BUILDER_PROMPT },
            { label: options.presetBugfixLabel, prompt: APP_BUGFIX_PROMPT },
        ],
        agentType: 'claude',
        permissionMode: 'bypassPermissions',
        modelMode: 'default',
        effortLevel: null,
        builtin: true,
    };
}

export function getAgentSubtitle(agent: AgentLauncher, machine: Machine | undefined, machineMissing: string): string {
    const machineLabel = machine ? getMachineName(machine) : machineMissing;
    return `${machineLabel} · ${agent.path}`;
}
