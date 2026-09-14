import type { Session } from "./storageTypes";
import { getSessionProjectId, isHappyAgentSession, type Project } from "./projectTypes";

/** Session artwork is independent of project identity and is never copied onto a project. */
export function resolveSessionAvatar(
  session: Session,
  projects: Record<string, Project>,
): Project["avatar"] {
  if (session.avatar?.uri) return session.avatar;
  const projectId = getSessionProjectId(session);
  return isHappyAgentSession(session) && projectId ? (projects[projectId]?.avatar ?? null) : null;
}
