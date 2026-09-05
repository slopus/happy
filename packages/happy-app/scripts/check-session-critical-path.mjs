import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MODES = new Set(['evaluate-json', 'print-ego-probe']);
const REQUIRED_EVIDENCE_FIELDS = new Set([
  'resources',
  'deepLinkInteractiveMs',
  'spawnNavigateMs',
]);

class CliFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function evaluateCriticalPath(run) {
  const legacyCalls = run.resources.filter((resource) => (
    new URL(resource.name).pathname === '/v1/sessions'
  ));

  return {
    ok: legacyCalls.length === 0
      && run.deepLinkInteractiveMs <= 2_000
      && run.spawnNavigateMs <= 7_000,
    legacySessionCalls: legacyCalls.length,
    deepLinkInteractiveMs: run.deepLinkInteractiveMs,
    spawnNavigateMs: run.spawnNavigateMs,
  };
}

function parseArguments(argv) {
  const options = {};
  const expected = new Set(['--origin', '--session-id', '--mode', '--input']);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expected.has(flag) || value === undefined || value.startsWith('--') || options[flag] !== undefined) {
      throw new CliFailure('INVALID_ARGS');
    }
    options[flag] = value;
  }

  if (options['--origin'] === undefined || options['--session-id'] === undefined || options['--mode'] === undefined) {
    throw new CliFailure('INVALID_ARGS');
  }

  const origin = validateOrigin(options['--origin']);
  const sessionId = options['--session-id'];
  if (sessionId.trim() === '') {
    throw new CliFailure('INVALID_SESSION');
  }

  const mode = options['--mode'];
  if (!MODES.has(mode)) {
    throw new CliFailure('INVALID_MODE');
  }
  if (mode === 'evaluate-json' && options['--input'] === undefined) {
    throw new CliFailure('MISSING_INPUT');
  }
  if (mode === 'print-ego-probe' && options['--input'] !== undefined) {
    throw new CliFailure('INVALID_ARGS');
  }

  return { origin, sessionId, mode, input: options['--input'] };
}

function validateOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliFailure('INVALID_ORIGIN');
  }

  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new CliFailure('INVALID_ORIGIN');
  }
  return parsed.origin;
}

function validateEvidence(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new CliFailure('INVALID_EVIDENCE');
  }
  if (Object.keys(run).length !== REQUIRED_EVIDENCE_FIELDS.size
    || Object.keys(run).some((key) => !REQUIRED_EVIDENCE_FIELDS.has(key))) {
    throw new CliFailure('INVALID_EVIDENCE');
  }
  if (![...REQUIRED_EVIDENCE_FIELDS].every((field) => Object.hasOwn(run, field))) {
    throw new CliFailure('INVALID_EVIDENCE');
  }
  if (!Array.isArray(run.resources)) {
    throw new CliFailure('INVALID_EVIDENCE');
  }
  for (const resource of run.resources) {
    if (resource === null || typeof resource !== 'object' || Array.isArray(resource)
      || Object.keys(resource).length !== 1 || !Object.hasOwn(resource, 'name')
      || typeof resource.name !== 'string') {
      throw new CliFailure('INVALID_EVIDENCE');
    }
    try {
      new URL(resource.name);
    } catch {
      throw new CliFailure('INVALID_EVIDENCE');
    }
  }
  for (const field of ['deepLinkInteractiveMs', 'spawnNavigateMs']) {
    if (typeof run[field] !== 'number' || !Number.isFinite(run[field]) || run[field] < 0) {
      throw new CliFailure('INVALID_EVIDENCE');
    }
  }
  return run;
}

function readEvidence(inputPath) {
  let source;
  try {
    source = readFileSync(inputPath, 'utf8');
  } catch {
    throw new CliFailure('UNREADABLE_INPUT');
  }
  try {
    return validateEvidence(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliFailure('INVALID_JSON');
    }
    throw error;
  }
}

