/**
 * Browser-to-computer terminal framing. Output from the computer is raw bytes; input is
 * `[kind:u8][length:u32be][payload]` so keystrokes and resizes share one byte stream.
 */
export const TERMINAL_INPUT = 0;
export const TERMINAL_RESIZE = 1;

export function encodeTerminalFrame(kind: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

export function encodeTerminalInput(text: string): Uint8Array<ArrayBuffer> {
  return encodeTerminalFrame(TERMINAL_INPUT, new TextEncoder().encode(text));
}

export function encodeTerminalResize(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, clampSize(cols));
  view.setUint16(2, clampSize(rows));
  return encodeTerminalFrame(TERMINAL_RESIZE, payload);
}

function clampSize(value: number) {
  return Math.min(1000, Math.max(1, Math.round(value) || 1));
}
