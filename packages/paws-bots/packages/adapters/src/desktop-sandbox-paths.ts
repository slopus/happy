import path from "node:path";
import { normalizeWorkspacePath } from "./computer-support.js";

type PathOperations = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "sep">;

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export function normalizeDesktopWorkspacePath(value: string, platform = process.platform) {
  if (platform === "win32") assertPortableWindowsPath(value);
  return normalizeWorkspacePath(value);
}

export function isAllowedDesktopPath(
  target: string,
  roots: string[],
  pathOperations: PathOperations = path,
) {
  const resolved = pathOperations.resolve(target);
  return roots.some((root) => {
    const relative = pathOperations.relative(pathOperations.resolve(root), resolved);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${pathOperations.sep}`) &&
        !pathOperations.isAbsolute(relative))
    );
  });
}

function assertPortableWindowsPath(value: string) {
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("//")) throw new Error("Path escapes the computer workspace");
  const withoutVirtualRoot = portable.replace(/^\/+/, "");
  for (const segment of withoutVirtualRoot.split("/").filter(Boolean)) {
    const deviceName = segment.split(".", 1)[0] ?? "";
    if (
      hasWindowsReservedCharacter(segment) ||
      /[ .]$/u.test(segment) ||
      WINDOWS_RESERVED_NAME.test(deviceName)
    ) {
      throw new Error("Path escapes the computer workspace");
    }
  }
}

function hasWindowsReservedCharacter(segment: string) {
  return [...segment].some(
    (character) => character.charCodeAt(0) <= 31 || '<>:"|?*'.includes(character),
  );
}
