/**
 * Pure decision logic for the AX Studio `PreToolUse` hook.
 *
 * Responsibilities:
 *  - per-step write boundary (plan/design lock the workspace except for their
 *    own deliverable + `.ax/state.json`)
 *  - schema-validate any Write/Edit/MultiEdit targeting `.ax/state.json` so a
 *    malformed write can never break the workflow
 *  - in `work` step, gate edits to `AX_PROJECT_PLAN.md` / `AX_STUDIO_DESIGN.md`
 *    on the workspace's `permissions.editPlanMd` / `editDesignMd`
 *
 * The function is pure — the CLI wrapper in `runPreToolUseCli.ts` handles
 * stdin/stdout, state reading, and event-log writes.
 */

import { relative, isAbsolute, normalize, sep, posix } from 'node:path';
import {
    AxState,
    AxStateSchema,
    PLAN_MD_FILENAME,
    DESIGN_MD_FILENAME,
} from '../orchestrator/state/schema';

export type PreToolUseDecision = 'allow' | 'deny' | 'ask';

export interface PreToolUseInput {
    cwd: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    state: AxState;
}

export interface PreToolUseResult {
    decision: PreToolUseDecision;
    reason?: string;
    /** Set when `decision === 'ask'`. Tells the modal which permission key to record. */
    permissionTarget?: 'editPlanMd' | 'editDesignMd';
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const STATE_JSON_REL = '.ax/state.json';

export function decidePreToolUse(input: PreToolUseInput): PreToolUseResult {
    if (!WRITE_TOOLS.has(input.toolName)) {
        return { decision: 'allow' };
    }

    const filePath = typeof input.toolInput.file_path === 'string' ? input.toolInput.file_path : '';
    if (!filePath) {
        return { decision: 'allow' };
    }

    const rel = workspaceRelative(input.cwd, filePath);

    // state.json: validate schema regardless of step
    if (rel === STATE_JSON_REL) {
        return validateStateJsonPayload(input);
    }

    switch (input.state.step) {
        case 'plan':
            return decidePlanStep(rel);
        case 'design':
            return decideDesignStep(rel);
        case 'work':
            return decideWorkStep(rel, input.state);
    }
}

function decidePlanStep(rel: string): PreToolUseResult {
    if (rel === PLAN_MD_FILENAME) return { decision: 'allow' };
    return {
        decision: 'deny',
        reason: `현재 plan 단계에서는 ${PLAN_MD_FILENAME} 또는 .ax/state.json만 수정할 수 있습니다. 다른 파일을 만들려면 '디자인으로' 또는 '개발로' 버튼을 눌러 단계를 전환하세요. (시도한 경로: ${rel})`,
    };
}

function decideDesignStep(rel: string): PreToolUseResult {
    if (rel === DESIGN_MD_FILENAME) return { decision: 'allow' };
    return {
        decision: 'deny',
        reason: `현재 design 단계에서는 ${DESIGN_MD_FILENAME} 또는 .ax/state.json만 수정할 수 있습니다. 코드 작업이 필요하면 '개발로' 버튼을 눌러 단계를 전환하세요. (시도한 경로: ${rel})`,
    };
}

function decideWorkStep(rel: string, state: AxState): PreToolUseResult {
    if (rel === PLAN_MD_FILENAME) return gatedDecision('editPlanMd', state, PLAN_MD_FILENAME);
    if (rel === DESIGN_MD_FILENAME) return gatedDecision('editDesignMd', state, DESIGN_MD_FILENAME);
    return { decision: 'allow' };
}

function gatedDecision(
    target: 'editPlanMd' | 'editDesignMd',
    state: AxState,
    filename: string,
): PreToolUseResult {
    const permission = state.work.permissions[target];
    switch (permission) {
        case 'always':
            return { decision: 'allow' };
        case 'never':
            return {
                decision: 'deny',
                reason: `${filename} 수정이 영구 차단되어 있습니다 (permissions.${target} = "never"). 변경하려면 워크스페이스 설정에서 권한을 갱신하세요.`,
            };
        case 'ask':
            // Claude Code 의 내장 ask 모달은 happy 의 permission 인프라 (모바일
            // 알림 / 웹 UI 권한 모달) 와 통합 경로가 명확하지 않다. 사용자가
            // 채팅 화면 상단의 "기획·디자인 문서 수정 권한" 패널 (web-ui
            // AxPermissionsPanel) 에서 직접 always/never 를 선택하는 UX 로
            // 일원화 — hook 은 일단 deny 하고, 사용자가 권한을 풀면 다음
            // turn 에 Claude 가 재시도한다.
            return {
                decision: 'deny',
                reason: `Claude가 ${filename}을 수정하려고 했습니다. 채팅 화면 상단의 "🛡 기획·디자인 문서 수정 권한" 패널을 펼쳐 "${target}"을 "항상 허용" 으로 바꾼 뒤 다시 요청해 주세요. (현재 권한: ask)`,
                permissionTarget: target,
            };
    }
}

function validateStateJsonPayload(input: PreToolUseInput): PreToolUseResult {
    if (input.toolName === 'Edit' || input.toolName === 'MultiEdit') {
        // We cannot reconstruct the post-edit file here without filesystem access;
        // the CLI wrapper will re-validate after the edit lands by reading the
        // file back. For Edit/MultiEdit we allow optimistically.
        return { decision: 'allow' };
    }
    const content = typeof input.toolInput.content === 'string' ? input.toolInput.content : '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        return {
            decision: 'deny',
            reason: `.ax/state.json에 쓰려는 내용이 유효한 JSON이 아닙니다: ${(err as Error).message}`,
        };
    }
    const result = AxStateSchema.safeParse(parsed);
    if (!result.success) {
        return {
            decision: 'deny',
            reason: `.ax/state.json 스키마 검증 실패: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        };
    }
    return { decision: 'allow' };
}

function workspaceRelative(cwd: string, filePath: string): string {
    const abs = isAbsolute(filePath) ? filePath : normalize(`${cwd}${sep}${filePath}`);
    let rel = relative(cwd, normalize(abs));
    // Normalize to POSIX so the rest of the code can compare against literal
    // relative paths (`'.ax/state.json'`) regardless of platform.
    rel = rel.split(sep).join(posix.sep);
    return rel;
}
