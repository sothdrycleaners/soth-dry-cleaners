import { Response } from 'express';
import { validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'crypto';
import { query } from '../config/database';
import { config } from '../config';
import { AuthRequest } from '../middleware/auth';
import { UserRole, UserStatus } from '../models/User';
import { userNotificationService } from '../services/user-notification.service';
import { createNotification } from '../services/notification.service';
import { getSystemAdminEmails, isSystemAdminEmail } from '../utils/systemAdmin';
import { getEffectiveBargainLimit } from '../utils/roleLimits';
import { createProfilePictureAccessUrl, uploadProfileImageToSupabase } from '../services/supabaseStorage.service';
import { 
  logFailedLogin, 
  logSuccessfulLogin, 
  logAccountLocked, 
  logSuspiciousActivity 
} from '../utils/activityLogger';

const tableHasColumn = async (tableName: string, columnName: string): Promise<boolean> => {
  const result = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [tableName, columnName]
  );

  return result.rows[0]?.exists === true;
};

const createAdminPinHash = (pin: string, userId: number, tenantId: number): string => {
  const configuredPepper = process.env.ADMIN_PIN_PEPPER?.trim();
  const usablePepper = configuredPepper && !/^(CHANGE_THIS|YOUR_|GENERATE_)/i.test(configuredPepper)
    ? configuredPepper
    : config.jwt.secret;
  return createHmac('sha256', usablePepper)
    .update(`${tenantId}:${userId}:${pin}`)
    .digest('hex');
};

const isAdminPinHashMatch = (pin: string, storedHash: string, userId: number, tenantId: number): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(storedHash || '')) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(createAdminPinHash(pin, userId, tenantId), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const getAdminPinChallenge = (req: AuthRequest) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!token) throw new Error('PIN sign-in session has expired. Sign in again.');

  const decoded = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
  if (
    decoded.purpose !== 'admin_pin_challenge' ||
    Number(decoded.tenant_id) !== config.tenancy.deploymentTenantId ||
    !Number.isSafeInteger(Number(decoded.id))
  ) {
    throw new Error('PIN sign-in session is invalid. Sign in again.');
  }
  return { userId: Number(decoded.id), tenantId: Number(decoded.tenant_id) };
};

