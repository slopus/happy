import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, rpc, rpcForSpace } from "./rpc";

type SpaceRpc = { client: RpcClient; spaceId: string | null | undefined };

const SpaceRpcContext = createContext<SpaceRpc>({ client: rpc, spaceId: undefined });

/** Pins an explicit space; unset scopes inherit their parent or follow selection at the root. */
export function SpaceRpcProvider({
  spaceId,
  children,
}: {
  spaceId: string | null | undefined;
  children: ReactNode;
}) {
  const parent = useContext(SpaceRpcContext);
  const value = useMemo<SpaceRpc>(
    () =>
      spaceId === undefined
        ? parent
        : { client: spaceId === null ? createSpaceRpc(null) : rpcForSpace(spaceId), spaceId },
    [parent, spaceId],
  );
  return <SpaceRpcContext.Provider value={value}>{children}</SpaceRpcContext.Provider>;
}

/** The rpc client for the space these settings act on. */
export function useSpaceRpc(): RpcClient {
  return useContext(SpaceRpcContext).client;
}

/** The bound space, or undefined when components follow the selected space. */
export function useBoundSpaceId(): string | null | undefined {
  return useContext(SpaceRpcContext).spaceId;
}
