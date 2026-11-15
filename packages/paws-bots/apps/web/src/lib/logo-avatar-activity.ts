import type { ProductEvent } from "@rakazo/contracts";
import type { LogoAvatarActivitySnapshot } from "@rakazo/core";
import { createLogoAvatarActivityStore } from "@rakazo/core";

/** Client-owned projection; clear when the authenticated identity changes. */
const projection = createLogoAvatarActivityStore();
let identity: string | null | undefined;
let epoch = 0;
let serial = 0;
const currentSource = (source: string) =>
  !source.startsWith("web-avatar-") || source.startsWith(`web-avatar-${epoch}-`);
export const webLogoAvatarActivity = {
  ...projection,
  apply(source: string, event: ProductEvent) {
    if (currentSource(source)) projection.apply(source, event);
  },
  hydrate(source: string, snapshot: LogoAvatarActivitySnapshot) {
    if (currentSource(source)) projection.hydrate(source, snapshot);
  },
  clear() {
    epoch++;
    projection.clear();
  },
};
export const newLogoAvatarActivitySource = () => `web-avatar-${epoch}-${++serial}`;

/** Settled auth only: a pending/unreachable session must not look like logout. */
export function syncWebLogoAvatarIdentity(userId: string | null) {
  if (identity === userId) return;
  identity = userId;
  webLogoAvatarActivity.clear();
}

/** Own activity only while this physical feed is connected; replay is filtered upstream. */
export async function openLogoAvatarActivityFeed(
  source: string,
  snapshot: LogoAvatarActivitySnapshot | null,
  cursor: number,
  signal: AbortSignal,
  connect: () => Promise<AsyncIterable<ProductEvent>>,
): Promise<AsyncIterable<ProductEvent>> {
  webLogoAvatarActivity.resetSource(source);
  if (snapshot)
    webLogoAvatarActivity.hydrate(source, {
      ...snapshot,
      cursor: Math.max(cursor, snapshot.cursor),
    });
  const clear = () => webLogoAvatarActivity.resetSource(source);
  signal.addEventListener("abort", clear, { once: true });
  let stream: AsyncIterable<ProductEvent>;
  try {
    stream = await connect();
  } catch (error) {
    signal.removeEventListener("abort", clear);
    clear();
    throw error;
  }
  return (async function* () {
    try {
      for await (const event of stream) yield event;
    } finally {
      signal.removeEventListener("abort", clear);
      clear();
    }
  })();
}
