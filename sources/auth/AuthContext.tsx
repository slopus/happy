import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence } from '@/sync/persistence';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { isPasswordProtectionEnabled, clearPasswordData } from '@/auth/passwordSecurity';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    isPasswordProtected: boolean;
    isSessionUnlocked: boolean;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
    unlockSession: () => void;
    checkPasswordProtection: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
  const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
  const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
  const [isPasswordProtected, setIsPasswordProtected] = useState(false);
  const [isSessionUnlocked, setIsSessionUnlocked] = useState(false);

  // Check password protection status on mount
  useEffect(() => {
    checkPasswordProtection();
  }, []);

  const checkPasswordProtection = async () => {
    try {
      const hasPassword = await isPasswordProtectionEnabled();
      setIsPasswordProtected(hasPassword);

      // If no password protection, session is automatically unlocked
      if (!hasPassword) {
        setIsSessionUnlocked(true);
      }
    } catch (error) {
      console.error('Failed to check password protection:', error);
      setIsPasswordProtected(false);
      setIsSessionUnlocked(true);
    }
  };

  const login = async (token: string, secret: string) => {
    const newCredentials: AuthCredentials = { token, secret };
    const success = await TokenStorage.setCredentials(newCredentials);
    if (success) {
      await syncCreate(newCredentials);
      setCredentials(newCredentials);
      setIsAuthenticated(true);
    } else {
      throw new Error('Failed to save credentials');
    }
  };

  const unlockSession = () => {
    setIsSessionUnlocked(true);
  };

  const logout = async () => {
    trackLogout();
    clearPersistence();
    await TokenStorage.removeCredentials();

    // Clear password data as well
    await clearPasswordData();

    // Update React state to ensure UI consistency
    setCredentials(null);
    setIsAuthenticated(false);
    setIsPasswordProtected(false);
    setIsSessionUnlocked(false);

    if (Platform.OS === 'web') {
      window.location.reload();
    } else {
      try {
        await Updates.reloadAsync();
      } catch (error) {
        // In dev mode, reloadAsync will throw ERR_UPDATES_DISABLED
        console.log('Reload failed (expected in dev mode):', error);
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        credentials,
        isPasswordProtected,
        isSessionUnlocked,
        login,
        logout,
        unlockSession,
        checkPasswordProtection,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}