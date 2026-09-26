import { randomUUID } from 'node:crypto'
import type { AgentGrant, ApprovalId, BatchId, BatchStep, BrowserInstanceId, ElementDescription, PendingApprovalSummary, SnapshotId, TaskId } from './contracts'
import { approvalBinding, formSummary, payloadHash, redact } from './policy'
import type { ApprovalRecord } from './taskStore'

/**
 * Hash of what an approval covers; recomputed from a fresh describeRef right
 * before dispatch. It binds the complete form submission (formDigest: every
 * field in order, destination, method, enctype, submitter overrides), the
 * element's live label and link target, so any of them changing expires it.
 */
export function approvalPayloadHash(step: BatchStep, description: Pick<ElementDescription, 'formValues' | 'frameOrigin' | 'pageUrl'
    | 'form' | 'currentRole' | 'currentName' | 'linkUrl'>): string {
    return payloadHash({ step, formValues: description.formValues, frameOrigin: description.frameOrigin,
        currentPageUrl: description.pageUrl,
        ...(description.form ? { formDigest: description.form.digest } : {}),
        ...(description.currentName !== undefined ? { label: { role: description.currentRole ?? '', name: description.currentName } } : {}),
        ...(description.linkUrl ? { linkUrl: description.linkUrl } : {}) })
}

export function createApproval(input: {
    grant: AgentGrant
    taskId: TaskId
    batchId: BatchId
    step: BatchStep
    nextStep: number
    origin: string
    leaseEpoch: number
    browserInstanceId: BrowserInstanceId
    snapshotId: SnapshotId
    /** describeRef of the step's element, taken right before this approval */
    description: ElementDescription
    expiresAtMs: number
}): { summary: PendingApprovalSummary; record: ApprovalRecord } {
    const { description } = input
    const approvalId = `approval-${randomUUID()}` as ApprovalId
    const stepHash = approvalPayloadHash(input.step, description)
    // Persisted with the approval: names only, never a value (the binding above covers the values).
    const formText = description.form
        ? formSummary(description.form)
        : Object.keys(description.formValues).map((name) => redact(name)).join(', ')
    const label = description.currentName ?? description.name
    const targetName = label ? ` "${redact(label)}"` : ` ${input.step.kind}`
    const verb = input.step.kind === 'fill' ? 'Fill' : 'Confirm'
    const bindingHash = approvalBinding({
        principalId: input.grant.principalId,
        workspaceId: input.grant.workspaceId,
        taskId: input.taskId,
        actionId: input.step.actionId,
        origin: input.origin,
        payloadHash: stepHash,
        leaseEpoch: input.leaseEpoch,
        browserInstanceId: input.browserInstanceId,
        documentGeneration: description.documentGeneration,
        expiresAtMs: input.expiresAtMs,
        frameOrigin: description.frameOrigin,
    })
    const summary: PendingApprovalSummary = {
        approvalId,
        actionId: input.step.actionId,
        origin: input.origin,
        description: input.step.kind === 'fill'
            ? `${verb}${targetName} (value hidden)`
            : `${verb}${targetName}${formText ? ` (${formText})` : ''}`,
        bindingHash,
        expiresAtMs: input.expiresAtMs,
    }
    return {
        summary,
        record: {
            ...summary,
            state: 'pending',
            grantId: input.grant.grantId,
            batchId: input.batchId,
            nextStep: input.nextStep,
            payloadHash: stepHash,
            documentGeneration: description.documentGeneration,
            leaseEpoch: input.leaseEpoch,
            browserInstanceId: input.browserInstanceId,
            snapshotId: input.snapshotId,
            frameOrigin: description.frameOrigin,
            elementIdentity: description.identity,
        },
    }
}
