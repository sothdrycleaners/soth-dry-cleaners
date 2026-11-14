import axios, { AxiosHeaders } from 'axios';
import { isInvalidSessionResponse, recordAuthExitReason } from '@/lib/auth-session';

const devApiUrl = import.meta.env.DEV ? import.meta.env.VITE_API_URL : undefined;

function getApiBaseUrl(): string {
  // In production, keep requests same-origin so the backend host is not exposed in the browser.
  if (!devApiUrl) {
    return '/api';
  }

  return `${devApiUrl}/api`;
}

export const API_BASE_URL = getApiBaseUrl();

// Use the frontend origin in production so uploads and profile images can be proxied through the same site.
export const API_ORIGIN = devApiUrl || window.location.origin;

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - Add JWT token to all requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('soth_token');
    if (token) {
      config.headers = AxiosHeaders.from(config.headers);
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const requestUrl = String(error.config?.url || '');
    const hasAuthHeader = Boolean(
      error.config?.headers?.Authorization ||
      error.config?.headers?.authorization
    );
    const isPublicAuthRoute =
      requestUrl.includes('/auth/login') ||
      requestUrl.includes('/auth/register') ||
      requestUrl.includes('/auth/forgot-password');

    const storePostLoginRedirect = () => {
      if (typeof window === 'undefined') return;

      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!currentPath || currentPath === '/login' || currentPath === '/create-account' || currentPath === '/forgot-password') {
        return;
      }

      sessionStorage.setItem('soth_post_login_redirect', currentPath);
      sessionStorage.setItem('soth_post_login_redirect_reason', 'auth-interruption');
    };

    if (isInvalidSessionResponse(status, error.response?.data) && hasAuthHeader && !isPublicAuthRoute) {
      // Clear the session only when the server confirms this token is unusable.
      recordAuthExitReason('api-confirmed-invalid-session');
      storePostLoginRedirect();
      localStorage.removeItem('soth_token');
      localStorage.removeItem('soth_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
