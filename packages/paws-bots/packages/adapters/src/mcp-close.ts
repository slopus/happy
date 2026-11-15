/** Leave room to reconnect, while allowing the SDK's four-second stdio shutdown. */
export const MCP_CLOSE_TIMEOUT_MS = 5_000;

/** Best-effort cleanup: observe late failures without waiting forever for a transport. */
export async function closeMcpResource(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(close)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MCP_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
