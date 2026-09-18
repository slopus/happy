import { createContext } from 'react';

export const AccountContext = createContext<{ token: string; accountId: string; serverUrl: string; expired(): void } | null>(null);
