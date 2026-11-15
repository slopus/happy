import { describe, expect, it } from "vitest";
import { SearchHitSchema, SearchQueryOutputSchema } from "./search.js";

describe("search contracts", () => {
  it("accepts bounded workspace search results", () => {
    const parsed = SearchQueryOutputSchema.parse({
      hits: [
        {
          kind: "message",
          botId: "bot-1",
          botName: "Scout",
          title: "Scout",
          snippet: "found it",
          messageId: "msg-1",
          seq: 3,
        },
      ],
    });
    expect(parsed.hits).toHaveLength(1);
    expect(SearchHitSchema.parse(parsed.hits[0]).kind).toBe("message");
  });

  it("accepts group thread hits", () => {
    const parsed = SearchQueryOutputSchema.parse({
      hits: [
        {
          kind: "message",
          groupId: "group-1",
          groupName: "Squad",
          title: "Squad",
          snippet: "found it",
          messageId: "msg-1",
          seq: 3,
        },
      ],
    });
    expect(parsed.hits[0]?.groupId).toBe("group-1");
    expect(parsed.hits[0]?.botId).toBeUndefined();
  });

  it("rejects hits with both or neither target id", () => {
    expect(() =>
      SearchHitSchema.parse({
        kind: "message",
        title: "x",
        snippet: "y",
      }),
    ).toThrow();
    expect(() =>
      SearchHitSchema.parse({
        kind: "message",
        botId: "bot-1",
        botName: "Scout",
        groupId: "group-1",
        groupName: "Squad",
        title: "x",
        snippet: "y",
      }),
    ).toThrow();
  });
});