function renderEgoProbe(origin, sessionId) {
  return `(() => {
  const namespace = '__happySessionCriticalPathProbe';
  if (globalThis[namespace]) return globalThis[namespace];

  const state = {
    origin: ${JSON.stringify(origin)},
    sessionId: ${JSON.stringify(sessionId)},
    deepLink: {},
    spawn: {},
  };
  const now = () => performance.now();
  // ResourceTiming is delivered on completion, so an observer alone cannot
  // prove the absence of a request still in flight at either freeze boundary.
  // Install before any app script and retain initiation times independently.
  const requestStarts = [];
  let requestCollectionFailed = false;
  let trackedFetch;
  let trackedOpen;
  let trackedSend;
  let xhrPrototype;
  const captureRequest = (input) => {
    try {
      const value = typeof input === 'string' || input instanceof URL ? input : input.url;
      const url = new URL(value, document.baseURI);
      if (url.pathname === '/v1/sessions') {
        requestStarts.push({ startTime: now(), name: 'https://redacted.invalid/v1/sessions' });
      }
    } catch {
      requestCollectionFailed = true;
    }
  };
  try {
    if (document.readyState !== 'loading' || document.scripts.length !== 0
      || typeof globalThis.fetch !== 'function' || typeof XMLHttpRequest !== 'function') {
      throw new Error();
    }
    const originalFetch = globalThis.fetch;
    xhrPrototype = XMLHttpRequest.prototype;
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;
    if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') throw new Error();
    const xhrUrls = new WeakMap();
    trackedFetch = function (...args) {
      captureRequest(args[0]);
      return Reflect.apply(originalFetch, this, args);
    };
    trackedOpen = function (...args) {
      const result = Reflect.apply(originalOpen, this, args);
      xhrUrls.set(this, args[1]);
      return result;
    };
    trackedSend = function (...args) {
      captureRequest(xhrUrls.get(this));
      return Reflect.apply(originalSend, this, args);
    };
    globalThis.fetch = trackedFetch;
    xhrPrototype.open = trackedOpen;
    xhrPrototype.send = trackedSend;
  } catch {
    requestCollectionFailed = true;
  }
  const resourceEntries = () => performance.getEntriesByType('resource');
  const requiredMark = (value) => {
    if (typeof value !== 'number') throw new Error('Critical-path lifecycle mark is missing.');
    return value;
  };
  const requiredSnapshot = (value) => {
    if (!Array.isArray(value)) throw new Error('Critical-path lifecycle mark is missing.');
    return value;
  };
  const navigationStart = () => {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry && typeof entry.startTime === 'number' ? entry.startTime : 0;
  };
  const requireCollection = (path) => {
    try {
      if (requestCollectionFailed || globalThis.fetch !== trackedFetch
        || !xhrPrototype || xhrPrototype.open !== trackedOpen || xhrPrototype.send !== trackedSend) {
        requestCollectionFailed = true;
      }
    } catch {
      requestCollectionFailed = true;
    }
    if (path.collectionFailed || requestCollectionFailed) {
      const error = new Error('Critical-path resource collection failed.');
      error.code = 'RESOURCE_COLLECTION_FAILED';
      throw error;
    }
  };
  const disconnect = (path) => {
    path.closed = true;
    try {
      if (path.observer) path.observer.disconnect();
    } catch {
      path.collectionFailed = true;
    }
  };
  const failCollection = (path) => {
    path.collectionFailed = true;
    disconnect(path);
  };
  const beginResourceCollection = (key, startMark, readStart) => {
    const previous = state[key];
    const path = { resources: [], collectionFailed: false, closed: false };
    // Replace the generation before any fallible timing or observer work.
    state[key] = path;
    disconnect(previous);
    const retain = (entry) => {
      if (path.closed || !entry || typeof entry !== 'object' || typeof entry.name !== 'string'
        || typeof entry.startTime !== 'number' || entry.startTime < path.resourceStart
        || path.seenEntries.has(entry)) return;
      path.seenEntries.add(entry);
      // These legacy requests are counted at initiation, including failures and
      // requests that have not produced ResourceTiming by the freeze boundary.
      if ((entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
        && new URL(entry.name).pathname === '/v1/sessions') return;
      path.resources.push({ name: entry.name });
    };
    try {
      path[startMark] = readStart();
      path.resourceStart = path[startMark];
      path.seenEntries = new WeakSet();
      path.observer = new PerformanceObserver((list) => {
        if (path.closed) return;
        try {
          for (const entry of list.getEntries()) retain(entry);
        } catch {
          failCollection(path);
        }
      });
      path.drainResources = () => {
        for (const entry of path.observer.takeRecords()) retain(entry);
      };
      path.observer.observe({ type: 'resource' });
      for (const entry of resourceEntries()) retain(entry);
    } catch {
      failCollection(path);
    }
    requireCollection(path);
  };
  const freezeResources = (path) => {
    requireCollection(path);
    if (!Array.isArray(path.snapshot)) {
      try {
        path.drainResources();
        const end = now();
        path.snapshot = Object.freeze([
          ...path.resources,
          ...requestStarts.filter(entry => entry.startTime >= path.resourceStart && entry.startTime <= end)
            .map(entry => ({ name: entry.name })),
        ]);
      } catch {
        path.collectionFailed = true;
      } finally {
        disconnect(path);
      }
      requireCollection(path);
    }
  };
  const freezeDeepLink = () => {
    const path = state.deepLink;
    if (typeof path.headerVisible === 'number' && typeof path.latestMessageComplete === 'number') {
      freezeResources(path);
    }
  };
  const freezeSpawn = () => {
    const path = state.spawn;
    if (typeof path.turnCompletion === 'number') {
      freezeResources(path);
    }
  };

  const probe = {
    initFreshDeepLink() {
      beginResourceCollection('deepLink', 'start', navigationStart);
    },
    markFreshHeaderVisible() {
      state.deepLink.headerVisible = now();
      freezeDeepLink();
    },
    markFreshLatestMessageComplete() {
      state.deepLink.latestMessageComplete = now();
      freezeDeepLink();
    },
    startNewTextSession() {
      beginResourceCollection('spawn', 'sendClick', now);
    },
    markNewSessionEvent() { state.spawn.newSessionEvent = now(); },
    markLocalQueue() { state.spawn.localQueue = now(); },
    markRouteNavigation() {
      state.spawn.routeNavigation = now();
    },
    markFirstAgentEvent() { state.spawn.firstAgentEvent = now(); },
    markTurnCompletion() {
      state.spawn.turnCompletion = now();
      freezeSpawn();
    },
    collect() {
      const deepLink = state.deepLink;
      const spawn = state.spawn;
      requireCollection(deepLink);
      requireCollection(spawn);
      const deepLinkInteractiveMs = Math.max(
        requiredMark(deepLink.headerVisible),
        requiredMark(deepLink.latestMessageComplete),
      ) - requiredMark(deepLink.start);
      const spawnNavigateMs = requiredMark(spawn.routeNavigation) - requiredMark(spawn.sendClick);
      requiredMark(spawn.turnCompletion);
      return {
        resources: [...requiredSnapshot(deepLink.snapshot), ...requiredSnapshot(spawn.snapshot)],
        deepLinkInteractiveMs,
        spawnNavigateMs,
      };
    },
  };
  globalThis[namespace] = probe;
  return probe;
})()`;
}

function main(argv) {
  const { origin, sessionId, mode, input } = parseArguments(argv);
  if (mode === 'print-ego-probe') {
    process.stdout.write(`${renderEgoProbe(origin, sessionId)}\n`);
    return 0;
  }

  const result = evaluateCriticalPath(readEvidence(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

function writeFailure(error) {
  const code = error instanceof CliFailure ? error.code : 'INTERNAL_ERROR';
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    writeFailure(error);
    process.exitCode = 1;
  }
}
