const chains = new Map<string, Promise<void>>();

// One chain per bot so a protected paste follows the click that focused the field.
export function enqueueTeachComputerInput(botId: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(botId) ?? Promise.resolve();
  const result = previous.then(task);
  chains.set(
    botId,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
