import { isIP } from "node:net";

const MAX_TRACKED_KEYS = 10_000;
const OVERFLOW_KEY = "\0overflow";

type CountedWindow = { start: number; count: number };

// Bounded without letting a flood of keys reset anyone's window: windows are kept oldest first so
// expired ones drop off the front, a key that finds the table full shares a coarser-network window
// (an IPv6 caller's /48, an IPv4 caller's /24) so one network's flood cannot throttle callers
// elsewhere, and only a flood that also fills the coarse table shares the one overflow window.
export function windowCounter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, CountedWindow>();
  const coarse = new Map<string, CountedWindow>();
  const sweep = (table: Map<string, CountedWindow>, at: number) => {
    for (const [oldest, window] of table) {
      if (at - window.start < windowMs) break;
      table.delete(oldest);
    }
  };
  const count = (table: Map<string, CountedWindow>, key: string, at: number) => {
    const current = table.get(key);
    if (current) return ++current.count;
    table.set(key, { start: at, count: 1 });
    return 1;
  };
  return (key: string): number => {
    const at = now();
    sweep(windows, at);
    sweep(coarse, at);
    if (windows.has(key) || windows.size < MAX_TRACKED_KEYS) return count(windows, key, at);
    const shared = coarseKey(key);
    return count(
      coarse,
      coarse.has(shared) || coarse.size < MAX_TRACKED_KEYS ? shared : OVERFLOW_KEY,
      at,
    );
  };
}

/** What a caller past a full table is counted against: its IPv6 /48 or IPv4 /24. */
function coarseKey(key: string): string {
  if (!key.startsWith("ip:")) return OVERFLOW_KEY;
  const ip = key.slice(3);
  if (ip.endsWith("::/64")) return `ip:${ip.slice(0, -5).split(":").slice(0, 3).join(":")}::/48`;
  const octets = ip.split(".");
  if (octets.length === 4) return `ip:${octets.slice(0, 3).join(".")}`;
  return OVERFLOW_KEY;
}

/** What a per-address throttle counts against: an IPv6 caller's /64, which one host can hold whole. */
export function throttleKey(ip: string | undefined): string {
  if (!ip || isIP(ip) !== 6) return `ip:${ip ?? "unknown"}`;
  const [head = "", tail] = ip.replace(/%.*$/, "").split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (part: string[]) =>
    part.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const zeros =
    tail === undefined ? [] : Array(8 - width(groups(head)) - width(groups(tail))).fill("0");
  const prefix = [...groups(head), ...zeros, ...groups(tail ?? "")].slice(0, 4);
  return `ip:${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
