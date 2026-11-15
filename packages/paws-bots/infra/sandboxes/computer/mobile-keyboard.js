const DEFAULT_INPUT_LENGTH = 100;

/** Return the remote key changes represented by a mobile input event. */
export function mobileInputChanges(oldValue, newValue, selectionStart = newValue.length) {
  const newLength = Math.max(selectionStart ?? newValue.length, newValue.length);
  const oldLength = oldValue.length;
  let inputCount = newLength - oldLength;
  let backspaces = inputCount < 0 ? -inputCount : 0;

  for (let index = 0; index < Math.min(oldLength, newLength); index += 1) {
    if (newValue.charAt(index) !== oldValue.charAt(index)) {
      inputCount = newLength - index;
      backspaces = oldLength - index;
      break;
    }
  }

  return {
    backspaces,
    text: newValue.slice(newLength - inputCount, newLength),
  };
}

/** True for browsers that can present a touch keyboard. */
export function isTouchBrowser(navigatorLike = globalThis.navigator, windowLike = globalThis) {
  return Boolean(navigatorLike?.maxTouchPoints > 0 || "ontouchstart" in windowLike);
}

/**
 * Add a relative touch trackpad that drives noVNC's mouse canvas.
 *
 * Touches that begin on the desktop itself stay with noVNC (tap = move the pointer there and
 * click), which is the only way to reach some spots; the trackpad only keeps its cursor in sync.
 * Touches that begin in the free area around the desktop are consumed here: dragging moves the
 * pointer relative to where it is, a tap clicks where the pointer is. They are consumed at the
 * touch level (not pointer capture) so iOS never turns them into compatibility mouse events
 * that noVNC would clamp to the nearest desktop edge.
 */
