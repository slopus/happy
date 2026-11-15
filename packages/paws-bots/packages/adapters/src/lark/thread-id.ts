export const Domain = {
  Lark: "https://open.larksuite.com",
  Feishu: "https://open.feishu.cn",
} as const;
export type Domain = (typeof Domain)[keyof typeof Domain];

export interface LarkThreadId {
  chatId: string;
  threadId?: string;
}

export function encodeThreadId(data: LarkThreadId): string {
  const base = `lark:${Buffer.from(data.chatId).toString("base64url")}`;
  return data.threadId ? `${base}:${Buffer.from(data.threadId).toString("base64url")}` : base;
}

export function decodeThreadId(threadId: string): LarkThreadId {
  const parts = threadId.split(":");
  if (parts[0] !== "lark") throw new Error(`Invalid thread ID prefix: ${parts[0]}`);
  if (!parts[1]) throw new Error("Thread ID missing chatId segment");
  const chatId = Buffer.from(parts[1], "base64url").toString();
  return parts[2]
    ? { chatId, threadId: Buffer.from(parts[2], "base64url").toString() }
    : { chatId };
}
