import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

const staffRoles = ['ADMIN', 'MANAGER', 'OPERATIONS', 'DESKTOP_AGENT'];
function hasOperationsAccess(req: AuthRequest) {
  return ['ADMIN', 'MANAGER', 'OPERATIONS'].includes(req.user!.role) ||
    (req.user!.role === 'DESKTOP_AGENT' && !!req.user!.operations_access_enabled);
}
function contactRoles(role: string, operationsWorkspace = false) {
  if (operationsWorkspace) return staffRoles;
  if (role === 'DESKTOP_AGENT') return ['ADMIN', 'MANAGER', 'OPERATIONS'];
  if (role === 'OPERATIONS') return staffRoles;
  if (role === 'ADMIN' || role === 'MANAGER') return staffRoles;
  return [];
}
async function getPeer(req: AuthRequest, peerId: number, operationsWorkspace = false) {
  if (!Number.isSafeInteger(peerId) || peerId < 1 || peerId === req.user!.id) return null;
  const roles = contactRoles(req.user!.role, operationsWorkspace && hasOperationsAccess(req));
  if (!roles.length) return null;
  const result = await query(
    "SELECT u.id,u.full_name,u.role::text AS role,u.branch_id,CASE WHEN u.role::text='ADMIN' THEN NULL ELSE b.name END AS branch_name " +
    "FROM public.users u LEFT JOIN public.branches b ON b.id=u.branch_id " +
    "WHERE u.id=$1 AND u.tenant_id=app_current_tenant_id() AND u.status='ACTIVE' AND u.role::text=ANY($2::text[])",
    [peerId, roles]
  );
  return result.rows[0] || null;
}

export const getMessagingContacts = async (req: AuthRequest, res: Response) => {
  try {
    const operationsWorkspace = req.query.workspace === 'operations';
    if (operationsWorkspace && !hasOperationsAccess(req)) return res.status(403).json({ error: 'Operations access is not enabled' });
    const roles = contactRoles(req.user!.role, operationsWorkspace);
    if (!roles.length) return res.status(403).json({ error: 'Staff messaging is not available for this account' });
    const result = await query(
      "SELECT u.id,u.full_name,u.role::text AS role,u.branch_id,CASE WHEN u.role::text='ADMIN' THEN NULL ELSE b.name END AS branch_name," +
      "(SELECT COUNT(1)::int FROM public.operations_messages unread WHERE unread.tenant_id=u.tenant_id AND unread.sender_id=u.id AND unread.recipient_id=$1 AND unread.read_at IS NULL) AS unread_count," +
      "last.message AS last_message,last.created_at AS last_message_at " +
      "FROM public.users u LEFT JOIN public.branches b ON b.id=u.branch_id " +
      "LEFT JOIN LATERAL (SELECT m.message,m.created_at FROM public.operations_messages m " +
      "WHERE m.tenant_id=u.tenant_id AND ((m.sender_id=u.id AND m.recipient_id=$1) OR (m.sender_id=$1 AND m.recipient_id=u.id)) " +
      "ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last ON TRUE " +
      "WHERE u.tenant_id=app_current_tenant_id() AND u.status='ACTIVE' AND u.id<>$1 AND u.role::text=ANY($2::text[]) " +
      "ORDER BY (last.created_at IS NULL),last.created_at DESC,u.full_name",
      [req.user!.id, roles]
    );
    res.json({ contacts: result.rows });
  } catch (error) {
    console.error('Staff message contacts error:', error);
    res.status(500).json({ error: 'Unable to load staff contacts' });
  }
};

export const getStaffConversation = async (req: AuthRequest, res: Response) => {
  try {
    const peerId = Number(req.params.peerId);
    const peer = await getPeer(req, peerId, req.query.workspace === 'operations' && hasOperationsAccess(req));
    if (!peer) return res.status(404).json({ error: 'Staff member not found or not available for messaging' });

    const unread = await query(
      "UPDATE public.operations_messages SET read_at=NOW() " +
      "WHERE tenant_id=app_current_tenant_id() AND sender_id=$1 AND recipient_id=$2 AND read_at IS NULL RETURNING id",
      [peerId, req.user!.id]
    );
    if (unread.rows.length) {
      const messageIds = unread.rows.map((row: any) => String(row.id));
      await query(
        "UPDATE public.notifications SET is_read=TRUE,read_at=COALESCE(read_at,NOW()) " +
        "WHERE user_id=$1 AND data->>'operations_message_id'=ANY($2::text[]) AND is_read=FALSE",
        [req.user!.id, messageIds]
      );
    }
    const beforeId = req.query.before ? Number(req.query.before) : null;
    const params: any[] = [req.user!.id, peerId];
    let beforeClause = '';
    if (beforeId && Number.isSafeInteger(beforeId) && beforeId > 0) {
      params.push(beforeId);
      beforeClause = ' AND m.id < $3';
    }
    params.push(101);
    const result = await query(
      "SELECT m.id,m.sender_id,m.recipient_id,m.message,m.branch_id,m.order_id,m.sender_context,m.created_at,m.read_at,m.edited_at,m.unsent_at," +
      "sender.full_name AS sender_name,sender.role::text AS sender_role,CASE WHEN sender.role::text='ADMIN' THEN NULL ELSE b.name END AS sender_branch_name " +
      "FROM public.operations_messages m " +
      "JOIN public.users sender ON sender.id=m.sender_id AND sender.tenant_id=m.tenant_id " +
      "LEFT JOIN public.branches b ON b.id=sender.branch_id AND b.tenant_id=m.tenant_id " +
      "WHERE m.tenant_id=app_current_tenant_id() AND m.recipient_id IS NOT NULL AND " +
      "((m.sender_id=$1 AND m.recipient_id=$2) OR (m.sender_id=$2 AND m.recipient_id=$1))" + beforeClause +
      " ORDER BY m.id DESC LIMIT $" + params.length,
      params
    );
    const hasOlder = result.rows.length > 100;
    const messages = result.rows.slice(0, 100).reverse();
    res.json({ peer, messages, has_older: hasOlder });
  } catch (error) {
    console.error('Staff conversation error:', error);
    res.status(500).json({ error: 'Unable to load conversation' });
  }
};