export function attachMobileTrackpad(
  rfb,
  { button, surface, documentTarget = globalThis.document, sensitivity = 1.5 },
) {
  if (!button || !surface || !documentTarget || rfb.viewOnly) return () => {};

  let enabled = false;
  let touchId = null;
  let desktopTouchId = null;
  let lastX = 0;
  let lastY = 0;
  let cursorX = null;
  let cursorY = null;
  let moved = false;

  const canvas = () => surface.querySelector("canvas");
  const clampToCanvas = (x, y) => {
    const bounds = canvas()?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(bounds.left, Math.min(bounds.right - 1, x)),
      y: Math.max(bounds.top, Math.min(bounds.bottom - 1, y)),
    };
  };
  const onCanvas = (x, y) => {
    const bounds = canvas()?.getBoundingClientRect();
    return Boolean(
      bounds && x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom,
    );
  };
  // While a button is down, noVNC covers the page with a capture overlay and only releases it
  // when a mouseup reaches that overlay (the canvas handler stops propagation). A synthetic
  // mouseup must therefore go to the overlay, which forwards it to the canvas and releases.
  const captureOverlay = () => {
    const overlay = documentTarget.getElementById?.("noVNC_mouse_capture_elem");
    return overlay && overlay.style?.display !== "none" ? overlay : null;
  };
  const mouse = (type, buttonNumber = 0) => {
    const target = (type === "mouseup" && captureOverlay()) || canvas();
    if (!target || cursorX == null || cursorY == null) return;
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cursorX,
        clientY: cursorY,
        button: buttonNumber,
        buttons: type === "mousedown" ? 1 : 0,
      }),
    );
  };
  const positionCursor = (deltaX = 0, deltaY = 0) => {
    const target = canvas();
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    cursorX ??= bounds.left + bounds.width / 2;
    cursorY ??= bounds.top + bounds.height / 2;
    const next = clampToCanvas(cursorX + deltaX * sensitivity, cursorY + deltaY * sensitivity);
    if (!next) return;
    cursorX = next.x;
    cursorY = next.y;
    mouse("mousemove");
  };
  const setEnabled = (next) => {
    enabled = next;
    touchId = null;
    desktopTouchId = null;
    const label = enabled ? "Use direct touch" : "Use trackpad";
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", enabled);
    surface.classList.toggle("trackpad-active", enabled);
    rfb.showDotCursor = enabled;
    if (enabled) positionCursor();
  };
  const onButtonClick = () => setEnabled(!enabled);
  const consume = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const changedTouch = (event, identifier) =>
    Array.from(event.changedTouches ?? []).find((touch) => touch.identifier === identifier);
  const stillDown = (event, identifier) =>
    Array.from(event.touches ?? []).some((touch) => touch.identifier === identifier);
  const followDesktopTouch = (touch) => {
    // Direct touch on the desktop: noVNC moves the pointer there; keep the trackpad in step.
    const next = clampToCanvas(touch.clientX, touch.clientY);
    if (next) {
      cursorX = next.x;
      cursorY = next.y;
    }
  };
  const onTouchStart = (event) => {
    if (!enabled) return;
    // A touchstart can carry several new touches; classify each one.
    let freeArea = false;
    for (const touch of Array.from(event.changedTouches ?? [])) {
      if (onCanvas(touch.clientX, touch.clientY)) {
        if (desktopTouchId === null || !stillDown(event, desktopTouchId)) {
          desktopTouchId = touch.identifier;
          followDesktopTouch(touch);
        }
        continue;
      }
      freeArea = true;
      // Extra fingers never take over a live gesture; a touch whose end was lost does not block it.
      if (touchId !== null && stillDown(event, touchId)) continue;
      touchId = touch.identifier;
      lastX = touch.clientX;
      lastY = touch.clientY;
      moved = false;
    }
    // Any free-area touch is consumed so iOS never turns it into compatibility mouse events.
    if (freeArea) consume(event);
  };
  const onTouchMove = (event) => {
    if (!enabled) return;
    const desktopTouch = desktopTouchId === null ? null : changedTouch(event, desktopTouchId);
    if (desktopTouch) followDesktopTouch(desktopTouch);
    if (touchId === null) return;
    const touch = changedTouch(event, touchId);
    if (!touch) return;
    consume(event);
    const deltaX = touch.clientX - lastX;
    const deltaY = touch.clientY - lastY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 1) moved = true;
    positionCursor(deltaX, deltaY);
    lastX = touch.clientX;
    lastY = touch.clientY;
  };
  const finishTouch = (event, click) => {
    if (!enabled) return;
    if (desktopTouchId !== null && changedTouch(event, desktopTouchId)) desktopTouchId = null;
    if (touchId === null) return;
    const touch = changedTouch(event, touchId);
    if (!touch) {
      // Another finger lifted: swallow it so it cannot become a compatibility click.
      if (!onCanvas(event.changedTouches?.[0]?.clientX, event.changedTouches?.[0]?.clientY)) {
        consume(event);
      }
      return;
    }
    consume(event);
    touchId = null;
    if (click && !moved) {
      mouse("mousedown");
      mouse("mouseup");
    }
  };
  const onTouchEnd = (event) => finishTouch(event, true);
  const onTouchCancel = (event) => finishTouch(event, false);
  const listen = { capture: true, passive: false };

  button.hidden = false;
  button.addEventListener("click", onButtonClick);
  surface.addEventListener("touchstart", onTouchStart, listen);
  surface.addEventListener("touchmove", onTouchMove, listen);
  surface.addEventListener("touchend", onTouchEnd, listen);
  surface.addEventListener("touchcancel", onTouchCancel, listen);

  return () => {
    button.removeEventListener("click", onButtonClick);
    surface.removeEventListener("touchstart", onTouchStart, listen);
    surface.removeEventListener("touchmove", onTouchMove, listen);
    surface.removeEventListener("touchend", onTouchEnd, listen);
    surface.removeEventListener("touchcancel", onTouchCancel, listen);
    surface.classList.remove("trackpad-active");
    rfb.showDotCursor = false;
  };
}

const CONTROL_KEYSYM = 0xffe3;
const CONTROL_CODE = "ControlLeft";
const MOBILE_KEYS = {
  Escape: [0xff1b, "Escape"],
  Tab: [0xff09, "Tab"],
  Return: [0xff0d, "Enter"],
  ArrowLeft: [0xff51, "ArrowLeft"],
  ArrowUp: [0xff52, "ArrowUp"],
  ArrowRight: [0xff53, "ArrowRight"],
  ArrowDown: [0xff54, "ArrowDown"],
};

function keyNameFromEvent(event) {
  const target = event?.target?.closest?.("[data-key]") || event?.target;
  const name = target?.getAttribute?.("data-key");
  return typeof name === "string" ? name : "";
}

/**
 * Connect a text field to noVNC so touch keyboards can type into the remote
 * desktop, and expose Esc, Tab, Ctrl, and arrows.
 * The native app sets `window.__rakazoNativeKeys` and calls `rakazoComputerKeyboard.run`.
 */
