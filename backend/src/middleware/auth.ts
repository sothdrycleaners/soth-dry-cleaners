import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { query } from '../config/database';
import { UserRole, UserStatus } from '../models/User';
import { isSystemAdminEmail } from '../utils/systemAdmin';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    full_name: string;
    role: UserRole;
    tenant_id?: number;
    is_system_admin?: boolean;
    branch_id?: number | null;
  };
  tenant?: {
    id: number;
  };
  file?: Express.Multer.File;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    
    try {
      const decoded = jwt.verify(token, config.jwt.secret) as any;

      if (
        decoded.tenant_id !== undefined &&
        Number(decoded.tenant_id) !== config.tenancy.deploymentTenantId
      ) {
        return res.status(403).json({ error: 'Session belongs to a different tenant deployment' });
      }
      
      // Handle both old (userId) and new (id) token formats for backward compatibility
      const userId = Number(decoded.id || decoded.userId);
      
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        console.error('❌ No user ID found in token');
        return res.status(401).json({ error: 'Invalid token format' });
      }
      
      req.user = {
        id: userId,
        email: decoded.email,
        full_name: decoded.full_name,
        role: decoded.role,
        tenant_id: Number(decoded.tenant_id) || config.tenancy.deploymentTenantId,
        is_system_admin: decoded.is_system_admin ?? isSystemAdminEmail(decoded.email),
        // Tokens issued before branches existed simply have no branch
        branch_id: decoded.branch_id ?? null
      };

      try {
        const live = await query(
          `SELECT id, email, full_name, role, status, tenant_id, branch_id
           FROM users
           WHERE id = $1 AND tenant_id = $2
           LIMIT 1`,
          [userId, req.tenant?.id ?? config.tenancy.deploymentTenantId]
        );
        const currentUser = live.rows[0];

        if (!currentUser || currentUser.status !== UserStatus.ACTIVE) {
          return res.status(401).json({ error: 'Your account is inactive. Contact an administrator.' });
        }

        // Trust live authorization data, never role/status claims cached in a JWT.
        req.user = {
          id: Number(currentUser.id),
          email: currentUser.email,
          full_name: currentUser.full_name,
          role: currentUser.role as UserRole,
          tenant_id: Number(currentUser.tenant_id),
          is_system_admin: isSystemAdminEmail(currentUser.email),
          branch_id: currentUser.branch_id == null ? null : Number(currentUser.branch_id),
        };
      } catch (error) {
        // Fail closed rather than authorizing stale claims if account status
        // could not be verified.
        console.error('Unable to verify the current account status:', error);
        return res.status(503).json({ error: 'Unable to verify your account. Please try again.' });
      }
      
      next();
    } catch (error) {
      console.error('❌ Token verification failed:', error);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    if (!roles.map((r) => String(r).toUpperCase()).includes(String(req.user.role || '').toUpperCase())) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role 
      });
    }
    
    next();
  };
};

// Middleware to require admin role
export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (req.user.role !== UserRole.ADMIN) {
    return res.status(403).json({ 
      error: 'Access denied. Administrator role required.',
      current: req.user.role 
    });
  }
  
  next();
};

export const requireSystemAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.role !== UserRole.ADMIN || !req.user.is_system_admin) {
    return res.status(403).json({
      error: 'Access denied. Systems Administrator privileges required.',
      current: req.user.role,
    });
  }

  next();
};

// Middleware to require admin or manager role
export const requireAdminOrManager = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.MANAGER) {
    return res.status(403).json({ 
      error: 'Access denied. Administrator or Manager role required.',
      current: req.user.role 
    });
  }
  
  next();
};
