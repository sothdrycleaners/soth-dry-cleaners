import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { API_ORIGIN } from '@/lib/api';
import api from '@/lib/api';
import { resolveProfilePictureUrl } from '@/lib/profilePicture';
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  DollarSign,
  BarChart3,
  Settings,
  HelpCircle,
  LogOut,
  ClipboardList,
  Truck,
  Shield,
  Receipt,
  TrendingUp,
  MessageSquare,
  Wallet,
  FileText,
  ClipboardCheck,
  PackageCheck,
  KeyRound,
  X,
  Megaphone,
  WashingMachine,
} from 'lucide-react';
import sothLogo from '@/assets/SOTH_Logo.png';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'New Order', href: '/orders/new', icon: ShoppingCart },
  { name: 'Orders', href: '/orders', icon: ClipboardList },
  { name: 'Payments', href: '/payments', icon: Wallet },
  { name: 'Expenses', href: '/expenses', icon: Receipt },
  { name: 'Customers', href: '/customers', icon: Users },
  { name: 'Messages', href: '/messages?tab=team', icon: MessageSquare },
  { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
  { name: 'Price List', href: '/prices', icon: DollarSign },
  { name: 'Inventory', href: '/inventory', icon: Package },
  { name: 'Deliveries', href: '/deliveries', icon: Truck },
  { name: 'Reports', href: '/reports', icon: BarChart3 },
];

const secondaryNavigation = [
  { name: 'User Management', href: '/user-management', icon: Shield, opsLead: true },
  { name: 'Password Resets', href: '/password-reset-requests', icon: KeyRound, opsLead: true },
  { name: 'Refund Requests', href: '/refund-requests', icon: ClipboardCheck, adminOnly: true },
  { name: 'Financial Dashboard', href: '/financial', icon: TrendingUp, adminOnly: true },
  { name: 'Accounting', href: '/accounting', icon: FileText, adminOnly: true },
  { name: 'Payroll', href: '/payroll', icon: Users, adminOnly: true },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Help', href: '/help', icon: HelpCircle },
];

const operationsNavigation = [
  { name: 'Operations Workspace', href: '/operations?view=dashboard', view: 'dashboard', icon: LayoutDashboard },
  { name: 'Work Queue', href: '/operations?view=queue', view: 'queue', icon: ClipboardList },
  { name: 'Messages', href: '/operations?view=messages', view: 'messages', icon: MessageSquare },
  { name: 'Reports', href: '/operations?view=reports', view: 'reports', icon: BarChart3 },
  { name: 'Delivered Items', href: '/operations?view=delivered', view: 'delivered', icon: PackageCheck },
];

interface SidebarProps {
  isOpen: boolean;
  hasInteracted?: boolean; // Track if user has manually toggled sidebar
  onClose?: () => void;
  demoMode?: boolean;
  operationsMode?: boolean;
}