export const register = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password, full_name, phone, role } = req.body;
    const tenantId = config.tenancy.deploymentTenantId;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Self-service registrations always require systems-admin approval.
    const status = UserStatus.PENDING;
    const allowedRoles = [UserRole.ADMIN, UserRole.MANAGER, UserRole.DESKTOP_AGENT, UserRole.OPERATIONS];
    const userRole = allowedRoles.includes(role) ? role : UserRole.DESKTOP_AGENT;

    // New users inherit the current role limits configured in Settings.
    // This prevents a newly registered agent from falling back to stale/null defaults.
    const roleLimitsResult = await query(
      `SELECT MAX(max_bargain_amount) AS max_bargain_amount,
              MAX(max_item_bargain_amount) AS max_item_bargain_amount
       FROM users
       WHERE role = $1 AND tenant_id = $2`,
      [userRole, tenantId]
    );
    const configuredLimits = roleLimitsResult.rows[0] || {};
    const maxBargainAmount = getEffectiveBargainLimit(userRole, configuredLimits.max_bargain_amount);
    const maxItemBargainAmount = Number(configuredLimits.max_item_bargain_amount) || Math.round(maxBargainAmount * 0.25);

    const existingUserResult = await query(
      `SELECT id, email, deleted_at
       FROM users
       WHERE LOWER(email) = LOWER($1)
         AND tenant_id = $2
       LIMIT 1`,
      [email, tenantId]
    );

    let newUser;

    if (existingUserResult.rows.length > 0) {
      const existingUser = existingUserResult.rows[0];

      if (existingUser.deleted_at) {
        const hasDeletedBy = await tableHasColumn('users', 'deleted_by');
        const restoreQuery = hasDeletedBy
          ? `UPDATE users
             SET password = $1,
                 full_name = $2,
                 phone = $3,
                 role = $4,
                 status = $5,
                 created_by = $6,
                 deleted_at = NULL,
                 deleted_by = NULL,
                 rejection_reason = NULL,
                 must_change_password = FALSE,
                 failed_login_attempts = 0,
                 account_locked_until = NULL,
                 last_failed_login = NULL,
                 max_bargain_amount = $7,
                 max_item_bargain_amount = $8,
                 updated_at = NOW()
               WHERE id = $9 AND tenant_id = $10
             RETURNING id, email, full_name, phone, role, status, created_at`
          : `UPDATE users
             SET password = $1,
                 full_name = $2,
                 phone = $3,
                 role = $4,
                 status = $5,
                 created_by = $6,
                 deleted_at = NULL,
                 rejection_reason = NULL,
                 must_change_password = FALSE,
                 failed_login_attempts = 0,
                 account_locked_until = NULL,
                 last_failed_login = NULL,
                 updated_at = NOW()
             WHERE id = $7 AND tenant_id = $8
             RETURNING id, email, full_name, phone, role, status, created_at`;

        const restoreValues = hasDeletedBy
          ? [
              hashedPassword,
              full_name,
              phone,
              userRole,
              status,
              req.user?.id || null,
              maxBargainAmount,
              maxItemBargainAmount,
              existingUser.id,
              tenantId,
            ]
          : [
              hashedPassword,
              full_name,
              phone,
              userRole,
              status,
              req.user?.id || null,
              existingUser.id,
              tenantId,
            ];

        const result = await query(restoreQuery, restoreValues);

        newUser = result.rows[0];
      } else {
        return res.status(409).json({ error: 'Email already exists' });
      }
    } else {
      const result = await query(
        `INSERT INTO users (email, password, full_name, phone, role, status, created_by, tenant_id,
                           max_bargain_amount, max_item_bargain_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, email, full_name, phone, role, status, created_at`,
        [email, hashedPassword, full_name, phone, userRole, status, req.user?.id || null,
          tenantId, maxBargainAmount, maxItemBargainAmount]
      );

      newUser = result.rows[0];
    }

    // Send email notification to admins if user is pending
    if (status === UserStatus.PENDING) {
      userNotificationService.notifyAdminsOfPendingUser({
        id: newUser.id,
        email: newUser.email,
        full_name: newUser.full_name,
        phone,
        role: newUser.role,
        created_at: newUser.created_at,
      }).catch(err => {
        console.error('Failed to send pending user notification:', err);
        // Don't fail registration if email fails
      });
    }
    
    res.status(201).json({
      message: status === UserStatus.PENDING 
        ? 'Registration successful. Awaiting admin approval.' 
        : 'User created successfully',
      user: newUser,
    });
  } catch (error: any) {
    if (error?.code === '23505' || error?.message?.includes('duplicate key')) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

export const login = async (req: AuthRequest, res: Response) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const { password } = req.body;
    
    // Get client IP and user agent for security logging
    const clientIP = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const MAX_FAILED_ATTEMPTS = 5;
    const LOCKOUT_DURATION_MINUTES = 30;

    const result = await query(
      `SELECT id, email, password, full_name, phone, role, status, profile_picture, profile_picture_url,
              tenant_id,
              branch_id, operations_access_enabled, desktop_workspace_enabled, failed_login_attempts, account_locked_until, last_failed_login,
              must_change_password, COALESCE(temporary_password_login_attempts, 0) AS temporary_password_login_attempts,
              admin_pin_hash, admin_pin_enabled
       FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2`,
      [email, config.tenancy.deploymentTenantId]
    );
    
    if (result.rows.length === 0) {
      // Log failed login attempt - user not found
      await logFailedLogin(email, clientIP, userAgent, 'User not found');
      
      // Generic error message - don't reveal that email doesn't exist
      return res.status(401).json({ error: 'Incorrect login credentials' });
    }
    
    const user = result.rows[0];

    // Temporary passwords allow three login attempts, including mistyped
    // passwords. A user who reaches the limit must ask for a fresh code.
    if (user.must_change_password && Number(user.temporary_password_login_attempts) >= 3) {
      await logFailedLogin(email, clientIP, userAgent, 'Temporary password login limit reached');
      return res.status(403).json({
        error: 'This temporary password has expired. Please contact an administrator for a new one-time password.'
      });
    }

    // Check if account is currently locked out (per-account brute-force protection)
    if (user.account_locked_until && new Date(user.account_locked_until) > new Date()) {
      const lockedUntil = new Date(user.account_locked_until);
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      await logFailedLogin(email, clientIP, userAgent, `Account locked until ${lockedUntil.toISOString()}`);
      return res.status(429).json({
        error: `Account is temporarily locked due to too many failed login attempts. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.`,
        locked: true,
        locked_until: lockedUntil.toISOString(),
        remaining_minutes: remainingMinutes,
      });
    }
    
    // Check if user is active
    if (user.status !== UserStatus.ACTIVE) {
      // Log failed login attempt - inactive account
      await logFailedLogin(email, clientIP, userAgent, `Account not active: ${user.status}`);
      
      // Provide specific error messages based on status
      let errorMessage = 'Account is not active';
      if (user.status === UserStatus.PENDING) {
        errorMessage = 'Your account is awaiting approval. Please wait for an administrator to approve your access.';
      } else if (user.status === UserStatus.SUSPENDED) {
        errorMessage = 'Your account has been suspended. Please contact an administrator.';
      } else if (user.status === UserStatus.REJECTED) {
        errorMessage = 'Your account registration was rejected. Please contact an administrator.';
      }
      
      return res.status(403).json({ 
        error: errorMessage,
        status: user.status 
      });
    }
    
    // If password is missing, this account cannot use password login.
    if (!user.password) {
      await logFailedLogin(email, clientIP, userAgent, 'Account has no password set');
      return res.status(401).json({ 
        error: 'This account has no password set. Please contact the systems administrator.'
      });
    }

    // Reserve one of the three attempts before checking the password so
    // parallel requests cannot exceed the limit. Attempt three is permitted.
    if (user.must_change_password) {
      const attemptResult = await query(
        `UPDATE users
         SET temporary_password_login_attempts = COALESCE(temporary_password_login_attempts, 0) + 1
         WHERE id = $1 AND tenant_id = $2
           AND must_change_password = TRUE
           AND COALESCE(temporary_password_login_attempts, 0) < 3
         RETURNING temporary_password_login_attempts`,
        [user.id, user.tenant_id]
      );

      if (attemptResult.rows.length === 0) {
        await logFailedLogin(email, clientIP, userAgent, 'Temporary password login limit reached');
        return res.status(403).json({
          error: 'This temporary password has expired. Please contact an administrator for a new one-time password.'
        });
      }
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      // Increment failed attempt counter and potentially lock the account
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      let lockUntil: Date | null = null;
      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
      }

      await query(
        `UPDATE users
         SET failed_login_attempts = $1,
             last_failed_login = NOW(),
             account_locked_until = $2
         WHERE id = $3 AND tenant_id = $4`,
        [newAttempts, lockUntil, user.id, user.tenant_id]
      );

      // Log failed login attempt - wrong password
      await logFailedLogin(email, clientIP, userAgent, `Invalid password (attempt ${newAttempts})`);

      if (lockUntil) {
        await logAccountLocked(user.id, email, clientIP, newAttempts);
        const remainingMinutes = LOCKOUT_DURATION_MINUTES;
        return res.status(429).json({
          error: `Too many failed login attempts. Your account has been locked for ${remainingMinutes} minutes.`,
          locked: true,
          locked_until: lockUntil.toISOString(),
          remaining_minutes: remainingMinutes,
        });
      }

      const attemptsLeft = MAX_FAILED_ATTEMPTS - newAttempts;
      return res.status(401).json({
        error: `Incorrect login credentials. ${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining before account is locked.`,
        attempts_remaining: attemptsLeft,
      });
    }

    if (user.role === UserRole.ADMIN && user.admin_pin_enabled) {
      // Fail closed if an enabled PIN has no usable hash; never downgrade to password-only login.
      if (!user.admin_pin_hash) {
        return res.status(503).json({ error: 'Administrator PIN security needs attention. Contact the systems administrator.' });
      }
      const challengeToken = jwt.sign(
        { id: user.id, role: user.role, tenant_id: user.tenant_id, purpose: 'admin_pin_challenge' },
        config.jwt.secret,
        { expiresIn: '5m' }
      );
      await query(
        `UPDATE users SET failed_login_attempts = 0, account_locked_until = NULL, last_failed_login = NULL
         WHERE id = $1 AND tenant_id = $2`,
        [user.id, user.tenant_id]
      );
      return res.json({ requires_pin: true, challenge_token: challengeToken, expires_in: 300 });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        full_name: user.full_name, 
        role: user.role,
        tenant_id: user.tenant_id,
        profile_picture: user.profile_picture,
        is_system_admin: isSystemAdminEmail(user.email),
        branch_id: user.branch_id ?? null
      },
      config.jwt.secret,
      { expiresIn: '7d' }  // Fixed expiration time
    );
    
    // Update last_login timestamp, reset failed attempts, and get updated user data
    const updatedUserResult = await query(
      `UPDATE users
       SET last_login = NOW(),
           failed_login_attempts = 0,
           account_locked_until = NULL,
           last_failed_login = NULL
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, email, full_name, phone, role, status, profile_picture, profile_picture_url,
                 tenant_id, branch_id, created_at, updated_at, last_login, max_bargain_amount,
                 max_item_bargain_amount, must_change_password, temporary_password_login_attempts,
                 admin_pin_enabled, operations_access_enabled, desktop_workspace_enabled`,
      [user.id, user.tenant_id]
    );
    
    const updatedUser = updatedUserResult.rows[0];
    updatedUser.is_system_admin = isSystemAdminEmail(updatedUser.email);
    updatedUser.max_bargain_amount = getEffectiveBargainLimit(
      updatedUser.role,
      updatedUser.max_bargain_amount
    );
    updatedUser.max_item_bargain_amount = Number(updatedUser.max_item_bargain_amount) || 0;
    updatedUser.profile_picture_url = await createProfilePictureAccessUrl(
      updatedUser.profile_picture_url || updatedUser.profile_picture,
      updatedUser.tenant_id
    );
    
    // Auto-cancel any pending password reset requests (user successfully logged in, so they remember their password)
    try {
      const cancelResult = await query(
        `DELETE FROM password_reset_requests 
         WHERE user_id = $1 AND status = 'PENDING'
         RETURNING id`,
        [user.id]
      );
      
      if (cancelResult.rows.length > 0) {
        console.log(`Auto-cancelled ${cancelResult.rows.length} pending password reset request(s) for user ${email} - successful login`);
      }
    } catch (cancelError) {
      console.warn('Failed to auto-cancel password reset requests (non-critical):', cancelError);
    }
    
    // Log successful login
    await logSuccessfulLogin(user.id, email, user.full_name, user.role, clientIP, userAgent);
    
    res.json({
      token,
      user: updatedUser
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

export const verifyAdminPin = async (req: AuthRequest, res: Response) => {
  try {
    const pin = typeof req.body.pin === 'string' ? req.body.pin : '';
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'Enter all four PIN digits.' });
    }

    let challenge: { userId: number; tenantId: number };
    try {
      challenge = getAdminPinChallenge(req);
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : 'PIN sign-in session is invalid.' });
    }

    const found = await query(
      `SELECT id, email, full_name, role, status, password, tenant_id, branch_id,
              admin_pin_hash, admin_pin_enabled, admin_pin_failed_attempts, admin_pin_locked_until
       FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [challenge.userId, challenge.tenantId]
    );
    const user = found.rows[0];
    if (!user || user.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE || !user.admin_pin_enabled || !user.admin_pin_hash) {
      return res.status(401).json({ error: 'Administrator PIN sign-in is no longer available. Sign in again.' });
    }

    if (user.admin_pin_locked_until && new Date(user.admin_pin_locked_until) > new Date()) {
      const remainingMinutes = Math.ceil((new Date(user.admin_pin_locked_until).getTime() - Date.now()) / 60000);
      await logFailedLogin(user.email, req.ip || 'unknown', req.headers['user-agent'] || 'unknown', 'Administrator PIN attempt while locked');
      return res.status(429).json({ error: `PIN entry is temporarily locked. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.` });
    }

    const tenantId = Number(user.tenant_id);
    if (!isAdminPinHashMatch(pin, user.admin_pin_hash, Number(user.id), tenantId)) {
      const failures = await query(
        `UPDATE users
         SET admin_pin_failed_attempts = admin_pin_failed_attempts + 1,
             admin_pin_locked_until = CASE
               WHEN admin_pin_failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
               ELSE admin_pin_locked_until
             END
         WHERE id = $1 AND tenant_id = $2
         RETURNING admin_pin_failed_attempts, admin_pin_locked_until`,
        [user.id, tenantId]
      );
      const attempts = Number(failures.rows[0]?.admin_pin_failed_attempts || 0);
      const locked = Boolean(failures.rows[0]?.admin_pin_locked_until && new Date(failures.rows[0].admin_pin_locked_until) > new Date());
      await logFailedLogin(user.email, req.ip || 'unknown', req.headers['user-agent'] || 'unknown', `Incorrect administrator PIN (attempt ${attempts})`);
      return res.status(locked ? 429 : 401).json({
        error: locked ? 'Too many incorrect PIN attempts. Try again in 15 minutes.' : 'Incorrect PIN. Please try again.',
        attempts_remaining: Math.max(0, 5 - attempts),
      });
    }

    const updatedResult = await query(
      `UPDATE users
       SET admin_pin_failed_attempts = 0, admin_pin_locked_until = NULL,
           failed_login_attempts = 0, account_locked_until = NULL, last_failed_login = NULL,
           last_login = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, email, full_name, phone, role, status, profile_picture, profile_picture_url,
                 tenant_id, branch_id, created_at, updated_at, last_login, max_bargain_amount,
                 max_item_bargain_amount, must_change_password, admin_pin_enabled, operations_access_enabled, desktop_workspace_enabled`,
      [user.id, tenantId]
    );
    const signedInUser = updatedResult.rows[0];
    signedInUser.is_system_admin = isSystemAdminEmail(signedInUser.email);
    signedInUser.max_bargain_amount = getEffectiveBargainLimit(signedInUser.role, signedInUser.max_bargain_amount);
    signedInUser.max_item_bargain_amount = Number(signedInUser.max_item_bargain_amount) || 0;
    signedInUser.profile_picture_url = await createProfilePictureAccessUrl(
      signedInUser.profile_picture_url || signedInUser.profile_picture,
      tenantId
    );

    const token = jwt.sign(
      {
        id: signedInUser.id,
        email: signedInUser.email,
        full_name: signedInUser.full_name,
        role: signedInUser.role,
        tenant_id: tenantId,
        profile_picture: signedInUser.profile_picture,
        is_system_admin: signedInUser.is_system_admin,
        branch_id: signedInUser.branch_id ?? null,
      },
      config.jwt.secret,
      { expiresIn: '7d' }
    );
    const clientIP = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    await logSuccessfulLogin(signedInUser.id, signedInUser.email, signedInUser.full_name, signedInUser.role, clientIP, userAgent);
    return res.json({ token, user: signedInUser });
  } catch (error) {
    console.error('Administrator PIN verification error:', error);
    return res.status(500).json({ error: 'Unable to verify the PIN. Please try again.' });
  }
};

const createAdminPinResetRequest = async (userId: number, tenantId: number, notes?: string) => {
  const result = await query(
    `INSERT INTO admin_pin_reset_requests (tenant_id, user_id, requested_at, status, notes)
     VALUES ($1, $2, NOW(), 'PENDING', $3)
     ON CONFLICT (tenant_id, user_id) WHERE status = 'PENDING'
     DO UPDATE SET requested_at = NOW(), notes = EXCLUDED.notes
     RETURNING id`,
    [tenantId, userId, typeof notes === 'string' ? notes.trim().slice(0, 500) || null : null]
  );
  const requester = await query(
    `SELECT full_name, email FROM users WHERE id = $1 AND tenant_id = $2 AND role = $3 AND status = $4`,
    [userId, tenantId, UserRole.ADMIN, UserStatus.ACTIVE]
  );
  const systemAdminEmails = getSystemAdminEmails();
  if (requester.rows[0] && systemAdminEmails.length > 0) {
    const admins = await query(
      `SELECT id FROM users
       WHERE tenant_id = $1 AND role = $2 AND status = $3 AND LOWER(email) = ANY($4::text[])`,
      [tenantId, UserRole.ADMIN, UserStatus.ACTIVE, systemAdminEmails]
    );
    const adminIds = admins.rows.map((row: any) => Number(row.id));
    if (adminIds.length > 0) {
      await createNotification({
        type: 'SYSTEM_ALERT',
        title: 'Administrator PIN removal requested',
        message: `${requester.rows[0].full_name || requester.rows[0].email} requested removal of their sign-in PIN.`,
        user_ids: adminIds,
        link: '/password-reset-requests?tab=admin-pin',
      });
    }
  }
  return result.rows[0]?.id;
};

export const requestAdminPinReset = async (req: AuthRequest, res: Response) => {
  try {
    let userId: number;
    let tenantId: number;
    if (req.user) {
      userId = req.user.id;
      tenantId = config.tenancy.deploymentTenantId;
    } else {
      try {
        ({ userId, tenantId } = getAdminPinChallenge(req));
      } catch (error) {
        return res.status(401).json({ error: error instanceof Error ? error.message : 'PIN sign-in session is invalid.' });
      }
    }

    const found = await query(
      `SELECT role, status, admin_pin_enabled FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    );
    const user = found.rows[0];
    if (!user || user.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE || !user.admin_pin_enabled) {
      return res.status(400).json({ error: 'This account does not have an active PIN to remove.' });
    }

    await createAdminPinResetRequest(userId, tenantId, req.body?.notes);
    return res.json({
      message: 'Your request has been sent to the systems administrator. You can sign in with your password after they approve PIN removal.',
    });
  } catch (error) {
    console.error('Administrator PIN reset request error:', error);
    return res.status(500).json({ error: 'Unable to send the PIN removal request.' });
  }
};

