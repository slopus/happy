import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { initializeSync } from '@/sync/syncInit';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    useEffect(() => {
        if (credentials) {
            initializeSync(credentials);
        }
    }, [credentials]);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            setCredentials(newCredentials);
            setIsAuthenticated(true);
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const logout = async () => {
        await TokenStorage.removeCredentials();
        setCredentials(null);
        setIsAuthenticated(false);
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
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