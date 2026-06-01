import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { ProjectMemberInfo, ProjectRole, Result } from "./types";
import { buildMemberInfo } from "./projectMemberList";
import { getProjectAsOwner } from "./projectAccessCheck";

/**
 * Invite a user to a project. Target identified by either username (legacy
 * path) or accountId (web-ui orchestrated path — avoids username-collision
 * bugs where two happy Accounts share the same username and the older one
 * gets picked unexpectedly).
 * Only the project owner can invite members.
 * Checks: project exists, caller is owner, target exists, not self,
 * not already a member.
 */
export async function projectMemberInvite(
    ctx: Context,
    projectId: string,
    target: { username: string } | { accountId: string },
    role: ProjectRole
): Promise<Result<ProjectMemberInfo>> {
    return await inTx(async (tx) => {
        const projectResult = await getProjectAsOwner(tx, projectId, ctx.uid);
        if (!projectResult.ok) {
            return projectResult;
        }
        const project = projectResult.value;

        const targetUser = 'accountId' in target
            ? await tx.account.findUnique({ where: { id: target.accountId } })
            : await tx.account.findFirst({ where: { username: target.username } });
        if (!targetUser) {
            return { ok: false, error: 'user-not-found' };
        }

        if (targetUser.id === ctx.uid || targetUser.id === project.accountId) {
            return { ok: false, error: 'self-invite' };
        }

        const existing = await tx.projectMember.findUnique({
            where: { projectId_accountId: { projectId, accountId: targetUser.id } }
        });
        if (existing) {
            return { ok: false, error: 'already-member' };
        }

        const member = await tx.projectMember.create({
            data: {
                projectId,
                accountId: targetUser.id,
                role,
                status: 'pending',
                invitedBy: ctx.uid
            },
            include: { account: true }
        });

        return { ok: true, value: buildMemberInfo(member, member.account) };
    });
}
