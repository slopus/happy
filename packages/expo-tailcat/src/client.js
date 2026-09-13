'use strict';

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Tunnel options are required');
  }
  if (typeof options.address !== 'string' || !/^tc[A-Za-z0-9_-]+$/.test(options.address) || options.address.length > 16384) {
    throw new TypeError('Invalid Tailcat address');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new TypeError('port must be between 1 and 65535');
  }
  const result = { address: options.address, port: options.port };
  if (options.scheme !== undefined) {
    if (!['http', 'https'].includes(options.scheme)) throw new TypeError('scheme must be http or https');
    result.scheme = options.scheme;
  }
  if (options.hostname !== undefined) {
    if (typeof options.hostname !== 'string' || !options.hostname || options.hostname.length > 253 || /[\/\\:@?#\[\]\s]/.test(options.hostname)) {
      throw new TypeError('hostname must be a DNS name or IPv4 address');
    }
    result.hostname = options.hostname;
  }
  if (options.derpMapUrl !== undefined) {
    let url;
    try { url = new URL(options.derpMapUrl); } catch { throw new TypeError('derpMapUrl must be an HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('derpMapUrl must be an HTTPS URL');
    result.derpMapUrl = url.href;
  }
  if (options.connectTimeoutMs !== undefined) {
    if (!Number.isInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 100 || options.connectTimeoutMs > 120000) {
      throw new TypeError('connectTimeoutMs must be between 100 and 120000');
    }
    result.connectTimeoutMs = options.connectTimeoutMs;
  }
  return result;
}

// Kept separate so unit tests do not need to load React Native or Expo.
function createClient(getNativeModule) {
  return {
    async openTunnel(options) {
      const normalized = normalizeOptions(options);
      const native = getNativeModule();
      const result = JSON.parse(await native.openTunnel(JSON.stringify(normalized)));
      let closePromise;
      return Object.freeze({
        id: result.id,
        httpUrl: result.httpUrl,
        wsUrl: result.wsUrl,
        close() {
          if (!closePromise) {
            closePromise = Promise.resolve().then(() => native.closeTunnel(result.id)).catch(error => {
              closePromise = undefined;
              throw error;
            });
          }
          return closePromise;
        },
      });
    },
    async closeAllTunnels() { await getNativeModule().closeAllTunnels(); },
    addTunnelsClosedListener(listener) {
      return getNativeModule().addListener('onTunnelsClosed', listener);
    },
  };
}

module.exports = { createClient, normalizeOptions };