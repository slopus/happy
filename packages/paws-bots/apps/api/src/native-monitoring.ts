import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { AnalyticsScreen } from "@rakazo/contracts";
import {
  CORRELATION_TAG_KEYS,
  isMonitoringUserId,
  sanitizeMonitoringEvent,
  scrubMonitoringText,
  stripMonitoringUrl,
} from "@rakazo/logging/monitoring";

const decompress = promisify(gunzip);
const MAX_BYTES = 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeFrame(value: unknown): Record<string, unknown> {
  const frame = object(value);
  const result: Record<string, unknown> = {};
  for (const key of [
    "function",
    "module",
    "filename",
    "abs_path",
    "instruction_addr",
    "symbol_addr",
    "image_addr",
    "addr_mode",
    "package",
  ]) {
    if (typeof frame[key] === "string") result[key] = stripMonitoringUrl(frame[key]);
  }
  for (const key of ["lineno", "colno", "in_app"]) {
    if (typeof frame[key] === "number" || typeof frame[key] === "boolean") result[key] = frame[key];
  }
  return result;
}

/** Reconstruct an allowlist rather than trusting arbitrary native SDK context or attachments. */
export function sanitizeNativeEvent(
  value: unknown,
  surface: "mobile" | "desktop",
): Record<string, unknown> {
  const input = object(value);
  const event: Record<string, unknown> = {
    level: input.level === "fatal" ? "fatal" : "error",
    tags: { surface },
  };
  for (const key of ["event_id", "platform", "release", "dist", "message"]) {
    if (typeof input[key] === "string") event[key] = scrubMonitoringText(input[key]).slice(0, 8192);
  }
  if (typeof input.timestamp === "number" || typeof input.timestamp === "string")
    event.timestamp = input.timestamp;
  const values = object(input.exception).values;
  if (Array.isArray(values))
    event.exception = {
      values: values.slice(0, 10).map((value) => {
        const source = object(value);
        const exception: Record<string, unknown> = {};
        for (const key of ["type", "value", "module"]) {
          if (typeof source[key] === "string")
            exception[key] = scrubMonitoringText(source[key]).slice(0, 8192);
        }
        const frames = object(source.stacktrace).frames;
        if (Array.isArray(frames))
          exception.stacktrace = { frames: frames.slice(-200).map(safeFrame) };
        const mechanism = object(source.mechanism);
        exception.mechanism = {
          type: typeof mechanism.type === "string" ? scrubMonitoringText(mechanism.type) : "native",
          handled: mechanism.handled === true,
        };
        return exception;
      }),
    };
  const tags = object(input.tags);
  const safeTags = event.tags as Record<string, string>;
  if (
    surface === "mobile" &&
    (tags["mobile.platform"] === "ios" || tags["mobile.platform"] === "android")
  )
    safeTags["mobile.platform"] = tags["mobile.platform"];
  if (surface === "mobile" && tags["startup.previous_launch"] === "true")
    safeTags["startup.previous_launch"] = "true";
  // The app sets a coarse screen name, never a route param; this rejects anything else.
  // A replayed startup error carries the current launch's screen, not the one it happened on.
  if (
    surface === "mobile" &&
    tags["startup.previous_launch"] !== "true" &&
    (tags.screen === "other" || AnalyticsScreen.safeParse(tags.screen).success)
  )
    safeTags.screen = tags.screen as string;
  if (surface === "desktop") {
    const name = tags["process.name"];
    const exitCode = tags["process.exit_code"];
    if (typeof name === "string" && /^[a-zA-Z0-9_. -]{1,100}$/.test(name))
      safeTags["process.name"] = name;
    if (typeof exitCode === "string" && /^-?\d{1,10}$/.test(exitCode))
      safeTags["process.exit_code"] = exitCode;
    const route = tags["renderer.route"];
    const uptime = tags["renderer.uptime_min"];
    const memory = tags["renderer.memory_mb"];
    if (
      typeof route === "string" &&
      /^(\/[a-z:-]{0,24})+$|^[a-z-]{1,20}:$|^unknown$/.test(route) &&
      route.length <= 100
    )
      safeTags["renderer.route"] = route;
    if (typeof uptime === "string" && /^\d{1,7}$/.test(uptime))
      safeTags["renderer.uptime_min"] = uptime;
    if (typeof memory === "string" && /^\d{1,6}(,\d{1,6}){0,9}$/.test(memory))
      safeTags["renderer.memory_mb"] = memory;
  }
  for (const key of [...CORRELATION_TAG_KEYS, "operation"]) {
    const value = tags[key];
    if (typeof value === "string" && value.length <= 200 && /^[a-zA-Z0-9_.:-]+$/.test(value))
      safeTags[key] = value;
  }
  const images = object(input.debug_meta).images;
  if (Array.isArray(images))
    event.debug_meta = {
      images: images.slice(0, 100).map((image) => {
        const source = object(image);
        const safeImage: Record<string, string | number> = {};
        for (const key of [
          "type",
          "code_file",
          "debug_file",
          "debug_id",
          // Android identifies its R8 mapping by `uuid`, not `debug_id`.
          "uuid",
          "code_id",
          "image_addr",
          "image_size",
          "arch",
        ]) {
          const value = source[key];
          if (typeof value === "string") safeImage[key] = stripMonitoringUrl(value);
          else if (typeof value === "number") safeImage[key] = value;
        }
        return safeImage;
      }),
    };
  // Native code records breadcrumbs the app's own filter never sees.
  if (surface === "mobile") event.breadcrumbs = input.breadcrumbs;
  if (!event.message && !event.exception) event.message = `${surface} native process crashed`;
  // Never attribute a cached crash from an earlier native session to the current signed-in user.
  const userId = object(input.user).id;
  return sanitizeMonitoringEvent(
    event,
    tags["startup.previous_launch"] !== "true" &&
      (input.platform === "javascript" || input.platform === "node") &&
      isMonitoringUserId(userId)
      ? userId
      : undefined,
  );
}

