import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { config } from '../config';
import { createNotification } from '../services/notification.service';

export const listAdminPinResetRequests = async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT r.id, r.user_id, r.requested_at, r.status, r.notes,
              u.full_name, u.email, u.role
       FROM admin_pin_reset_requests r
       JOIN users u ON u.id = r.user_id AND u.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1 AND r.status = 'PENDING' AND u.role = 'ADMIN'
       ORDER BY r.requested_at ASC`,
      [config.tenancy.deploymentTenantId]
    );
    return res.json({ requests: result.rows });
  } catch (error) {
    console.error('List administrator PIN reset requests error:', error);
    return res.status(500).json({ error: 'Unable to load administrator PIN requests.' });
  }
};

export const resolveAdminPinResetRequest = async (req: AuthRequest, res: Response) => {
  try {
    const requestId = Number(req.params.requestId);
    const decision = String(req.body?.decision || '').toUpperCase();
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || !['APPROVE', 'DENY'].includes(decision)) {
      return res.status(400).json({ error: 'Choose whether to approve or deny this PIN removal request.' });
    }

    const result = await query(
      `WITH pending AS MATERIALIZED (
         SELECT r.id, r.user_id
         FROM admin_pin_reset_requests r
         JOIN users u ON u.id = r.user_id AND u.tenant_id = r.tenant_id
         WHERE r.id = $1 AND r.tenant_id = $2 AND r.status = 'PENDING' AND u.role = 'ADMIN'
         FOR UPDATE OF r
       ), disabled AS (
         UPDATE users u
         SET admin_pin_enabled = FALSE,
             admin_pin_hash = NULL,
             admin_pin_failed_attempts = 0,
             admin_pin_locked_until = NULL,
             updated_at = NOW()
         FROM pending p
         WHERE u.id = p.user_id AND $3 = 'APPROVE'
         RETURNING u.id
       ), resolved AS (
         UPDATE admin_pin_reset_requests r
         SET status = CASE WHEN $3 = 'APPROVE' THEN 'COMPLETED' ELSE 'DENIED' END,
             resolved_at = NOW(), resolved_by = $4
         FROM pending p
         WHERE r.id = p.id
           AND ($3 = 'DENY' OR EXISTS (SELECT 1 FROM disabled d WHERE d.id = p.user_id))
         RETURNING r.id, r.user_id, r.status
       )
       SELECT * FROM resolved`,
      [requestId, config.tenancy.deploymentTenantId, decision, req.user!.id]
    );
    const request = result.rows[0];
    if (!request) return res.status(404).json({ error: 'Pending PIN removal request not found.' });

    await createNotification({
      type: 'SYSTEM_ALERT',
      title: request.status === 'COMPLETED' ? 'Administrator PIN disabled' : 'PIN removal request denied',
      message: request.status === 'COMPLETED'
        ? 'The systems administrator approved your PIN removal. Sign in with your password and set a new PIN in Profile if you want to use one again.'
        : 'The systems administrator denied your PIN removal request. Your sign-in PIN remains active.',
      user_ids: [Number(request.user_id)],
      link: '/profile',
      sender_id: req.user!.id,
    });

    return res.json({
      success: true,
      status: request.status,
      message: request.status === 'COMPLETED'
        ? 'PIN disabled. The administrator can now sign in with their password and optionally set a new PIN.'
        : 'PIN removal request denied. The administrator’s PIN remains active.',
    });
  } catch (error) {
    console.error('Resolve administrator PIN reset request error:', error);
    return res.status(500).json({ error: 'Unable to resolve the administrator PIN request.' });
  }
};
