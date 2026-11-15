import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The web type scale lives in packages/ui-web/src/styles.css. Text sizes come from it so the app
// stays consistent; a size off the scale is allowed only with an `off-scale:` comment on the same
// or the previous line saying why.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs = ["apps/web/src", "packages/ui-web/src", "packages/chat-ui/src"];
const OFF_SCALE_SIZE = /(?<![\w-])text-\[(?:\d|length:|var\()/;
const RETIRED_SIZE = /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl|body1|body2)(?![\w-])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .filter((entry) => !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("web type scale", () => {
  it("sizes text from the scale, or says why not", () => {
    const problems: string[] = [];
    for (const dir of dirs) {
      for (const file of sourceFiles(path.join(root, dir))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          const explained = /off-scale:/.test(line) || /off-scale:/.test(lines[index - 1] ?? "");
          const where = `${path.relative(root, file)}:${index + 1}`;
          if (RETIRED_SIZE.test(line)) problems.push(`${where} uses a size outside the scale`);
          else if (OFF_SCALE_SIZE.test(line) && !explained) {
            problems.push(`${where} sets an off-scale size without an off-scale: comment`);
          }
        });
      }
    }
    expect(problems).toEqual([]);
  });
});