/** Parse Sentry's length-delimited envelope bytes; skip attachments without decoding their contents. */
export async function sanitizeNativeEnvelope(
  bytes: Uint8Array,
  encoding: string | undefined,
  surface: "mobile" | "desktop",
  target: { dsn: string; environment?: string | null },
): Promise<Uint8Array> {
  if (encoding && encoding !== "gzip" && encoding !== "identity")
    throw new Error("Unsupported envelope encoding");
  const data =
    encoding === "gzip" ? await decompress(bytes, { maxOutputLength: MAX_BYTES }) : bytes;
  if (data.length > MAX_BYTES) throw new Error("Envelope too large");
  let offset = 0;
  const line = () => {
    const start = offset;
    while (offset < data.length && data[offset] !== 10) offset++;
    const value = decoder.decode(data.subarray(start, offset));
    if (offset < data.length) offset++;
    return value;
  };
  object(JSON.parse(line()));
  const output = [JSON.stringify({ dsn: target.dsn })];
  let events = 0;
  while (offset < data.length) {
    const header = object(JSON.parse(line()));
    const start = offset;
    let payload: Uint8Array;
    if (header.length !== undefined) {
      if (
        !Number.isSafeInteger(header.length) ||
        (header.length as number) < 0 ||
        (header.length as number) > data.length - offset
      )
        throw new Error("Invalid envelope length");
      offset += header.length as number;
      payload = data.subarray(start, offset);
      if (offset < data.length && data[offset++] !== 10)
        throw new Error("Invalid envelope boundary");
    } else {
      payload = encoder.encode(line());
    }
    if (header.type !== "event") continue;
    if (++events > 20) throw new Error("Too many envelope events");
    const sanitized = sanitizeNativeEvent(JSON.parse(decoder.decode(payload)), surface);
    if (target.environment) sanitized.environment = scrubMonitoringText(target.environment);
    const event = JSON.stringify(sanitized);
    output.push(JSON.stringify({ type: "event", length: encoder.encode(event).length }), event);
  }
  if (!events) throw new Error("No error events");
  return encoder.encode(output.join("\n") + "\n");
}
