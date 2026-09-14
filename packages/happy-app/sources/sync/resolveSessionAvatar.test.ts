import { describe, expect, it } from "vitest";
import { resolveSessionAvatar } from "./resolveSessionAvatar";
import type { Session } from "./storageTypes";
import type { Project } from "./projectTypes";

describe("session avatar precedence", () => {
  const projectImage = { uri: "project" } as NonNullable<Project["avatar"]>;
  const sessionImage = { uri: "session" } as NonNullable<Project["avatar"]>;
  const projects = { p: { avatar: projectImage } as Project };
  const session = { projectId: "p", metadata: { client: { id: "rig" } } } as Session;
  it("prefers the session image over its project image", () => {
    expect(resolveSessionAvatar({ ...session, avatar: sessionImage }, projects)).toBe(sessionImage);
  });
  it("inherits project artwork when the session image is absent or removed", () => {
    expect(resolveSessionAvatar(session, projects)).toBe(projectImage);
    expect(resolveSessionAvatar({ ...session, avatar: null }, projects)).toBe(projectImage);
  });
  it("shows a bot picture without a project and leaves missing artwork to the fallback", () => {
    expect(
      resolveSessionAvatar({ ...session, projectId: null, avatar: sessionImage }, projects),
    ).toBe(sessionImage);
    expect(resolveSessionAvatar({ ...session, projectId: null }, projects)).toBeNull();
  });
});