export const updateAdminPinSettings = async (req: AuthRequest, res: Response) => {
  try {
    const { enabled, pin, currentPassword } = req.body || {};
    if (typeof enabled !== 'boolean' || typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Enter your current password and choose a PIN setting.' });
    }
    const found = await query(
      `SELECT id, password, role, admin_pin_enabled FROM users WHERE id = $1 AND tenant_id = $2`,
      [req.user!.id, config.tenancy.deploymentTenantId]
    );
    const user = found.rows[0];
    if (!user || user.role !== UserRole.ADMIN) return res.status(403).json({ error: 'Only administrators can use sign-in PINs.' });
    if (!user.password || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const isSystemAdmin = isSystemAdminEmail(req.user!.email);
    if (!enabled && user.admin_pin_enabled && !isSystemAdmin) {
      return res.status(403).json({ error: 'PIN removal requires approval from the systems administrator.' });
    }
    if (enabled && !/^\d{4}$/.test(typeof pin === 'string' ? pin : '')) {
      return res.status(400).json({ error: 'PIN must contain exactly four digits.' });
    }

    await query(
      `UPDATE users
       SET admin_pin_enabled = $1,
           admin_pin_hash = CASE WHEN $1 THEN $2 ELSE NULL END,
           admin_pin_failed_attempts = 0,
           admin_pin_locked_until = NULL,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [enabled, enabled ? createAdminPinHash(pin, Number(user.id), config.tenancy.deploymentTenantId) : null, user.id, config.tenancy.deploymentTenantId]
    );
    return res.json({
      message: enabled ? 'Administrator sign-in PIN saved.' : 'Administrator sign-in PIN disabled.',
      admin_pin_enabled: enabled,
    });
  } catch (error) {
    console.error('Administrator PIN settings error:', error);
    return res.status(500).json({ error: 'Unable to update the administrator PIN setting.' });
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status, u.profile_picture,
              u.profile_picture_url, u.created_at, u.updated_at, u.last_login, u.auth_provider,
              u.operations_access_enabled, u.desktop_workspace_enabled,
              u.max_bargain_amount, u.max_item_bargain_amount, u.tenant_id, u.branch_id,
              u.must_change_password, u.admin_pin_enabled, b.name AS branch_name
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [req.user!.id, config.tenancy.deploymentTenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    user.is_system_admin = isSystemAdminEmail(user.email);
    user.max_bargain_amount = getEffectiveBargainLimit(user.role, user.max_bargain_amount);
    user.max_item_bargain_amount = Number(user.max_item_bargain_amount) || 0;
    user.profile_picture_url = await createProfilePictureAccessUrl(
      user.profile_picture_url || user.profile_picture,
      user.tenant_id
    );
    user.max_discount_percent = 100;
    user.max_item_discount_percent = 100;
    user.item_discount_mode = 'both';
    user.order_discount_mode = 'both';
    user.full_item_bargain_allowed = true;
    user.full_order_bargain_allowed = true;
    const discountSetting = await query(
      `SELECT setting_value FROM business_settings WHERE setting_key = 'discount_limits' AND tenant_id = app_current_tenant_id()`
    );
    if (discountSetting.rows[0]?.setting_value) {
      try {
        const configured = JSON.parse(discountSetting.rows[0].setting_value);
        const key = user.role === 'DESKTOP_AGENT' ? 'desktop_agent' : user.role === 'MANAGER' ? 'manager' : 'admin';
        const configuredOrderAmount = Number(configured[key + '_limit']);
        const configuredItemAmount = Number(configured[key + '_item_limit']);
        if (configured[key + '_full_order_amount'] === false && Number.isFinite(configuredOrderAmount) && configuredOrderAmount >= 0) {
          user.max_bargain_amount = configuredOrderAmount;
        }
        if (configured[key + '_full_item_amount'] === false && Number.isFinite(configuredItemAmount) && configuredItemAmount >= 0) {
          user.max_item_bargain_amount = configuredItemAmount;
        }
        const value = Number(configured[key]);
        if (Number.isFinite(value) && value >= 0 && value <= 100) user.max_discount_percent = value;
        if (configured.item_discount_mode !== 'amount') {
          const itemValue = Number(configured[key + '_item']);
          if (Number.isFinite(itemValue) && itemValue >= 0 && itemValue <= 100) user.max_item_discount_percent = itemValue;
        }
        user.item_discount_mode = ['percent', 'amount', 'both'].includes(configured.item_discount_mode) ? configured.item_discount_mode : 'both';
        user.order_discount_mode = ['percent', 'amount', 'both'].includes(configured.order_discount_mode) ? configured.order_discount_mode : 'both';
        user.full_item_bargain_allowed = configured[key + '_full_item_amount'] !== false;
        user.full_order_bargain_allowed = configured[key + '_full_order_amount'] !== false;
      } catch {
        // Retain the role default when the setting is malformed.
      }
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

export const forgotPassword = async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.body;
    
    // Check if user exists
    const result = await query(
      'SELECT id, email, full_name, role FROM users WHERE email = $1 AND tenant_id = app_current_tenant_id()',
      [email]
    );
    
    if (result.rows.length === 0) {
      // Don't reveal if email exists or not for security
      return res.json({ 
        message: 'If the email exists, a password reset request has been sent to administrators.' 
      });
    }
    
    const user = result.rows[0];
    
    // Create a password reset request (stored in database for admin review)
    // If user already has a request (COMPLETED or DENIED), reset it to PENDING
    await query(
      `INSERT INTO password_reset_requests (user_id, requested_at, status)
       VALUES ($1, NOW(), 'PENDING')
       ON CONFLICT (user_id) 
       DO UPDATE SET requested_at = NOW(), status = 'PENDING', resolved_at = NULL, resolved_by = NULL`,
      [user.id]
    );
    
    // Alert administrators in-app; without this the request sits unseen until
    // someone happens to open the Password Reset Requests page.
    await createNotification({
      type: 'SYSTEM_ALERT',
      title: 'Password reset requested',
      message: `${user.full_name || user.email} has requested a password reset.`,
      notify_admins_only: true,
      link: '/password-reset-requests',
    });
    
    res.json({ 
      message: 'If the email exists, a password reset request has been sent to administrators.' 
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
};

export const updateSessionTimeout = async (req: AuthRequest, res: Response) => {
  try {
    const { minutes } = req.body;
    const userId = req.user!.id;
    
    // Session timeout feature removed - feature no longer supported
    return res.status(410).json({ error: 'Session timeout customization has been removed' });
  } catch (error) {
    console.error('Update session timeout error:', error);
    res.status(500).json({ error: 'Failed to update session timeout' });
  }
};

export const changePassword = async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;
    
    // Validate input
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }
    
    // Get user's current password
    const result = await query(
      `SELECT password, must_change_password
       FROM users
       WHERE id = $1 AND tenant_id = $2`,
      [userId, req.user!.tenant_id || config.tenancy.deploymentTenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    // A valid authenticated session created with a temporary password is
    // sufficient proof for the forced first-login password replacement.
    // Ordinary password changes still require the current password.
    if (!user.must_change_password) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }

      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    
    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password and clear must_change_password flag
    const passwordUpdateResult = await query(
      `UPDATE users
       SET password = $1,
           must_change_password = FALSE,
           temporary_password_login_attempts = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
       RETURNING id`,
      [hashedNewPassword, userId, req.user!.tenant_id || config.tenancy.deploymentTenantId]
    );

    if (passwordUpdateResult.rows.length !== 1) {
      console.error(`Password change did not update a user row for user ${userId}`);
      return res.status(409).json({ error: 'Password was not saved. Please sign in again and retry.' });
    }
    
    console.log(`✅ Password changed successfully for user ${userId}`);
    
    // Log password change event
    try {
      await query(
        `INSERT INTO activity_logs (user_id, action, details)
         VALUES ($1, $2, $3)`,
        [userId, 'password_changed', JSON.stringify({ changed_at: new Date() })]
      );
    } catch (logError) {
      // Do not report a password-save failure if the credential was already
      // changed but the optional audit table has an incompatible schema.
      console.warn('Password changed, but activity logging failed:', logError);
    }
    
    res.json({
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
};

export const updateProfile = async (req: AuthRequest, res: Response) => {
  try {
    const { full_name, phone } = req.body;
    const userId = req.user!.id;
    
    // Validate input
    if (!full_name || !phone) {
      return res.status(400).json({ error: 'Full name and phone are required' });
    }
    
    // Validate phone number format (must include country code)
    if (!/^\+\d{10,15}$/.test(phone)) {
      return res.status(400).json({ 
        error: 'Phone number must include country code and be 10-15 digits (e.g., +256700000000 for Uganda)' 
      });
    }
    
    // Update user profile
    const result = await query(
      `UPDATE users 
       SET full_name = $1, phone = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3
       RETURNING id, email, full_name, phone, role, status, profile_picture, profile_picture_url, created_at, updated_at, last_login, auth_provider`,
      [full_name, phone, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log(`✅ Profile updated for user ${userId}`);
    
    const updatedUser = result.rows[0];
    updatedUser.is_system_admin = isSystemAdminEmail(updatedUser.email);
    updatedUser.profile_picture_url = await createProfilePictureAccessUrl(
      updatedUser.profile_picture_url || updatedUser.profile_picture,
      config.tenancy.deploymentTenantId
    );

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

export const uploadProfilePicture = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const uploadResult = await uploadProfileImageToSupabase(file, userId, config.tenancy.deploymentTenantId);

    // Persist the tenant-scoped object path; signed URLs are generated only for authorized responses.
    const result = await query(
      `UPDATE users 
       SET profile_picture = $1,
           profile_picture_url = $2,
           profile_picture_storage = 'SUPABASE',
           profile_picture_migrated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 AND tenant_id = $4
       RETURNING profile_picture, profile_picture_url`,
      [uploadResult.objectPath, uploadResult.objectPath, userId, config.tenancy.deploymentTenantId]
    );
    console.log("Profile picture updated for user " + userId + " in tenant " + config.tenancy.deploymentTenantId);
    res.json({
      message: 'Profile picture uploaded successfully',
      profile_picture: result.rows[0].profile_picture,
      profile_picture_url: uploadResult.signedUrl
    });
  } catch (error) {
    console.error('Upload profile picture error:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
};
