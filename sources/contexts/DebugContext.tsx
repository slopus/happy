import React, { createContext, useContext } from 'react';
import { useConfigStore } from '@/store/configStore';

interface IDebugContext {
  showDebugInfo: boolean;
  toggleDebugInfo: () => void;
}

const DebugContext = createContext<IDebugContext | undefined>(undefined);

const DebugProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showDebugInfo, toggleDebugInfo } = useConfigStore();

  return (
    <DebugContext.Provider value={{ showDebugInfo, toggleDebugInfo }}>
      {children}
    </DebugContext.Provider>
  );
};

DebugProvider.displayName = 'DebugProvider';
export { DebugProvider };

export const useDebug = (): IDebugContext => {
  const context = useContext(DebugContext);
  if (context === undefined) {
    throw new Error('useDebug must be used within a DebugProvider');
  }
  return context;
}; 