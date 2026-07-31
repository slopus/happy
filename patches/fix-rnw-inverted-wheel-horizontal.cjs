/**
 * Let native horizontal scrolling work inside inverted VirtualizedLists.
 *
 * react-native-web's inverted-wheel patch (react-native-web#995) calls
 * ev.preventDefault() on EVERY wheel event that bubbles up to the list's
 * scroll node, but only ever applies deltaY. Horizontal trackpad swipes over
 * nested horizontal scrollers (markdown tables / code blocks in chat) were
 * swallowed wholesale — dragging the scrollbar was the only way to scroll
 * them sideways.
 *
 * This inserts a guard at the top of invertedWheelEventHandler: when a wheel
 * event is horizontal-dominant AND some element between the target and the
 * list can actually consume it (overflow-x auto/scroll with room to move in
 * that direction), return early so the browser scrolls it natively. All other
 * events keep today's swallow behavior, so two-finger swipes over plain chat
 * text still never trigger browser history navigation.
 *
 * Usage: `node patches/fix-rnw-inverted-wheel-horizontal.cjs`
 */
const fs = require('fs');
const path = require('path');

const MARKER = 'HAPPY PATCH fix-rnw-inverted-wheel-horizontal';
const ANCHOR = 'this.invertedWheelEventHandler = ev => {';
const GUARD = `
      // ${MARKER}: let native handle horizontal-dominant wheel events when a
      // nested horizontal scroller can consume them; fall through (and swallow)
      // otherwise so the browser's history-swipe never fires.
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        var _hpTarget = ev.target;
        var _hpRoot = this._scrollRef && this._scrollRef.getScrollableNode ? this._scrollRef.getScrollableNode() : null;
        while (_hpTarget && _hpTarget !== _hpRoot && _hpTarget.nodeType === 1) {
          if (_hpTarget.scrollWidth > _hpTarget.clientWidth + 1) {
            var _hpOx = window.getComputedStyle(_hpTarget).overflowX;
            if (_hpOx === 'auto' || _hpOx === 'scroll') {
              if ((ev.deltaX < 0 && _hpTarget.scrollLeft > 0) ||
                  (ev.deltaX > 0 && _hpTarget.scrollLeft < _hpTarget.scrollWidth - _hpTarget.clientWidth - 1)) {
                return;
              }
            }
          }
          _hpTarget = _hpTarget.parentElement;
        }
      }`;

const targets = [
    'dist/vendor/react-native/VirtualizedList/index.js',
    'dist/cjs/vendor/react-native/VirtualizedList/index.js',
];

for (const rel of targets) {
    const file = path.resolve(__dirname, '..', 'node_modules', 'react-native-web', rel);
    if (!fs.existsSync(file)) {
        console.warn('[fix-rnw-inverted-wheel-horizontal] missing', file, '— skipping');
        continue;
    }
    let src = fs.readFileSync(file, 'utf8');
    if (src.includes(MARKER)) {
        console.log('[fix-rnw-inverted-wheel-horizontal] already patched:', rel);
        continue;
    }
    const occurrences = src.split(ANCHOR).length - 1;
    if (occurrences !== 1) {
        throw new Error(`[fix-rnw-inverted-wheel-horizontal] expected 1 anchor in ${rel}, found ${occurrences}`);
    }
    src = src.replace(ANCHOR, ANCHOR + GUARD);
    fs.writeFileSync(file, src);
    console.log('[fix-rnw-inverted-wheel-horizontal] patched:', rel);
}
