import {
    DelegationRoleV1Schema, DelegatedTaskSummaryV1Schema,
    type DelegationRole, type DelegatedTaskSummary, type DelegationResponse,
} from '@slopus/happy-wire';

/** Omit unsupported V2 entries; never manufacture a model code or a saved role ID for old clients. */
export function projectDelegationSnapshotV1(roles: DelegationRole[], tasks: DelegatedTaskSummary[]) {
    return {
        roles: roles.filter(role => role.model !== undefined).map(role => DelegationRoleV1Schema.parse(role)),
        tasks: tasks.filter(task => task.roleId !== undefined && task.model !== undefined).map(task => DelegatedTaskSummaryV1Schema.parse(task)),
    };
}

export function projectDelegationResponseV1(response: DelegationResponse): DelegationResponse {
    if (response.task && (!response.task.roleId || !response.task.model)) return {
        success: false, taskId: response.taskId,
        error: 'This task requires a client using delegation protocolVersion 2',
    };
    return {
        ...response,
        ...(response.roles ? { roles: projectDelegationSnapshotV1(response.roles, []).roles } : {}),
        ...(response.role && !response.role.model ? { role: undefined } : {}),
        ...(response.task ? { task: { ...response.task, history: response.task.history.map(({ intent: _intent, ...version }) => version) } } : {}),
    };
}
