import type { Adapter, ChatInstance } from "chat";

/**
 * A Chat SDK adapter whose vendor module loads on first initialize, so
 * unconfigured processes never import it. Chat and the surface initialize an
 * adapter before using it; until then only `name`, `initialize`, and the given
 * synchronous helpers answer. Afterwards every property comes from the loaded
 * adapter, so optional capabilities are detected exactly as before. The loaded
 * adapter hands itself to Chat for inbound messages, so `create` must apply
 * any behavior overrides to it rather than relying on the helpers.
 */
export function lazyChatAdapter(
  name: string,
  create: () => Promise<Adapter>,
  helpers: Partial<Adapter> = {},
): Adapter {
  let implementation: Adapter | undefined;
  let loading: Promise<Adapter> | undefined;
  const load = () => {
    loading ??= create().then(
      (adapter) => {
        implementation = adapter;
        return adapter;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };
  const shell = {
    ...helpers,
    name,
    initialize: async (chat: ChatInstance) => (await load()).initialize(chat),
  };
  return new Proxy(shell, {
    get(target, key) {
      if (Object.hasOwn(target, key) || !implementation) return Reflect.get(target, key);
      const value = Reflect.get(implementation, key, implementation);
      return typeof value === "function" ? value.bind(implementation) : value;
    },
  }) as unknown as Adapter;
}
