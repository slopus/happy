/**
 * Claude remote 모드용 SDK sandbox 설정.
 *
 * remote 는 daemon 이 띄우는 기본 모드인데, happy 의 sandbox-runtime 래핑은
 * local(claudeLocal) 경로에만 있다. remote 의 유일한 격리 입력은 SDK 의
 * `sandbox` 옵션이고 지금까지 그 값은 checkpoint 보호 세션에서만 채워졌다.
 * 그래서 공유 머신 remote 세션에서 `sandboxConfig.enabled: true` 는 격리를
 * 주지 않고 permissionMode 를 bypassPermissions 로 바꾸는 값이었다
 * (claude/utils/permissionMode.ts). 그 조합이 이 파일이 닫는 구멍이다.
 *
 * 개인 머신(owner-choice)에는 이 설정을 걸지 않는다. 지금까지 일반 remote 세션은
 * SDK 샌드박스 없이 돌았고, 여기서 켜면 개인 사용자의 기존 동작이 바뀐다.
 * checkpoint 세션이 이미 만든 설정은 그대로 둔다.
 *
 * 이 경계가 무엇인지 정확히: SDK 의 `sandbox` 는 Claude Code CLI 자신의 샌드박스
 * 설정으로 내려가며(설치된 SDK 0.3.179 가 런타임에서 소비하는 것을 확인),
 * 주 대상은 Bash 실행 경계다. **CLI 프로세스 전체의 OS 경계가 아니다** — Read/
 * Write/MCP 를 포함한 전 도구가 이 filesystem 값으로 막힌다고 단정하면 안 된다.
 * mandatory remote 의 전체 프로세스 경계는 claudeProcessSandbox.ts 가 맡는다.
 * query 전에 래퍼를 준비하고 spawnClaudeCodeProcess 에 연결한다. 이 파일의
 * filesystem 제약도 바깥 경계에 합치며, 중첩 SDK sandbox 는 켜지 않는다.
 */
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig, resolveSandboxTrustFloor } from './config';
import { MandatorySandboxError, type SandboxPolicyMode } from './sandboxPolicy';

export function buildClaudeRemoteSandboxSettings(input: {
    sandboxConfig: SandboxConfig | undefined;
    sessionPath: string;
    policyMode: SandboxPolicyMode;
}): SandboxSettings | undefined {
    const mandatory = input.policyMode === 'mandatory';
    // 개인 머신의 기존 remote 동작을 바꾸지 않는다.
    if (!mandatory) return undefined;
    if (input.sandboxConfig === undefined) {
        if (mandatory) throw new MandatorySandboxError('missing-config');
        return undefined;
    }
    if (input.sandboxConfig.enabled !== true) {
        if (mandatory) throw new MandatorySandboxError('disabled-config');
        return undefined;
    }

    const runtime = buildSandboxRuntimeConfig(
        input.sandboxConfig,
        input.sessionPath,
        input.policyMode,
    );
    return {
        enabled: true,
        // 공유 머신에서는 샌드박스를 못 쓰면 뜨지 않는 것이 요구사항이다.
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        enableWeakerNetworkIsolation: runtime.enableWeakerNetworkIsolation,
        network: runtime.network,
        filesystem: runtime.filesystem,
    };
}

/**
 * remote 런처가 쓰는 단일 진입점. checkpoint 세션이 이미 만든 설정이 있으면
 * 그것을 쓰고, 없으면 세션의 sandboxConfig 로 만든다. enabled 인 세션이 경계
 * 없이 뜨는 조합을 여기서 없앤다.
 */
export function resolveClaudeRemoteSandbox(input: {
    checkpointSandbox: SandboxSettings | undefined;
    sandboxConfig: SandboxConfig | undefined;
    sessionPath: string;
    policyMode: SandboxPolicyMode;
}): SandboxSettings | undefined {
    if (input.checkpointSandbox) {
        // checkpoint composition 이 policy 를 받아 floor 를 얹었는지 확인한다.
        // 그 전달이 끊기면 여기서 조용히 무경계 설정이 나가고, 실제 실행은 턴
        // 설정을 우선하므로 런처 쪽 보완으로는 덮이지 않는다.
        if (input.policyMode === 'mandatory') {
            const denyRead = input.checkpointSandbox.filesystem?.denyRead ?? [];
            const missing = resolveSandboxTrustFloor().filter((path) => !denyRead.includes(path));
            if (missing.length > 0) {
                throw new MandatorySandboxError('missing-floor', missing.join(', '));
            }
        }
        return input.checkpointSandbox;
    }
    return buildClaudeRemoteSandboxSettings({
        sandboxConfig: input.sandboxConfig,
        sessionPath: input.sessionPath,
        policyMode: input.policyMode,
    });
}

/**
 * SDK sandbox 와 함께 내려보내는 CLI 권한 deny 규칙.
 *
 * sandbox 설정의 filesystem 은 주로 Bash 실행 경계에 걸린다. Read/Edit 도구가
 * 같은 경로를 직접 다루는 길은 CLI 권한 규칙으로 막아야 두 층이 맞는다.
 *
 * 문법: Claude 권한 규칙에서 **절대경로는 `//` 로 시작**한다. 단일 `/` 로 시작하면
 * 설정 파일 기준 상대경로로 해석돼 보호하려던 경로를 가리키지 않는다. 쓰기는
 * `Edit` 규칙이 덮으며 `Write(path)` 는 파일 권한 판정에 쓰이지 않는다.
 * (https://code.claude.com/docs/en/permissions#read-and-edit)
 *
 * 이것이 OS 경계는 아니다 — 도구 레벨 거부이며, 프로세스 전체 경계는 여전히
 * 자식을 감싸야 얻는다.
 */
export function buildMandatoryRemoteDenyRules(policyMode: SandboxPolicyMode): string[] {
    if (policyMode !== 'mandatory') return [];
    return resolveSandboxTrustFloor().flatMap((path) => {
        const absolute = path.replace(/\/+$/, '').replace(/^\/+/, '');
        return [`Read(//${absolute}/**)`, `Edit(//${absolute}/**)`];
    });
}