export function Sidebar({ isOpen, hasInteracted = false, onClose, demoMode = false, operationsMode = false }: SidebarProps) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const { user, token, isAdmin, isCashier, isManager, canAccessSettings, canAccessOperations, canAccessDesktopWorkspace } = useAuth();
  const [teamUnreadCount, setTeamUnreadCount] = useState(0);
  useEffect(() => {
    if (!user || !token) return;
    const refresh = () => api.get('/operations/unread-count', { headers: { Authorization: `Bearer ${token}` } })
      .then(response => setTeamUnreadCount(Number(response.data.count) || 0))
      .catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 20000);
    return () => window.clearInterval(timer);
  }, [user?.id, token]);

  // Filter main navigation based on role
  const visibleNavigation = demoMode || operationsMode ? operationsNavigation : navigation.filter(item => {
    if (item.href === '/operations') return canAccessOperations;
    if (user?.role === 'OPERATIONS' && !user.desktop_workspace_enabled) return false;
    if (isAdmin) return true; // Admin sees everything

    // MANAGER: Access to most features (including reports - operational only)
    if (isManager) {
      // Manager CAN see these pages
      if (item.href === '/') return true; // Dashboard
      if (item.href === '/orders/new') return true; // New Order
      if (item.href === '/orders') return true; // Orders
      if (item.href === '/payments') return true; // Payments
      if (item.href === '/expenses') return true; // Expenses
      if (item.href === '/customers') return true; // Customers
      if (item.href === '/prices') return true; // Price List
      if (item.href === '/inventory') return true; // Inventory
      if (item.href === '/deliveries') return true; // Deliveries
      if (item.href === '/messages') return true; // Messages
      if (item.href === '/reports') return true; // Reports (operational, no accounting)

      return false;
    }

    // DESKTOP_AGENT: Limited access (NO inventory, but CAN see personal performance in reports)
    if (isCashier) {
      // Explicitly BLOCKED from Desktop Agents
      if (item.href === '/inventory') return false;

      // Desktop Agent CAN see these pages
      if (item.href === '/') return true; // Dashboard
      if (item.href === '/orders/new') return true; // New Order
      if (item.href === '/orders') return true; // Orders
      if (item.href === '/payments') return true; // Payments
      if (item.href === '/expenses') return true; // Expenses
      if (item.href === '/customers') return true; // Customers
      if (item.href === '/reports') return true; // Reports (personal performance only)
      if (item.href === '/prices') return true; // Price List
      if (item.href === '/deliveries') return true; // Deliveries
      if (item.href === '/messages') return true; // Messages
    }

    return false; // Default: hide from non-authenticated or unknown roles
  });

  // Filter secondary navigation based on permissions
  const visibleSecondaryNavigation = operationsMode
    ? (canAccessDesktopWorkspace ? [{ name: 'Exit Operations', href: '/dashboard', icon: LogOut }] : [])
    : demoMode ? [] : secondaryNavigation.filter(item => {
    // Admin-only pages (User Management, Financial, Accounting, Payroll)
    if (item.adminOnly && !isAdmin) return false;
    if (item.opsLead && !isAdmin && !isManager) return false;

    // Settings: Check permission
    if (item.href === '/settings' && !canAccessSettings) return false;

    return true;
  });

  return (
    <aside className={cn(
      "fixed left-0 top-0 z-40 h-screen w-64 bg-sidebar border-r border-sidebar-border flex flex-col",
      hasInteracted && "transition-transform duration-300",
      !isOpen && "-translate-x-full"
    )}>
      {/* Logo */}
      <div className="flex h-16 sm:h-20 items-center justify-between border-b border-sidebar-border px-4 flex-shrink-0">
        <img
          src={sothLogo}
          alt="Soth Dry Cleaners"
          className="h-12 sm:h-14 w-auto object-contain"
        />
        {isMobile && onClose && (
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors"
            aria-label="Close menu"
            title="Close menu"
          >
            <X className="h-5 w-5 text-sidebar-foreground/80" />
          </button>
        )}
      </div>

      {/* Main Navigation - Scrollable */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin scrollbar-thumb-sidebar-border scrollbar-track-transparent">
        <ul className="space-y-1">
          {visibleNavigation.map((item) => {
            const currentView = new URLSearchParams(location.search).get('view') ?? 'dashboard';
            const isActive = demoMode || operationsMode
              ? 'view' in item && currentView === item.view
              : location.pathname === item.href.split('?')[0] || (item.href.split('?')[0] !== '/' && location.pathname.startsWith(item.href.split('?')[0]));
            const displayName = isCashier && item.href === '/reports' ? 'My Performance' : item.name;
            return (
              <li key={item.name}>
                <Link
                  to={item.href}
                  className={cn('nav-item', isActive && 'active')}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span className="font-medium truncate">{displayName}</span>
                  {item.name === 'Messages' && teamUnreadCount > 0 && (
                    <span className="ml-auto rounded-full bg-orange-500 px-2 py-0.5 text-[10px] font-bold leading-4 text-white">
                      {teamUnreadCount > 99 ? '99+' : teamUnreadCount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Operations is a separate workspace, placed after the regular staff navigation. */}
        {!demoMode && !operationsMode && canAccessOperations && (
          <div className="mt-4 border-t border-sidebar-border pt-4">
            <Link
              to="/operations"
              className={cn('nav-item', location.pathname === '/operations' && 'active')}
            >
              <WashingMachine className="h-5 w-5 flex-shrink-0" />
              <span className="font-medium truncate">Operations</span>
            </Link>
          </div>
        )}

        {/* Secondary Navigation */}
        {visibleSecondaryNavigation.length > 0 && (
          <div className="mt-6 pt-6 border-t border-sidebar-border">
            <ul className="space-y-1">
              {visibleSecondaryNavigation.map((item) => {
                const isActive = location.pathname === item.href;
                return (
                  <li key={item.name}>
                    <Link
                      to={item.href}
                      className={cn('nav-item', isActive && 'active')}
                    >
                      <item.icon className="h-5 w-5 flex-shrink-0" />
                      <span className="truncate">{item.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </nav>

      {/* User Section - Always Visible at Bottom */}
      <div className="border-t border-sidebar-border p-3 sm:p-4 flex-shrink-0 bg-sidebar">
        {demoMode ? (
          <div className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg bg-sidebar-accent/50">
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-sidebar-primary flex items-center justify-center flex-shrink-0">
              <span className="text-sidebar-primary-foreground font-semibold text-xs sm:text-sm">OP</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs sm:text-sm font-medium text-sidebar-foreground truncate">Operations Preview</p>
              <p className="text-xs text-sidebar-foreground/60 truncate">Demo workspace</p>
            </div>
          </div>
        ) : <Link
          to="/profile"
          className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg hover:bg-sidebar-accent transition-colors group"
        >
          {(user?.profile_picture || user?.profile_picture_url) ? (
            <>
              <img
                src={resolveProfilePictureUrl(user, API_ORIGIN)}
                alt={user.full_name}
                className="h-9 w-9 sm:h-10 sm:w-10 rounded-full object-cover flex-shrink-0"
                onError={(e) => {
                  const imgElement = e.currentTarget;
                  const fallbackElement = imgElement.nextElementSibling as HTMLElement;
                  imgElement.classList.add('hidden');
                  if (fallbackElement) {
                    fallbackElement.classList.remove('hidden');
                    fallbackElement.classList.add('flex');
                  }
                }}
              />
              <div className="hidden h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-sidebar-primary items-center justify-center flex-shrink-0">
                <span className="text-sidebar-primary-foreground font-semibold text-xs sm:text-sm">
                  {user?.full_name.split(' ').map(n => n[0]).join('').toUpperCase() || 'U'}
                </span>
              </div>
            </>
          ) : (
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-sidebar-primary flex items-center justify-center flex-shrink-0">
              <span className="text-sidebar-primary-foreground font-semibold text-xs sm:text-sm">
                {user?.full_name.split(' ').map(n => n[0]).join('').toUpperCase() || 'U'}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm font-medium text-sidebar-foreground truncate">
              {user?.full_name || 'User'}
            </p>
            <p className="text-xs text-sidebar-foreground/60 truncate">
              {user?.email || ''}
            </p>
          </div>
        </Link>}
      </div>
    </aside>
  );
}
