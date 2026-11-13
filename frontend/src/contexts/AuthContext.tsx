import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import SessionTimeoutModal from '@/components/SessionTimeoutModal';
import SessionExpiredModal from '@/components/SessionExpiredModal';

interface User {
  id: number;
  tenant_id?: number;
  email: string;
  full_name: string;
  phone?: string;
  role: 'ADMIN' | 'MANAGER' | 'DESKTOP_AGENT' | 'OPERATIONS';
  operations_access_enabled?: boolean;
  desktop_workspace_enabled?: boolean;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  is_system_admin?: boolean;
  admin_pin_enabled?: boolean;
  profile_picture?: string;
  profile_picture_url?: string;
  session_timeout_minutes?: number;  // User's session timeout preference (5-30 minutes)
  must_change_password?: boolean;  // Flag to force password change on next login
  auth_provider?: 'LOCAL' | null;
  branch_id?: number | null;
  branch_name?: string | null;
  created_at?: string;
  updated_at?: string;
  last_login?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isSystemAdmin: boolean;
  isManager: boolean;
  isCashier: boolean;
  canAccessOperations: boolean;
  canAccessDesktopWorkspace: boolean;
  canAccessUserManagement: boolean;
  canAccessSettings: boolean;
  canAccessReports: boolean;
  canAccessInventory: boolean;
  canEditCustomers: boolean;
  canDeleteCustomers: boolean;
  canEditPrices: boolean;
  canCancelOrders: boolean;
  canApproveExpenses: boolean;
  login: (email: string, password: string) => Promise<{ requiresPin: boolean; challengeToken?: string }>;
  completeAdminPinLogin: (challengeToken: string, pin: string) => Promise<void>;
  requestAdminPinReset: (challengeToken?: string) => Promise<string>;
  logout: (preserveRedirect?: boolean) => void;
  updateUser: (updatedUser: User) => void;
  refreshUser: () => void;  // Reload user from localStorage
  loading: boolean;
}

interface LoginResponse {
  token?: string;
  user?: User;
  requires_pin?: boolean;
  challenge_token?: string;
  error?: string;
  locked?: boolean;
  locked_until?: string;
  remaining_minutes?: number;
  attempts_remaining?: number;
}

interface LoginError extends Error {
  locked?: boolean;
  locked_until?: string;
  remaining_minutes?: number;
  attempts_remaining?: number;
}

const isLoginError = (error: unknown): error is LoginError => error instanceof Error;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Session timeout constants
const DEFAULT_INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const WARNING_TIME = 60 * 1000; // Show warning 60 seconds before timeout
const TOKEN_KEY = 'soth_token';
const USER_KEY = 'soth_user';
const SESSION_TIMEOUT_KEY = 'soth_session_timeout'; // Store user's preferred timeout
const LAST_ACTIVITY_KEY = 'soth_last_activity';
const POST_LOGIN_REDIRECT_KEY = 'soth_post_login_redirect';
const POST_LOGIN_REDIRECT_REASON_KEY = 'soth_post_login_redirect_reason';
// Writing on every scroll/click event would thrash localStorage
const ACTIVITY_WRITE_INTERVAL = 5 * 1000;

/** Expiry claim from the JWT, in milliseconds, or null if it cannot be read */
function readTokenExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function storePostLoginRedirect() {
  if (typeof window === 'undefined') return;

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (!currentPath || currentPath === '/login' || currentPath === '/create-account' || currentPath === '/forgot-password') {
    return;
  }

  sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, currentPath);
  sessionStorage.setItem(POST_LOGIN_REDIRECT_REASON_KEY, 'auth-interruption');
}

