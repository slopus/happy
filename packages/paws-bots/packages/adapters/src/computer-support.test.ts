import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computerScreenSize,
  displayBotWorkspacePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
  teamWorkspaceInstruction,
  workspaceCwd,
} from "./computer-support.js";

describe("workspaceCwd", () => {
  const root = "/home/user/rakazo-home";

  it("maps empty, '.', '/', the root and home aliases to the root", () => {
    for (const cwd of [undefined, "", ".", "/", root, "/home/rakazo", "/home/user"]) {
      expect(workspaceCwd(root, cwd, ["/home/user"])).toBe(root);
    }
  });

  it("keeps paths inside the root, a home alias or the bot-visible home", () => {
    expect(workspaceCwd(root, `${root}/notes/a`, ["/home/user"])).toBe(`${root}/notes/a`);
    expect(workspaceCwd(root, "/home/rakazo/notes", ["/home/user"])).toBe(`${root}/notes`);
    expect(workspaceCwd(root, "/home/user/notes", ["/home/user"])).toBe(`${root}/notes`);
    expect(workspaceCwd(root, "notes/a")).toBe(`${root}/notes/a`);
    expect(workspaceCwd(root, "/etc")).toBe(`${root}/etc`);
  });

  it("rejects '..' and '.' segments, including under an absolute workspace path", () => {
    for (const cwd of [
      `${root}/../etc`,
      `${root}/notes/../../..`,
      "/home/rakazo/../etc",
      "/home/user/../../etc",
      "../etc",
      "notes/./a",
    ]) {
      expect(() => workspaceCwd(root, cwd, ["/home/user"])).toThrow(
        "Path escapes the computer workspace",
      );
    }
  });
});

describe("Team Computer bot folders", () => {
  it("uses the bot folder for relative paths and cwd", () => {
    expect(teamBotWorkspaceDirectory("bot-1")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "projects/site")).toBe(
      "bots/bot-1/projects/site",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", "/Users/me/project")).toBe("/Users/me/project");
  });

  it("reads a leading ~ in a dedicated computer's shell cwd as the workspace root", () => {
    const root = "/workspace";
    const cwd = (requested: string | undefined) =>
      workspaceCwd(root, resolveBotWorkspaceCwd("dedicated", "bot-1", requested));
    expect(cwd("~")).toBe(root);
    expect(cwd("~/src")).toBe(`${root}/src`);
    expect(cwd("src")).toBe(`${root}/src`);
    expect(cwd(undefined)).toBe(root);
    expect(cwd("~user/src")).toBe(`${root}/~user/src`);
  });

  it("hands a dedicated computer's provider a relative cwd for a home alias", () => {
    const requested = (cwd: string) => resolveBotWorkspaceCwd("dedicated", "bot-1", cwd);
    expect(requested("~")).toBeUndefined();
    expect(requested("~/")).toBeUndefined();
    expect(requested("~/src")).toBe("src");
  });

  it("tells the bot how its shell reaches the same shared folder as the file tools", () => {
    const shellDefaultCwd = resolveBotWorkspaceCwd("team", "bot-1", undefined) ?? "";
    const sharedForFileTools = resolveBotWorkspacePath("team", "bot-1", "shared/report.xlsx");
    const instruction = teamWorkspaceInstruction("bot-1");
    const shellPath = instruction.match(/(\.\.\/)+shared\//)?.[0];
    expect(shellPath).toBeDefined();
    expect(path.posix.join(shellDefaultCwd, `${shellPath}report.xlsx`)).toBe(sharedForFileTools);
    expect(instruction).toContain("shell cwd of shared");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "shared")).toBe("shared");
  });

  it("preserves Windows absolute working directories even when the backend runs on Linux", () => {
    const drive = String.raw`C:\Users\example\project`;
    const share = String.raw`\\server\share\project`;
    expect(resolveBotWorkspaceCwd("team", "bot-1", drive)).toBe(drive);
    expect(resolveBotWorkspaceCwd("team", "bot-1", share)).toBe(share);
  });

  it("keeps shared, bot-root, and absolute paths at the Team root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "bots/bot-2/result.md")).toBe(
      "bots/bot-2/result.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/root-note.md")).toBe("root-note.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/shared/brief.md")).toBe("shared/brief.md");
  });

  it("treats a leading ~ as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "~")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~\\notes\\x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "~/notes/x.md")).toBe("/notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~x/y")).toBe("bots/bot-1/~x/y");
    expect(() => resolveBotWorkspacePath("team", "bot-1", "~/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under ~", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "~/bots", "bots/bot-1")).toBe("bots/bot-1");
  });

  it("treats a leading /home/rakazo as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", String.raw`\home\rakazo\notes\x.md`)).toBe(
      "notes/x.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/rakazo/notes/x.md")).toBe(
      "/notes/x.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/rakazo")).toBe("/");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", String.raw`\home\rakazo\notes\x.md`)).toBe(
      String.raw`\notes\x.md`,
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazotest/file.txt")).toBe(
      "home/rakazotest/file.txt",
    );
    expect(() => resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under /home/rakazo", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "/home/rakazo/bots", "bots/bot-1")).toBe(
      "bots/bot-1",
    );
  });

  it("presents the current bot folder as its home without hiding Team paths", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "notes", "bots/bot-1/notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "shared", "shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "bots", "bots/bot-1")).toBe("bots/bot-1");
    expect(displayBotWorkspacePath("team", "bot-1", "/", "bots/bot-1")).toBe("bots/bot-1");
    expect(
      displayBotWorkspacePath("team", "bot-1", "bots/bot-1", "bots/bot-1/notes/result.txt"),
    ).toBe("bots/bot-1/notes/result.txt");
  });

  it("leaves Private Computer paths unchanged", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(resolveBotWorkspaceCwd("dedicated", "bot-1", undefined)).toBeUndefined();
    expect(displayBotWorkspacePath("dedicated", "bot-1", "notes", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });
});

describe("resolveBotUploadPath", () => {
  it("keeps team uploads in the controlling bot home or shared", () => {
    expect(resolveBotUploadPath("team", "bot-1", "notes.txt")).toBe("bots/bot-1/notes.txt");
    expect(resolveBotUploadPath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(() => resolveBotUploadPath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(
      /escapes the bot workspace/,
    );
  });
});

describe("computerScreenSize", () => {
  it("uses boat geometry and the 1280x800 default for other sandboxes", () => {
    expect(computerScreenSize("boat")).toEqual({ width: 1920, height: 1080 });
    expect(computerScreenSize("e2b")).toEqual({ width: 1280, height: 800 });
    expect(computerScreenSize("daytona")).toEqual({ width: 1280, height: 800 });
    expect(computerScreenSize(null)).toEqual({ width: 1280, height: 800 });
    expect(computerScreenSize(undefined)).toEqual({ width: 1280, height: 800 });
  });
});
