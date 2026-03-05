export function getInspectorScript(): string {
  return `(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    var inspectMode = false;
    var hoverOverlay = null;
    var selectedOverlay = null;
    var currentTarget = null;

    // -------------------------------------------------------------------------
    // Overlay helpers
    // -------------------------------------------------------------------------
    function createOverlay(zIndex, color) {
      var el = document.createElement('div');
      el.style.cssText = [
        'position: fixed',
        'pointer-events: none',
        'box-sizing: border-box',
        'transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s',
        'z-index: ' + zIndex,
        'background: ' + color,
        'border: 2px solid rgba(59, 130, 246, 0.8)',
        'display: none',
      ].join(';');
      document.documentElement.appendChild(el);
      return el;
    }

    function positionOverlay(overlay, rect) {
      overlay.style.top    = rect.top  + 'px';
      overlay.style.left   = rect.left + 'px';
      overlay.style.width  = rect.width  + 'px';
      overlay.style.height = rect.height + 'px';
      overlay.style.display = 'block';
    }

    function hideOverlay(overlay) {
      if (overlay) overlay.style.display = 'none';
    }

    function ensureOverlays() {
      if (!hoverOverlay) {
        hoverOverlay = createOverlay(99998, 'rgba(59, 130, 246, 0.15)');
      }
      if (!selectedOverlay) {
        selectedOverlay = createOverlay(99999, 'rgba(59, 130, 246, 0.25)');
      }
    }

    // -------------------------------------------------------------------------
    // Selector generation
    // -------------------------------------------------------------------------
    function escapeCSS(str) {
      if (typeof CSS !== 'undefined' && CSS.escape) {
        return CSS.escape(str);
      }
      // Minimal fallback
      return str.replace(/([!"#$%&'()*+,./:;<=>?@[\\\\\\]^{|}~])/g, '\\\\$1');
    }

    function getNodeStep(el) {
      if (!el || el.nodeType !== 1) return '';

      var tag = el.tagName.toLowerCase();

      if (el.id) {
        return tag + '#' + escapeCSS(el.id);
      }

      var classStr = '';
      if (el.classList && el.classList.length > 0) {
        var classes = Array.prototype.slice.call(el.classList);
        classStr = classes.map(function (c) { return '.' + escapeCSS(c); }).join('');
      }

      // nth-child disambiguator
      var parent = el.parentElement;
      var nthPart = '';
      if (parent) {
        var siblings = Array.prototype.slice.call(parent.children).filter(function (s) {
          return s.tagName === el.tagName;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(el) + 1;
          nthPart = ':nth-of-type(' + idx + ')';
        }
      }

      return tag + classStr + nthPart;
    }

    function generateSelector(el) {
      var parts = [];
      var current = el;

      while (current && current !== document.documentElement && current.nodeType === 1) {
        var step = getNodeStep(current);
        if (!step) break;
        parts.unshift(step);

        // Stop early if we have a unique id anchor
        if (current.id) break;

        current = current.parentElement;
      }

      return parts.join(' > ');
    }

    // -------------------------------------------------------------------------
    // Parent context
    // -------------------------------------------------------------------------
    function describeElement(el) {
      if (!el || el.nodeType !== 1) return '';
      var tag = el.tagName.toLowerCase();
      var cls = el.classList && el.classList.length > 0
        ? '.' + Array.prototype.slice.call(el.classList).slice(0, 2).join('.')
        : '';
      return tag + cls;
    }

    function getParentContext(el) {
      var parts = [];
      var parent = el.parentElement;

      while (parent && parent !== document.documentElement && parts.length < 3) {
        var desc = describeElement(parent);
        if (desc) parts.push(desc);
        parent = parent.parentElement;
      }

      if (parts.length === 0) return '';

      // e.g. "div.hero-ctas inside section.hero"
      return parts.slice(0, 2).join(' inside ');
    }

    // -------------------------------------------------------------------------
    // postMessage helper
    // -------------------------------------------------------------------------
    function sendMessage(data) {
      var json = JSON.stringify(data);
      try {
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(json);
          return;
        }
      } catch (e) {}
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(json, '*');
          return;
        }
      } catch (e) {}
      // Same-origin fallback
      try { window.postMessage(json, '*'); } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------
    function onMouseMove(e) {
      if (!inspectMode) return;
      var target = e.target;
      if (!target || target === hoverOverlay || target === selectedOverlay) return;
      currentTarget = target;
      ensureOverlays();
      var rect = target.getBoundingClientRect();
      positionOverlay(hoverOverlay, rect);
    }

    function onMouseLeave() {
      if (!inspectMode) return;
      hideOverlay(hoverOverlay);
      currentTarget = null;
    }

    function onClick(e) {
      if (!inspectMode) return;
      var target = e.target;
      if (!target || target === hoverOverlay || target === selectedOverlay) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      ensureOverlays();
      var rect = target.getBoundingClientRect();
      positionOverlay(selectedOverlay, rect);

      var tag = target.tagName.toLowerCase();
      var classes = target.classList ? Array.prototype.slice.call(target.classList) : [];
      var id = target.id || null;
      var text = (target.textContent || '').trim().slice(0, 200);

      var outerHTML = target.outerHTML || '';
      if (outerHTML.length > 2000) {
        outerHTML = outerHTML.slice(0, 2000) + '...';
      }

      sendMessage({
        type: 'element-selected',
        selector: generateSelector(target),
        tag: tag,
        classes: classes,
        id: id || null,
        text: text,
        outerHTML: outerHTML,
        parentContext: getParentContext(target),
        boundingBox: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top  + window.scrollY),
          width:  Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }

    function attachListeners() {
      document.addEventListener('mousemove',  onMouseMove,  { capture: true, passive: true });
      document.addEventListener('mouseleave', onMouseLeave, { capture: true, passive: true });
      document.addEventListener('click',      onClick,      { capture: true });
    }

    // -------------------------------------------------------------------------
    // Inspect mode toggle
    // -------------------------------------------------------------------------
    function setInspectMode(enabled) {
      inspectMode = !!enabled;
      if (!inspectMode) {
        hideOverlay(hoverOverlay);
        hideOverlay(selectedOverlay);
        currentTarget = null;
        document.documentElement.style.cursor = '';
      } else {
        document.documentElement.style.cursor = 'crosshair';
      }
    }

    // -------------------------------------------------------------------------
    // CSS hot-reload
    // -------------------------------------------------------------------------
    function reloadStylesheets() {
      var ts = Date.now();
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      Array.prototype.slice.call(links).forEach(function (link) {
        var href = link.href || '';
        if (!href) return;
        // Strip existing ?v= param we added
        href = href.replace(/([?&])v=\\d+/, '');
        var sep = href.indexOf('?') === -1 ? '?' : '&';
        link.href = href + sep + 'v=' + ts;
      });
    }

    // -------------------------------------------------------------------------
    // Full reload with scroll restore
    // -------------------------------------------------------------------------
    function fullReload() {
      try { sessionStorage.setItem('__happy_scrollY', String(window.scrollY)); } catch (e) {}
      window.location.reload();
    }

    function restoreScroll() {
      try {
        var saved = sessionStorage.getItem('__happy_scrollY');
        if (saved !== null) {
          sessionStorage.removeItem('__happy_scrollY');
          window.scrollTo(0, parseInt(saved, 10) || 0);
        }
      } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // HMR detection
    // -------------------------------------------------------------------------
    function detectHMR() {
      var hasHMR =
        typeof window.__vite_plugin_react_preamble_installed__ !== 'undefined' ||
        typeof window.__NEXT_DATA__ !== 'undefined' ||
        typeof window.webpackHotUpdate !== 'undefined' ||
        typeof window.__turbopack_hmr__ !== 'undefined';

      sendMessage({ type: 'hmr-status', hasHMR: hasHMR });
    }

    // -------------------------------------------------------------------------
    // Message listener (commands from Happy)
    // -------------------------------------------------------------------------
    function onMessage(e) {
      var data = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (err) { return; }
      }
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'set-inspect-mode':
          setInspectMode(data.enabled);
          break;
        case 'css-update':
          reloadStylesheets();
          break;
        case 'full-reload':
          fullReload();
          break;
      }
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Left Option key forwarding to parent (for inspect hotkey)
    // -------------------------------------------------------------------------
    function attachMetaKeyListeners() {
      window.addEventListener('keydown', function(e) {
        if (e.code === 'MetaLeft' && !e.repeat) {
          sendMessage({ type: 'meta-key', state: 'down' });
        }
      }, true);
      window.addEventListener('keyup', function(e) {
        if (e.code === 'MetaLeft') {
          sendMessage({ type: 'meta-key', state: 'up' });
        }
      }, true);
      window.addEventListener('blur', function() {
        sendMessage({ type: 'meta-key', state: 'up' });
      }, true);
    }

    function init() {
      attachListeners();
      restoreScroll();
      detectHMR();
      attachMetaKeyListeners();
      window.addEventListener('message', onMessage);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();`;
}
