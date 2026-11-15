import { describe, expect, it } from "vitest";
import {
  canDeleteOrganization,
  organizationLandingSpaceId,
  organizationOfSpace,
} from "./organizations.js";

const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "a1",
  spaceIds: ["a1", "a2"],
  canManage: true,
};
const home = {
  id: "org-home",
  name: "Home",
  defaultSpaceId: "b1",
  spaceIds: ["b1", "b2"],
  canManage: true,
};

describe("organizationLandingSpaceId", () => {
  it("opens the Space last used there, else the default", () => {
    expect(organizationLandingSpaceId(home, { "org-home": "b2" })).toBe("b2");
    expect(organizationLandingSpaceId(home, { "org-home": "deleted" })).toBe("b1");
    expect(organizationLandingSpaceId(home, { "org-work": "a2" })).toBe("b1");
  });
});

describe("organizationOfSpace", () => {
  it("finds the organization holding the Space", () => {
    expect(organizationOfSpace([work, home], "b2")).toBe(home);
    expect(organizationOfSpace([work, home], "elsewhere")).toBeUndefined();
    expect(organizationOfSpace([work, home], null)).toBeUndefined();
  });
});

describe("canDeleteOrganization", () => {
  it("lets an owner delete one while they own another", () => {
    const shared = { ...home, id: "org-shared", canManage: false };
    expect(canDeleteOrganization([work, home], home)).toBe(true);
    expect(canDeleteOrganization([work, shared], work)).toBe(false);
    expect(canDeleteOrganization([work, home, shared], shared)).toBe(false);
  });
});