export const sendStaffMessage = async (req: AuthRequest, res: Response) => {
  const recipientId = Number(req.body.recipient_id);
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 2000) return res.status(400).json({ error: 'Enter a message of up to 2,000 characters' });
  try {
    const senderRole = req.user!.role;
    const senderContext = req.body.sender_context === 'OPERATIONS' ? 'OPERATIONS' : 'STAFF';
    if (senderContext === 'OPERATIONS' && !hasOperationsAccess(req)) return res.status(403).json({ error: 'Operations access is not enabled' });
    const recipient = await getPeer(req, recipientId, senderContext === 'OPERATIONS');
    if (!recipient) return res.status(403).json({ error: 'This staff member is not available for messaging' });
    const branchId = senderRole === 'DESKTOP_AGENT' ? req.user!.branch_id : recipient.branch_id;
    const saved = await query(
      "INSERT INTO public.operations_messages(tenant_id,branch_id,sender_id,recipient_id,message,sender_context) " +
      "VALUES(app_current_tenant_id(),$1,$2,$3,$4,$5) RETURNING id,created_at",
      [branchId || null, req.user!.id, recipientId, message, senderContext]
    );
    const title = senderContext === 'OPERATIONS' || senderRole === 'OPERATIONS' ? 'Message from Operations' : 'New message from ' + req.user!.full_name;
    const notificationData = {
      operations_message_id: saved.rows[0].id,
      sender_user_id: req.user!.id,
      sender_role: senderRole,
      sender_context: senderContext,
      sender_name: req.user!.full_name,
    };
    await query(
      "INSERT INTO public.notifications(user_id,type,title,message,data) VALUES($1,'SYSTEM_ALERT',$2,$3,$4::jsonb)",
      [recipientId, title, message, JSON.stringify(notificationData)]
    );
    res.status(201).json({
      message: {
        id: saved.rows[0].id,
        sender_id: req.user!.id,
        recipient_id: recipientId,
        sender_name: req.user!.full_name,
        sender_role: senderRole,
        sender_context: senderContext,
        message,
        branch_id: branchId,
        created_at: saved.rows[0].created_at,
        read_at: null,
      },
    });
  } catch (error) {
    console.error('Send staff message error:', error);
    res.status(500).json({ error: 'Unable to send staff message' });
  }
};


export const editStaffMessage = async (req: AuthRequest, res: Response) => {
  const messageId = Number(req.params.messageId);
  const message = String(req.body.message || '').trim();
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !message || message.length > 2000) {
    return res.status(400).json({ error: 'Enter a message of up to 2,000 characters' });
  }
  try {
    const updated = await query(
      `UPDATE operations_messages SET message=$1,edited_at=NOW()
       WHERE tenant_id=app_current_tenant_id() AND id=$2 AND sender_id=$3 AND recipient_id IS NOT NULL
         AND unsent_at IS NULL AND created_at >= NOW() - INTERVAL '5 minutes'
       RETURNING id,message,edited_at`,
      [message, messageId, req.user!.id]
    );
    if (!updated.rows.length) return res.status(409).json({ error: 'Messages can only be edited by their sender within 5 minutes' });
    await query(
      `UPDATE notifications SET message=$1 WHERE user_id=(SELECT recipient_id FROM operations_messages WHERE id=$2 AND tenant_id=app_current_tenant_id()) AND data->>'operations_message_id'=$2::text`,
      [message, messageId]
    );
    res.json({ message: updated.rows[0] });
  } catch (error) {
    console.error('Edit staff message error:', error);
    res.status(500).json({ error: 'Unable to edit message' });
  }
};

export const unsendStaffMessage = async (req: AuthRequest, res: Response) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ error: 'Invalid message' });
  try {
    const updated = await query(
      `UPDATE operations_messages SET message='This message was unsent.',unsent_at=NOW()
       WHERE tenant_id=app_current_tenant_id() AND id=$1 AND sender_id=$2 AND recipient_id IS NOT NULL
         AND unsent_at IS NULL AND created_at >= NOW() - INTERVAL '5 minutes'
       RETURNING id,message,unsent_at`,
      [messageId, req.user!.id]
    );
    if (!updated.rows.length) return res.status(409).json({ error: 'Messages can only be unsent by their sender within 5 minutes' });
    await query(
      `UPDATE notifications SET title='Message withdrawn',message='A staff message was unsent.'
       WHERE user_id=(SELECT recipient_id FROM operations_messages WHERE id=$1 AND tenant_id=app_current_tenant_id()) AND data->>'operations_message_id'=$1::text`,
      [messageId]
    );
    res.json({ message: updated.rows[0] });
  } catch (error) {
    console.error('Unsend staff message error:', error);
    res.status(500).json({ error: 'Unable to unsend message' });
  }
};

export const getStaffMessageUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT COUNT(1)::int AS count FROM public.operations_messages WHERE tenant_id=app_current_tenant_id() AND recipient_id=$1 AND read_at IS NULL',
      [req.user!.id]
    );
    res.json({ count: Number(result.rows[0]?.count || 0) });
  } catch (error) {
    console.error('Staff message unread count error:', error);
    res.status(500).json({ error: 'Unable to load unread message count' });
  }
};
