import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('dlbtrust_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error('Invalid token');
          return res.json();
        })
        .then((json) => setUser(json.data))
        .catch(() => {
          localStorage.removeItem('dlbtrust_token');
          setToken(null);
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Login failed');
    localStorage.setItem('dlbtrust_token', json.data.token);
    setToken(json.data.token);
    setUser(json.data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('dlbtrust_token');
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