export function attachMobileKeyboard(
  rfb,
  {
    button,
    input,
    keyBar,
    Keyboard,
    backspaceKeysym,
    lookupKeysym,
    pasteText,
    documentTarget = globalThis.document,
    windowTarget = documentTarget?.defaultView ?? globalThis,
  },
) {
  if (!button || !input || !Keyboard || !documentTarget || rfb.viewOnly) return () => {};

  let lastValue = "";
  let closeOnButtonClick = false;
  let controlLatched = false;
  let keyboardTouchAt = 0;
  let keyTouchAt = 0;
  const pageChrome = !windowTarget?.__rakazoNativeKeys;
  const visualViewport = windowTarget?.visualViewport;
  const viewportRoot = documentTarget.documentElement;
  const updateVisibleViewport = () => {
    if (documentTarget.activeElement !== input || !visualViewport) return;
    viewportRoot.style.setProperty("--mobile-visual-height", `${visualViewport.height}px`);
    viewportRoot.style.setProperty("--mobile-visual-top", `${visualViewport.offsetTop}px`);
  };
  const clearVisibleViewport = () => {
    viewportRoot.style.removeProperty("--mobile-visual-height");
    viewportRoot.style.removeProperty("--mobile-visual-top");
  };
  const resetInput = () => {
    input.value = "_".repeat(DEFAULT_INPUT_LENGTH - 1);
    lastValue = input.value;
  };
  const setOpen = (open) => {
    const label = open ? "Hide keyboard" : "Show keyboard";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", open);
    viewportRoot.classList.toggle("mobile-keyboard-open", open);
    // The capture field is invisible; screen readers only meet it while it takes typing.
    if (open) {
      input.removeAttribute("aria-hidden");
      updateVisibleViewport();
    } else {
      input.setAttribute("aria-hidden", "true");
      clearVisibleViewport();
    }
    rfb.focusOnClick = !open;
  };
  const namedKey = (name) => {
    if (name === "Backspace") return [backspaceKeysym, "Backspace"];
    return MOBILE_KEYS[name] ?? null;
  };
  const controlButton = () => keyBar?.querySelector?.('[data-key="Control"]');
  const setControlLatched = (next) => {
    controlLatched = next;
    const control = controlButton();
    control?.setAttribute?.("aria-pressed", String(next));
    control?.classList?.toggle?.("active", next);
  };
  const sendTap = (keysym, code, explicitControl) => {
    if (keysym == null) return;
    const latched = controlLatched;
    const control = Boolean(explicitControl) || latched;
    if (control) rfb.sendKey(CONTROL_KEYSYM, CONTROL_CODE, true);
    if (control) {
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
    } else {
      rfb.sendKey(keysym, code);
    }
    if (control) rfb.sendKey(CONTROL_KEYSYM, CONTROL_CODE, false);
    if (latched) setControlLatched(false);
  };
  const insertText = (text, explicitControl) => {
    if (typeof text !== "string" || !text) return;
    for (const character of text) {
      if (character === "\n" || character === "\r") {
        const key = namedKey("Return");
        sendTap(key[0], key[1], explicitControl);
        continue;
      }
      sendTap(lookupKeysym(character.codePointAt(0)), undefined, explicitControl);
    }
  };
  const repeatBackspace = (count) => {
    const times = Number(count);
    if (!Number.isInteger(times) || times < 1) return;
    const capped = Math.min(times, 500);
    for (let index = 0; index < capped; index += 1) rfb.sendKey(backspaceKeysym, "Backspace");
  };
  const run = (command) => {
    if (!command || typeof command !== "object") return;
    if (command.type === "text" || command.type === "char") {
      insertText(command.text, command.control === true);
      return;
    }
    if (command.type === "backspace") {
      repeatBackspace(command.count);
      return;
    }
    if (command.type !== "key") return;
    const key = namedKey(command.name);
    if (!key) return;
    sendTap(key[0], key[1], command.control === true);
  };
  const show = () => {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    const length = input.value.length;
    input.setSelectionRange?.(length, length);
  };
  const hide = () => input.blur();
  const onButtonPressStart = () => {
    if (documentTarget.activeElement === input) closeOnButtonClick = true;
  };
  const toggleKeyboard = () => {
    const shouldHide = closeOnButtonClick || documentTarget.activeElement === input;
    closeOnButtonClick = false;
    if (shouldHide) hide();
    else show();
  };
  // iOS only shows the keyboard when focus happens inside the touch, and click is too late.
  const onKeyboardTouchEnd = (event) => {
    keyboardTouchAt = Date.now();
    if (event.cancelable) event.preventDefault();
    toggleKeyboard();
  };
  const onKeyboardClick = () => {
    if (Date.now() - keyboardTouchAt < 700) return;
    toggleKeyboard();
  };
  const onFocus = () => setOpen(true);
  const onBlur = () => setOpen(false);
  const onInput = (event) => {
    if (!lastValue) resetInput();
    const newValue = event.target.value;
    const changes = mobileInputChanges(lastValue, newValue, event.target.selectionStart);
    if (
      typeof pasteText === "function" &&
      event.inputType === "insertFromPaste" &&
      changes.text &&
      pasteText(changes.text)
    ) {
      resetInput();
      return;
    }
    repeatBackspace(changes.backspaces);
    insertText(changes.text, false);

    if (newValue.length > 2 * DEFAULT_INPUT_LENGTH) {
      resetInput();
    } else if (newValue.length < 1) {
      resetInput();
      input.blur();
      setTimeout(() => input.focus(), 0);
    } else {
      lastValue = newValue;
    }
  };
  const activateKey = (name) => {
    if (name === "Control") {
      setControlLatched(!controlLatched);
      return;
    }
    const key = namedKey(name);
    if (!key) return;
    sendTap(key[0], key[1], false);
  };
  const onKeyPointerDown = (event) => {
    if (!keyNameFromEvent(event)) return;
    event.preventDefault();
  };
  const onKeyTouchEnd = (event) => {
    const name = keyNameFromEvent(event);
    if (!name) return;
    keyTouchAt = Date.now();
    if (event.cancelable) event.preventDefault();
    activateKey(name);
  };
  const onKeyClick = (event) => {
    const name = keyNameFromEvent(event);
    if (!name || Date.now() - keyTouchAt < 700) return;
    event.preventDefault?.();
    activateKey(name);
  };
  const isChromeTarget = (target) => {
    if (target === button || button.contains?.(target)) return true;
    if (button.parentElement?.contains?.(target)) return true;
    if (keyBar && (target === keyBar || keyBar.contains?.(target))) return true;
    return false;
  };
  const keepOpen = (event) => {
    if (documentTarget.activeElement !== input) return;
    // Let chrome controls (keyboard, paste, trackpad, keys) receive the tap.
    if (isChromeTarget(event.target)) return;
    event.preventDefault();
  };
  // Touch/pointer first: blur can run before a synthesized mousedown on mobile.
  const keepOpenEvents = ["pointerdown", "touchstart", "mousedown"];

  resetInput();
  const keyboard = new Keyboard(input);
  keyboard.onkeyevent = (keysym, code, down) => rfb.sendKey(keysym, code, down);
  keyboard.grab();
  if (pageChrome) {
    button.hidden = false;
    if (keyBar) keyBar.hidden = false;
  } else {
    input.setAttribute("aria-hidden", "true");
  }
  if (windowTarget) windowTarget.rakazoComputerKeyboard = { run };
  for (const type of keepOpenEvents) button.addEventListener(type, onButtonPressStart);
  button.addEventListener("touchend", onKeyboardTouchEnd, { passive: false });
  button.addEventListener("click", onKeyboardClick);
  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  if (keyBar) {
    for (const type of keepOpenEvents) {
      keyBar.addEventListener(type, onKeyPointerDown, { passive: false });
    }
    keyBar.addEventListener("touchend", onKeyTouchEnd, { passive: false });
    keyBar.addEventListener("click", onKeyClick);
  }
  visualViewport?.addEventListener("resize", updateVisibleViewport);
  visualViewport?.addEventListener("scroll", updateVisibleViewport);
  for (const type of keepOpenEvents) {
    documentTarget.documentElement.addEventListener(type, keepOpen, true);
  }

  return () => {
    keyboard.ungrab?.();
    for (const type of keepOpenEvents) button.removeEventListener(type, onButtonPressStart);
    button.removeEventListener("touchend", onKeyboardTouchEnd);
    button.removeEventListener("click", onKeyboardClick);
    input.removeEventListener("input", onInput);
    input.removeEventListener("focus", onFocus);
    input.removeEventListener("blur", onBlur);
    if (keyBar) {
      for (const type of keepOpenEvents) keyBar.removeEventListener(type, onKeyPointerDown);
      keyBar.removeEventListener("touchend", onKeyTouchEnd);
      keyBar.removeEventListener("click", onKeyClick);
    }
    visualViewport?.removeEventListener("resize", updateVisibleViewport);
    visualViewport?.removeEventListener("scroll", updateVisibleViewport);
    viewportRoot.classList.remove("mobile-keyboard-open");
    clearVisibleViewport();
    for (const type of keepOpenEvents) {
      documentTarget.documentElement.removeEventListener(type, keepOpen, true);
    }
    if (windowTarget) delete windowTarget.rakazoComputerKeyboard;
  };
}
