import { notificationAvatarSource } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

type Attributes = Record<string, string>;

function tags(svg: string, name: string): Attributes[] {
  return Array.from(svg.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g")), (tag) =>
    Object.fromEntries(
      Array.from(tag[1]!.matchAll(/([\w-]+)="([^"]*)"/g), (attribute) => [
        attribute[1]!,
        attribute[2]!,
      ]),
    ),
  );
}

it.each<[string, { color: string; avatarSet?: "rakazo" }]>([
  ["organic", { color: "#14b8a6" }],
  ["shipped shape", { color: "#8B5CF6::shape_3" }],
  ["rakazo", { color: "#14b8a6", avatarSet: "rakazo" }],
])("draws the %s notification portrait from the chat avatar's geometry", (_, avatar) => {
  const bot = { id: "agent-1", ...avatar };
  const source = notificationAvatarSource(bot);
  const portrait = decodeURIComponent(source.slice(source.indexOf(",") + 1));
  const chat = renderToString(
    <BotAvatar color={bot.color} identity={bot.id} avatarSet={bot.avatarSet} activity="idle" />,
  );

  const [svg] = tags(portrait, "svg");
  expect(tags(chat, "svg")).toContainEqual(expect.objectContaining({ viewBox: svg!.viewBox }));
  const [body] = tags(portrait, "path");
  const bodyGeometry = bot.avatarSet === "rakazo" ? { d: body!.d } : body!;
  expect(tags(chat, "path")).toContainEqual(expect.objectContaining(bodyGeometry));
  if (bot.avatarSet === "rakazo") expect(chat).toContain(`data-color="${body!.fill}"`);
  for (const transform of tags(portrait, "g").flatMap((group) => group.transform ?? [])) {
    expect(chat).toContain(`transform="${transform}"`);
  }
  const eyes = [...tags(portrait, "rect"), ...tags(portrait, "ellipse")];
  expect(eyes).toHaveLength(2);
  const chatEyes = [...tags(chat, "rect"), ...tags(chat, "ellipse")];
  for (const eye of eyes) expect(chatEyes).toContainEqual(expect.objectContaining(eye));
});
