import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("treats the web type scale as font sizes", () => {
    expect(cn("text-heading3 font-medium", "text-heading2 text-foreground")).toBe(
      "font-medium text-heading2 text-foreground",
    );
    expect(cn("text-body text-muted-foreground")).toBe("text-body text-muted-foreground");
    expect(cn("text-body-lg text-label")).toBe("text-label");
  });
});
