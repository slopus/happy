import type { LogoAvatarActivity } from "@rakazo/core";
import { logoAvatarStatusActivity } from "@rakazo/core";
import type { ReactNode } from "react";
import { createContext, startTransition, useContext, useEffect, useRef, useState } from "react";

export interface BotAvatarActivitySource {
  subscribe(listener: () => void): () => void;
  getActivity(botId: string, status?: string): LogoAvatarActivity;
}
const emptySource: BotAvatarActivitySource = {
  subscribe: () => () => {},
  getActivity: (_id, status) => logoAvatarStatusActivity(status),
};
const Activity = createContext<BotAvatarActivitySource>(emptySource);

/** The app supplies its own event store; shared UI owns no global session state. */
export function BotAvatarActivityProvider({
  source,
  children,
}: {
  source: BotAvatarActivitySource;
  children: ReactNode;
}) {
  return <Activity value={source}>{children}</Activity>;
}
/** Updates as a transition: a busy thread must not starve urgent work such as navigation. */
export function useBotAvatarActivity(identity: string, status?: string): LogoAvatarActivity {
  const source = useContext(Activity);
  const [, setVersion] = useState(0);
  const activity = source.getActivity(identity, status);
  const rendered = useRef(activity);
  rendered.current = activity;
  useEffect(() => {
    const refresh = () => {
      if (source.getActivity(identity, status) !== rendered.current)
        startTransition(() => setVersion((version) => version + 1));
    };
    const unsubscribe = source.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, [source, identity, status]);
  return activity;
}
