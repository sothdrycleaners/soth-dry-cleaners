import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requireManager?: boolean; // Admin or Manager
  requireSystemAdmin?: boolean;
  requireOperations?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ 
  children, 
  requireAdmin = false,
  requireManager = false,
  requireSystemAdmin = false,
  requireOperations = false
}) => {
  const { isAuthenticated, isAdmin, isManager, isSystemAdmin, canAccessOperations, loading, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.role === 'OPERATIONS' && !user.desktop_workspace_enabled && !['/operations', '/profile', '/help'].includes(location.pathname)) {
    return <Navigate to="/operations" replace />;
  }

  // Keep temporary-password users on their profile until they replace it.
  if (user?.must_change_password && location.pathname !== '/profile') {
    return <Navigate to="/profile#change-password" replace />;
  }

  if (requireOperations && !canAccessOperations) {
    return <Navigate to="/dashboard" replace />;
  }

  // Strict admin-only check
  if (requireAdmin && !isAdmin) {
    return <Navigate to="/orders" replace />;
  }

  // Strict systems-admin-only check
  if (requireSystemAdmin && !isSystemAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  // Manager or Admin check
  if (requireManager && !isAdmin && !isManager) {
    return <Navigate to="/orders" replace />;
  }

  return <>{children}</>;
};
