import { pawsFetch } from "../paws/runtime";
// Import just the classifier: monitoring loads before the app, ahead of the full core barrel.
import {
  isAbandonedRequest,
  isConnectionFailure,
  isServerUnreachable,
} from "@rakazo/core/user-error";
import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as SentryReact from "@sentry/react";
import type { ErrorInfo } from "react";
import { desktopBridge } from "./desktop";
import { importChunk, recoveringByReload } from "./preload-recovery";

// Load the SDK only when the connected API enables reporting.

const MAX_PENDING = 20;

let sentry: typeof SentryReact | undefined;
// Queue caught React errors until monitoring starts.
let pending: Array<[unknown, ErrorInfo]> | undefined = [];
// The signed-in user's pseudonymous id, minted by the API; the raw account id never leaves.
let userId: string | undefined;
let identifications = 0;
// Unknown until the session resolves; false means signed out.
let signedInState: boolean | undefined;
const errors = createClientErrorReporter();
let explicitlyDisabled = false;
let starting: Promise<boolean> | undefined;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function reportClientError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  // A request that lost its connection, timed out or was cancelled is the network, not a bug.
  if (operation === "rpc.transport" && isConnectionFailure(error)) return;
  errors.capture(error, operation, tags);
}

/** Runs before the application imports, so module evaluation failures are captured too. */
export function installEarlyErrorReporting(target: Window = window): void {
  // An event without an error is a cross-origin script or a ResizeObserver loop: nothing to trace.
  const error = (event: ErrorEvent) => {
    if (!sentry && event.error != null) reportClientError(event.error, "react.render");
  };
  const rejection = (event: PromiseRejectionEvent) => {
    if (!sentry) reportClientError(event.reason, "react.render");
  };
  target.addEventListener("error", error);
  target.addEventListener("unhandledrejection", rejection);
  target.addEventListener("online", () => {
    if (!sentry && !explicitlyDisabled) void startMonitoring();
  });
}

export async function startMonitoring(fetchImpl: typeof fetch = pawsFetch): Promise<boolean> {
  if (starting) return starting;
  starting = (async () => {
    sentry = await loadSentry(fetchImpl);
    if (sentry || explicitlyDisabled) {
      const queued = pending ?? [];
      pending = undefined;
      for (const [error, errorInfo] of queued) sentry?.captureReactException(error, errorInfo);
      errors.install(
        sentry
          ? {
              capture: (error, operation, tags) =>
                sentry?.captureException(error, { tags: { ...tags, operation, surface: "web" } }),
            }
          : undefined,
      );
      clearTimeout(retryTimer);
    } else if (typeof window !== "undefined" && retries < 3) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        void startMonitoring(fetchImpl);
      }, [1000, 5000, 15000][retries++]!);
    }
    return sentry !== undefined;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

/** Follow sign-in and sign-out so reports count affected users without naming them. */
export async function identifyMonitoringUser(
  signedIn: boolean,
  fetchImpl: typeof fetch = pawsFetch,
): Promise<void> {
  const current = ++identifications;
  signedInState = signedIn;
  userId = undefined;
  if (!signedIn || explicitlyDisabled) return;
  try {
    const response = await fetchImpl("/api/monitoring/config");
    if (!response.ok) return;
    const { userId: id } = (await response.json()) as MonitoringConfig;
    // A sign-out or another account that arrived meanwhile wins.
    if (current === identifications && isMonitoringUserId(id)) userId = id;
  } catch {
    // Reports go out without a user.
  }
}

async function loadSentry(fetchImpl: typeof fetch): Promise<typeof SentryReact | undefined> {
  let config: MonitoringConfig;
  try {
    const response = await fetchImpl("/api/monitoring/config");
    if (!response.ok) return undefined;
    config = (await response.json()) as MonitoringConfig;
  } catch {
    // The API is unreachable; the app shows its own connection error.
    return undefined;
  }
  const desktopReports = await desktopBridge()
    ?.monitoring?.enabled()
    .catch(() => false);
  explicitlyDisabled = !config.dsn || desktopReports === false;
  if (!config.dsn || explicitlyDisabled) return undefined;
  // Errors queued during startup count the user too, unless a sign-out or a newer answer came first.
  if (signedInState !== false && userId === undefined && isMonitoringUserId(config.userId))
    userId = config.userId;
  let Sentry: typeof SentryReact;
  try {
    Sentry = await importChunk(() => import("@sentry/react"));
    Sentry.init({
      dsn: config.dsn,
      environment: config.environment ?? undefined,
      release: config.release ?? undefined,
      tunnel: config.tunnel,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      // Completion reports carry no activity history or console content.
      maxBreadcrumbs: 0,
      integrations: (defaults) =>
        defaults.filter(
          (integration) => !["BrowserSession", "Breadcrumbs"].includes(integration.name),
        ),
      // A stale chunk the recovery reload is about to fix is not an error worth reporting.
      beforeSend: (event, hint) =>
        recoveringByReload() || isNotAppBug(hint?.originalException)
          ? null
          : sanitizeMonitoringEvent(event, userId),
    });
  } catch {
    console.warn("Browser error reporting failed to start");
    return undefined;
  }
  return Sentry;
}

/**
 * Scripts that browsers and extensions inject, page translation rewriting React's DOM, and the
 * headless browser email link scanners open pages in.
 */
const INJECTED =
  /window\.(?:__firefox__|ethereum)\b|Failed to execute '(?:removeChild|insertBefore)' on 'Node'|^Object Not Found Matching Id:/;

/**
 * A lazy chunk that did not load (Chrome, Safari, Firefox wording): a dropped connection or a
 * deploy the recovery reload could not fix. The error boundary offers a refresh.
 */
const CHUNK_LOAD =
  /^(?:Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/;

/**
 * The network rather than the code (offline, a timeout or cancellation, a gateway answer while the
 * server restarts, a chunk that did not load), or someone else's code: this app only throws
 * errors, never bare objects.
 */
function isNotAppBug(error: unknown): boolean {
  if (typeof error === "object" && error !== null && !(error instanceof Error)) return true;
  if (isAbandonedRequest(error) || isServerUnreachable(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return INJECTED.test(message) || CHUNK_LOAD.test(message);
}

/**
 * React root `onCaughtError`: report errors an error boundary rendered a fallback for. Uncaught
 * render errors already reach `window.onerror`, where the SDK picks them up.
 */
export function reportCaughtReactError(error: unknown, errorInfo: ErrorInfo): void {
  if (recoveringByReload()) return;
  if (sentry) sentry.captureReactException(error, errorInfo);
  else if (pending && pending.length < MAX_PENDING) pending.push([error, errorInfo]);
  console.error(error);
}