function consumePostLoginRedirect() {
  try {
    const redirectPath = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    const redirectReason = sessionStorage.getItem(POST_LOGIN_REDIRECT_REASON_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_REASON_KEY);
    return redirectReason === 'auth-interruption' ? redirectPath : null;
  } catch {
    // Ignore storage errors.
  }

  return null;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [showExpiredModal, setShowExpiredModal] = useState(false);
  const [warningSeconds, setWarningSeconds] = useState(60);
  const navigate = useNavigate();
  const inactivityTimer = useRef<NodeJS.Timeout | null>(null);
  const warningTimer = useRef<NodeJS.Timeout | null>(null);
  const lastActivityWrite = useRef(0);

  // Get session timeout from user object (user preference or default)
  const getSessionTimeout = useCallback(() => {
    try {
      const userStr = localStorage.getItem(USER_KEY);
      if (userStr) {
        const user = JSON.parse(userStr);
        const timeoutMinutes = user.session_timeout_minutes || 15; // Default 15 minutes
        const timeoutMs = timeoutMinutes * 60 * 1000; // Convert to milliseconds
        return timeoutMs;
      }
    } catch (error) {
      // Failed to parse user object, use default
    }
    return DEFAULT_INACTIVITY_TIMEOUT;
  }, []);

  /**
   * The inactivity timer lives in memory, so it dies with the tab. Persisting the
   * last activity lets us tell, on the next visit, whether the session went stale
   * while the app was closed or the phone was asleep.
   */
  const markActivity = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastActivityWrite.current < ACTIVITY_WRITE_INTERVAL) return;
    lastActivityWrite.current = now;
    localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  }, []);

  const isSessionStale = useCallback(
    (storedToken: string) => {
      const expiry = readTokenExpiry(storedToken);
      if (expiry !== null && Date.now() >= expiry) return true;

      const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      if (!Number.isFinite(lastActivity) || lastActivity <= 0) return false;

      return Date.now() - lastActivity > getSessionTimeout();
    },
    [getSessionTimeout]
  );

  // Logout function (defined before resetInactivityTimer to avoid dependency issues)
  const logout = useCallback((preserveRedirect = false) => {
    if (preserveRedirect) {
      storePostLoginRedirect();
    } else {
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_REASON_KEY);
    }
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    
    // Clear dashboard period selections on logout
    localStorage.removeItem('dashboardPeriod');
    localStorage.removeItem('financialDashboardPeriod');
    
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
    }
    if (warningTimer.current) {
      clearTimeout(warningTimer.current);
    }
    
    setShowTimeoutWarning(false);
    setShowExpiredModal(false);
    navigate('/login');
  }, [navigate]);

  // Reset inactivity timer
  const resetInactivityTimer = useCallback(() => {
    // Clear existing timers
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
    }
    if (warningTimer.current) {
      clearTimeout(warningTimer.current);
    }
    
    // Hide warning if user becomes active
    if (showTimeoutWarning) {
      setShowTimeoutWarning(false);
    }
    
    if (token) {
      const timeout = getSessionTimeout();

      markActivity();

      // Set warning timer (show warning before actual timeout)
      warningTimer.current = setTimeout(() => {
        setShowTimeoutWarning(true);
        setWarningSeconds(60);
      }, timeout - WARNING_TIME);
      
      // Set actual timeout timer
      inactivityTimer.current = setTimeout(() => {
        setShowTimeoutWarning(false);
        setShowExpiredModal(true);
        setTimeout(() => {
          logout(true);
        }, 3000); // Give user 3 seconds to see the message before redirecting
      }, timeout);
    }
  }, [token, logout, showTimeoutWarning, getSessionTimeout, markActivity]);

  // Refresh user from localStorage (called after settings update)
  const refreshUser = useCallback(() => {
    try {
      const storedUser = localStorage.getItem(USER_KEY);
      if (storedUser) {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
        // Reset inactivity timer to use new timeout value
        resetInactivityTimer();
      }
    } catch (error) {
      // Failed to refresh user
    }
  }, [resetInactivityTimer]);

  // Track user activity
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
      document.addEventListener(event, resetInactivityTimer);
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, resetInactivityTimer);
      });
      if (inactivityTimer.current) {
        clearTimeout(inactivityTimer.current);
      }
    };
  }, [resetInactivityTimer]);

  // Load user from localStorage on mount
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedUser = localStorage.getItem(USER_KEY);
    
    if (storedToken && storedUser) {
      // Check staleness before restoring, otherwise a session that expired while
      // the app was closed would silently resume.
      if (isSessionStale(storedToken)) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        setLoading(false);
        return;
      }

      try {
        const parsedUser = JSON.parse(storedUser);
        setToken(storedToken);
        setUser(parsedUser);
        resetInactivityTimer();
      } catch (error) {
        console.error('Failed to parse stored user:', error);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }
    
    setLoading(false);
  }, [resetInactivityTimer, isSessionStale]);

  // Private profile-picture URLs expire. Refresh the authenticated user on
  // session restore and periodically while the session remains active.
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    let refreshing = false;
    const refreshSignedProfilePicture = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch(API_BASE_URL + '/auth/me', {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        if (!payload.user || cancelled) return;
        let previousUser: User = payload.user;
        try {
          const stored = localStorage.getItem(USER_KEY);
          if (stored) previousUser = { ...JSON.parse(stored), ...payload.user };
        } catch {
          // Use the fresh authenticated response if local storage is malformed.
        }
        setUser(previousUser);
        localStorage.setItem(USER_KEY, JSON.stringify(previousUser));
      } catch {
        // Keep the current session if a background refresh temporarily fails.
      } finally {
        refreshing = false;
      }
    };

    void refreshSignedProfilePicture();
    const interval = window.setInterval(() => void refreshSignedProfilePicture(), 12 * 60 * 60 * 1000);
    window.addEventListener('focus', refreshSignedProfilePicture);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshSignedProfilePicture);
    };
  }, [token]);

  // A backgrounded tab keeps its token but stops running timers, so re-check
  // whenever the user comes back to the app.
  useEffect(() => {
    const checkOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (storedToken && isSessionStale(storedToken)) {
        logout(true);
      }
    };

    document.addEventListener('visibilitychange', checkOnReturn);
    window.addEventListener('focus', checkOnReturn);

    return () => {
      document.removeEventListener('visibilitychange', checkOnReturn);
      window.removeEventListener('focus', checkOnReturn);
    };
  }, [isSessionStale, logout]);

  const establishSession = (data: LoginResponse) => {
    if (!data.token || !data.user) throw new Error('The server returned an incomplete sign-in response.');
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    markActivity(true);
    resetInactivityTimer();
    if (data.user.must_change_password) {
      navigate('/profile#change-password');
      return;
    }
    const redirectPath = consumePostLoginRedirect();
    navigate(redirectPath || (data.user.role === 'OPERATIONS' ? '/operations' : '/dashboard'));
  };

  const login = async (email: string, password: string) => {
    try {
      const loginUrl = `${API_BASE_URL}/auth/login`;
      
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data: LoginResponse = await response.json().catch(() => ({}));

      if (!response.ok) {
        const loginErr: LoginError = new Error(data.error || 'Login failed');
        if (data.locked) {
          loginErr.locked = true;
          loginErr.locked_until = data.locked_until;
          loginErr.remaining_minutes = data.remaining_minutes;
        }
        if (data.attempts_remaining !== undefined) {
          loginErr.attempts_remaining = data.attempts_remaining;
        }
        throw loginErr;
      }
      if (data.requires_pin && data.challenge_token) {
        return { requiresPin: true, challengeToken: data.challenge_token };
      }
      establishSession(data);
      return { requiresPin: false };
    } catch (error: unknown) {
      console.error('❌ Login error:', error);
      const message = error instanceof Error ? error.message : 'Login failed';
      const rethrow: LoginError = new Error(message);
      if (isLoginError(error) && error.locked) {
        rethrow.locked = true;
        rethrow.locked_until = error.locked_until;
        rethrow.remaining_minutes = error.remaining_minutes;
      }
      if (isLoginError(error) && error.attempts_remaining !== undefined) {
        rethrow.attempts_remaining = error.attempts_remaining;
      }
      throw rethrow;
    }
  };

  const completeAdminPinLogin = async (challengeToken: string, pin: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/verify-admin-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${challengeToken}` },
      body: JSON.stringify({ pin }),
    });
    const data: LoginResponse = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'PIN verification failed.');
    establishSession(data);
  };

  const requestAdminPinReset = async (challengeToken?: string) => {
    const requestToken = challengeToken || token;
    if (!requestToken) throw new Error('Your sign-in session has expired. Sign in again.');
    const url = challengeToken
      ? `${API_BASE_URL}/auth/request-admin-pin-reset`
      : `${API_BASE_URL}/auth/admin-pin/request-disable`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestToken}` },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to send the PIN request.');
    return data.message || 'Your PIN removal request has been sent to the systems administrator.';
  };

  // Modal handlers
  const handleStayLoggedIn = () => {
    setShowTimeoutWarning(false);
    resetInactivityTimer();
  };

  const handleTimeout = () => {
    setShowTimeoutWarning(false);
    setShowExpiredModal(true);
    setTimeout(() => {
      logout(true);
    }, 3000); // Give user 3 seconds to see the expired message before redirecting
  };

  const handleExpiredLogin = () => {
    setShowExpiredModal(false);
    navigate('/login');
  };

  const updateUser = useCallback((updatedUser: User) => {
    setUser(updatedUser);
    localStorage.setItem(USER_KEY, JSON.stringify(updatedUser));
  }, []);

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!token && !!user,
    isAdmin: user?.role === 'ADMIN',
    isSystemAdmin: user?.role === 'ADMIN' && !!user?.is_system_admin,
    isManager: user?.role === 'MANAGER',
    isCashier: user?.role === 'DESKTOP_AGENT' || (user?.role === 'OPERATIONS' && !!user?.desktop_workspace_enabled),
    canAccessOperations: user?.role === 'ADMIN' || user?.role === 'MANAGER' || user?.role === 'OPERATIONS' || (user?.role === 'DESKTOP_AGENT' && !!user?.operations_access_enabled),
    canAccessDesktopWorkspace: user?.role !== 'OPERATIONS' || !!user?.desktop_workspace_enabled,
    canAccessUserManagement: user?.role === 'ADMIN' || user?.role === 'MANAGER',
    // Every settings write is ADMIN-only on the server; keep the UI honest
    canAccessSettings: user?.role === 'ADMIN',
    canAccessReports: user?.role === 'ADMIN' || user?.role === 'MANAGER' || user?.role === 'DESKTOP_AGENT' || (user?.role === 'OPERATIONS' && !!user?.desktop_workspace_enabled),
    canAccessInventory: !!user,
    canEditCustomers: user?.role === 'ADMIN',
    canDeleteCustomers: user?.role === 'ADMIN',
    canEditPrices: user?.role === 'ADMIN' || user?.role === 'MANAGER',
    canCancelOrders: user?.role === 'ADMIN' || user?.role === 'MANAGER',
    canApproveExpenses: user?.role === 'ADMIN' || user?.role === 'MANAGER',
    login,
    completeAdminPinLogin,
    requestAdminPinReset,
    logout,
    updateUser,
    refreshUser,
    loading,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SessionTimeoutModal
        isOpen={showTimeoutWarning}
        onClose={() => setShowTimeoutWarning(false)}
        onStayLoggedIn={handleStayLoggedIn}
        onTimeout={handleTimeout}
        remainingSeconds={warningSeconds}
      />
      <SessionExpiredModal
        isOpen={showExpiredModal}
        onLogin={handleExpiredLogin}
      />
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
