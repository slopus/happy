import { notificationAvatarSource } from "@rakazo/core";

type AvatarBot = { id: string; color: string; avatarSet?: string | null };

const ICON_SIZE = 96;
const icons = new Map<string, { key: string; icon?: string }>();

const avatarKey = (bot: AvatarBot) => `${bot.avatarSet ?? ""}\n${bot.color}`;

// Chromium and Electron do not reliably draw SVG notification icons.
function rasterize(svgUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = ICON_SIZE;
        canvas.height = ICON_SIZE;
        const context = canvas.getContext("2d");
        if (!context) return resolve(undefined);
        context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = svgUrl;
  });
}

/** Renders these bots' icons ahead of their notifications and forgets every other bot. */
export function prepareNotificationIcons(bots: readonly AvatarBot[]) {
  const ids = new Set(bots.map((bot) => bot.id));
  for (const id of icons.keys()) if (!ids.has(id)) icons.delete(id);
  for (const bot of bots) {
    const key = avatarKey(bot);
    if (icons.get(bot.id)?.key === key) continue;
    const entry: { key: string; icon?: string } = { key };
    icons.set(bot.id, entry);
    const source = notificationAvatarSource(bot);
    if (source.startsWith("data:image/svg+xml,")) {
      void rasterize(source).then((icon) => {
        entry.icon = icon;
      });
    } else {
      entry.icon = source;
    }
  }
}

/** The bot's prepared avatar, or undefined to keep the browser default. */
export function notificationIcon(bot: AvatarBot): string | undefined {
  const entry = icons.get(bot.id);
  return entry?.key === avatarKey(bot) ? entry.icon : undefined;
}
