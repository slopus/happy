import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Only the two local dialog surfaces share this boundary. DOM order matches
// their equal-z-index painting order, including a creation dialog over details.
const modals = new Set<HTMLElement>();
const topModal = () => [...modals].filter(node => node.isConnected).sort((a, b) =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).at(-1);
const focusable = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [hidden], [type="hidden"]')
    && !element.closest('[hidden], [inert]') && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden'
    && ![...node.querySelectorAll('details:not([open])')].some(details => details.contains(element) && element !== details.querySelector('summary')));
const focusFirst = (node: HTMLElement) => (focusable(node)[0] ?? node).focus();

export function useDialogFocus(modal: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const node = ref.current; if (!node) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modal) modals.add(node);
    if (!topModal() || topModal() === node) focusFirst(node);
    const keydown = (event: KeyboardEvent) => {
      const top = topModal();
      if (top ? top !== node : !node.contains(document.activeElement)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (modal && event.key === 'Tab') {
        const items = focusable(node); const first = items[0]; const last = items.at(-1);
        if (!first) { event.preventDefault(); node.focus(); }
        else if (!node.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    const contain = (event: FocusEvent) => { if (modal && topModal() === node && !node.contains(event.target as Node)) focusFirst(node); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', contain);
    return () => {
      const ownedFocus = node.contains(document.activeElement) || topModal() === node;
      modals.delete(node);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', contain);
      if (!ownedFocus) return;
      const top = topModal();
      if (prior?.isConnected && (!top || top.contains(prior))) prior.focus();
      else if (top) focusFirst(top);
    };
  }, [modal]);
  return ref;
}

export function useNarrowDetails() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 900px)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 900px)');
    if (!query) return;
    const update = () => setNarrow(query.matches);
    update(); query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return narrow;
}
