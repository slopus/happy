import type { ThreadMessage } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { quoteDraftForSelection } from "./quote-selection.js";

const message = (id: string) => ({ id, blocks: [{ kind: "text", text: "body" }] }) as ThreadMessage;
const content = (messageId: string) => ({ dataset: { quoteMessageId: messageId } });
const unquotableContent = () => ({ dataset: {} });

const messageById = new Map([
  ["message-1", message("message-1")],
  ["progress:run-1", message("progress:run-1")],
]);

describe("quoteDraftForSelection", () => {
  it("resolves a selection inside one text region to that message", () => {
    const region = content("message-1");
    expect(
      quoteDraftForSelection(
        { startContent: region, endContent: region, text: "  some span  " },
        messageById,
      ),
    ).toEqual({ message: message("message-1"), text: "some span" });
  });

  it("rejects selections spanning two text regions", () => {
    expect(
      quoteDraftForSelection(
        {
          startContent: content("message-1"),
          endContent: content("progress:run-1"),
          text: "span",
        },
        messageById,
      ),
    ).toBeNull();
  });

  it("rejects selections spanning two regions that share a message id", () => {
    expect(
      quoteDraftForSelection(
        {
          startContent: content("message-1"),
          endContent: content("message-1"),
          text: "span",
        },
        messageById,
      ),
    ).toBeNull();
  });

  it("rejects selections outside any message row", () => {
    expect(
      quoteDraftForSelection({ startContent: null, endContent: null, text: "span" }, messageById),
    ).toBeNull();
  });

  it("rejects regions that don't opt into quoting (message chrome and structured cards)", () => {
    const region = unquotableContent();
    expect(
      quoteDraftForSelection(
        { startContent: region, endContent: region, text: "span" },
        messageById,
      ),
    ).toBeNull();
  });

  it("rejects regions whose message is not loaded", () => {
    const region = content("unknown");
    expect(
      quoteDraftForSelection(
        { startContent: region, endContent: region, text: "span" },
        messageById,
      ),
    ).toBeNull();
  });

  it("rejects whitespace-only selections", () => {
    const region = content("message-1");
    expect(
      quoteDraftForSelection(
        { startContent: region, endContent: region, text: "   \n " },
        messageById,
      ),
    ).toBeNull();
  });

  it("caps the excerpt at the quote limit instead of failing the send", () => {
    const region = content("message-1");
    const draft = quoteDraftForSelection(
      {
        startContent: region,
        endContent: region,
        text: "a".repeat(REPLY_QUOTE_MAX_LENGTH + 500),
      },
      messageById,
    );
    expect(draft?.text).toHaveLength(REPLY_QUOTE_MAX_LENGTH);
  });

  it("does not split a surrogate pair at the quote limit", () => {
    const region = content("message-1");
    const draft = quoteDraftForSelection(
      {
        startContent: region,
        endContent: region,
        text: `${"a".repeat(REPLY_QUOTE_MAX_LENGTH - 1)}😀`,
      },
      messageById,
    );
    expect(draft?.text).toBe("a".repeat(REPLY_QUOTE_MAX_LENGTH - 1));
  });
});
