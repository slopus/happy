import { createContext } from 'react';

export const AccountContext = createContext<{ token: string; accountId: string; serverUrl: string; logout?(): void; expired(): void } | null>(null);
