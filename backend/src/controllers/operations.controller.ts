import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { beginTenantTransaction, getClient, query } from '../config/database';
import { kampalaTodayYmd } from '../utils/businessDate';

const statuses = ['RECEIVED', 'PROCESSING', 'READY'];
const pageOptions = (req: AuthRequest) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
};
const branchIdFor = (req: AuthRequest): number | null => {
  const role = req.user?.role;
  const global = ['ADMIN', 'MANAGER', 'OPERATIONS'].includes(String(role)) ||
    (role === 'DESKTOP_AGENT' && !!req.user?.operations_access_enabled);
  if (!global) return Number(req.user?.branch_id) || -1;
  const requested = String(req.query.branch_id || '');
  return requested && requested !== 'all' ? Number(requested) || -1 : null;
};
function dateSql(req: AuthRequest, column: string, values: unknown[]) {
  const period = String(req.query.period || 'all');
  if (period === 'today') {
    values.push(kampalaTodayYmd());
    return ` AND ${column}::date=$${values.length}::date`;
  }
  if (period === 'month') {
    values.push(kampalaTodayYmd().slice(0, 7) + '-01');
    return ` AND ${column}>=$${values.length}::date`;
  }
  if (period === 'custom') {
    let sql = '';
    if (req.query.from) { values.push(String(req.query.from)); sql += ` AND ${column}::date >= $${values.length}::date`; }
    if (req.query.to) { values.push(String(req.query.to)); sql += ` AND ${column}::date <= $${values.length}::date`; }
    return sql;
  }
  return '';
}
async function listOrders(req: AuthRequest, delivered = false) {
  const { page, limit, offset } = pageOptions(req);
  const values: unknown[] = [];
  let where = delivered ? "upper(o.status::text)='DELIVERED'" : "upper(o.status::text) NOT IN ('DELIVERED','CANCELLED')";
  // Historical queue orders belong by business date; delivered history keeps its existing recorded-date behavior.
  const orderDateExpression = delivered
    ? 'COALESCE(o.recorded_at,o.created_at)'
    : 'COALESCE(o.created_at,o.recorded_at)';
  where += dateSql(req, orderDateExpression, values);
  const branchId = branchIdFor(req);
  if (branchId !== null) { values.push(branchId); where += ` AND o.branch_id=$${values.length}`; }
  const search = String(req.query.search || '').trim();
  if (search) { values.push(`%${search}%`); where += ` AND (o.order_number ILIKE $${values.length} OR c.name ILIKE $${values.length} OR b.name ILIKE $${values.length})`; }
  const status = String(req.query.status || '');
  if (status && status !== 'ALL' && status !== 'EXPRESS' && !delivered) {
    if (status === 'RECEIVED') {
      where += " AND upper(COALESCE(o.status::text,'PENDING')) IN ('PENDING','RECEIVED')";
    } else if (['PROCESSING', 'READY'].includes(status)) {
      values.push(status);
      where += ` AND upper(o.status::text)=$${values.length}`;
    }
  }
  if (status === 'EXPRESS') where += " AND EXISTS(SELECT 1 FROM public.order_items ex WHERE ex.order_id=o.id AND ex.tenant_id=o.tenant_id AND upper(COALESCE(ex.service_type,''))='EXPRESS')";
  const count = await query(
    `SELECT count(*)::int total FROM public.orders o
     JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id LEFT JOIN public.branches b ON b.id=o.branch_id WHERE ${where}`, values
  );
  const total = Number(count.rows[0]?.total || 0);
  const result = await query(
    `SELECT o.id,o.order_number,o.status order_status,o.notes order_note,
      COALESCE(bool_or(upper(COALESCE(oi.service_type,''))='EXPRESS'),FALSE) is_express,o.branch_id,b.name branch_name,
      ${orderDateExpression} received_at,o.due_date,
      c.name customer_name,c.customer_id customer_number,u.full_name recorded_by,
      COALESCE(json_agg(json_build_object('id',oi.id,'name',pi.name,'quantity',oi.quantity,'note',oi.notes,'operations_note',os.operations_note,'service_type',oi.service_type,'express_due_at',oi.express_due_at,
        'status',CASE WHEN upper(o.status::text) IN ('READY','DELIVERED') THEN 'READY' WHEN upper(o.status::text)='PROCESSING' AND COALESCE(os.status,'RECEIVED')='RECEIVED' THEN 'PROCESSING' ELSE COALESCE(os.status,'RECEIVED') END,
        'ready_at',os.ready_at) ORDER BY oi.id) FILTER(WHERE oi.id IS NOT NULL),'[]'::json) items
     FROM public.orders o
     JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
     LEFT JOIN public.branches b ON b.id=o.branch_id
     LEFT JOIN public.users u ON u.id=o.user_id AND u.tenant_id=o.tenant_id
     LEFT JOIN public.order_items oi ON oi.order_id=o.id AND oi.tenant_id=o.tenant_id
     LEFT JOIN public.price_items pi ON pi.id=oi.price_item_id AND pi.tenant_id=oi.tenant_id
     LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
     WHERE ${where} GROUP BY o.id,c.id,b.id,u.id
     ORDER BY ${orderDateExpression} DESC,o.id DESC
     LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values, limit, offset]
  );
  return { orders: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}
export const getOperationsQueue = async (req: AuthRequest, res: Response) => {
  try { res.json(await listOrders(req)); }
  catch (error) { console.error('Operations queue error:', error); res.status(500).json({ error: 'Unable to load Operations queue' }); }
};
export const getOperationsSummary = async (req: AuthRequest, res: Response) => {
  try {
    const branch = branchIdFor(req);
    const values: unknown[] = [];
    let branchClause = '';
    if (branch !== null) { values.push(branch); branchClause = ' AND o.branch_id=$1'; }
    const totals = await query(
      "SELECT COUNT(DISTINCT o.id)::int active_orders," +
      "COUNT(DISTINCT o.id) FILTER(WHERE upper(COALESCE(o.status::text,'PENDING')) IN ('PENDING','RECEIVED'))::int received," +
      "COUNT(DISTINCT o.id) FILTER(WHERE upper(o.status::text)='PROCESSING')::int processing," +
      "COUNT(DISTINCT o.id) FILTER(WHERE upper(o.status::text)='READY')::int ready " +
      "FROM public.orders o LEFT JOIN public.order_items oi ON oi.order_id=o.id AND oi.tenant_id=o.tenant_id " +
      "LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id " +
      "WHERE upper(o.status::text) NOT IN ('DELIVERED','CANCELLED')" + branchClause,
      values
    );
    const result = await listOrders(req);
    const startedOrders = await query(
      `SELECT o.id,o.order_number,o.status order_status,
        COALESCE(bool_or(upper(COALESCE(oi.service_type,''))='EXPRESS'),FALSE) is_express,
        o.branch_id,b.name branch_name,COALESCE(o.created_at,o.recorded_at) received_at,
        c.name customer_name,
        COALESCE(json_agg(json_build_object(
          'id',oi.id,'name',pi.name,'quantity',oi.quantity,'note',oi.notes,'operations_note',os.operations_note,
          'service_type',oi.service_type,'express_due_at',oi.express_due_at,
          'status',CASE WHEN upper(o.status::text) IN ('READY','DELIVERED') THEN 'READY'
            WHEN upper(o.status::text)='PROCESSING' AND COALESCE(os.status,'RECEIVED')='RECEIVED' THEN 'PROCESSING'
            ELSE COALESCE(os.status,'RECEIVED') END,
          'ready_at',os.ready_at
        ) ORDER BY oi.id) FILTER(WHERE oi.id IS NOT NULL),'[]'::json) items,
        MAX(os.updated_at) last_worked_at
       FROM public.orders o
       JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
       LEFT JOIN public.branches b ON b.id=o.branch_id
       LEFT JOIN public.order_items oi ON oi.order_id=o.id AND oi.tenant_id=o.tenant_id
       LEFT JOIN public.price_items pi ON pi.id=oi.price_item_id AND pi.tenant_id=oi.tenant_id
       LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
       WHERE upper(o.status::text) NOT IN ('DELIVERED','CANCELLED')${branchClause}
       GROUP BY o.id,c.id,b.id
       HAVING BOOL_OR(os.status='READY' AND os.updated_by IS NOT NULL)
       ORDER BY MAX(os.updated_at) DESC NULLS LAST,o.id DESC
       LIMIT 12`,
      values
    );
    const row = totals.rows[0] || {};
    res.json({
      order_counts: { received: Number(row.received || 0), processing: Number(row.processing || 0), ready: Number(row.ready || 0) },
      total_active_orders: Number(row.active_orders || 0),
      express_orders: result.orders.filter((o: any) => o.is_express).slice(0, 8),
      in_progress_orders: startedOrders.rows,
    });
  } catch (error) { console.error('Operations summary error:', error); res.status(500).json({ error: 'Unable to load Operations summary' }); }
};export const getOperationsDelivered = async (req: AuthRequest, res: Response) => {
  try { res.json(await listOrders(req, true)); }
  catch (error) { console.error('Operations delivered error:', error); res.status(500).json({ error: 'Unable to load delivered orders' }); }
};
export const getOperationsReadyItems = async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit, offset } = pageOptions(req);
    const values: unknown[] = [];
    let where = "os.status='READY' AND upper(o.status::text) NOT IN ('DELIVERED','CANCELLED')";
    where += dateSql(req, 'os.ready_at', values);
    const branch = branchIdFor(req);
    if (branch !== null) { values.push(branch); where += ` AND o.branch_id=$${values.length}`; }
    const search = String(req.query.search || '').trim();
    if (search) { values.push(`%${search}%`); where += ` AND (o.order_number ILIKE $${values.length} OR c.name ILIKE $${values.length} OR pi.name ILIKE $${values.length})`; }
    const count = await query(
      `SELECT count(*)::int total FROM public.operations_item_status os
       JOIN public.orders o ON o.id=os.order_id AND o.tenant_id=os.tenant_id
       JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
       JOIN public.order_items oi ON oi.id=os.order_item_id AND oi.tenant_id=os.tenant_id
       LEFT JOIN public.price_items pi ON pi.id=oi.price_item_id AND pi.tenant_id=oi.tenant_id
       WHERE ${where}`, values
    );
    const result = await query(
      `SELECT oi.id item_id,pi.name,oi.quantity,oi.notes item_note,os.operations_note,o.id order_id,o.order_number,
       c.name customer_name,b.name branch_name,o.branch_id FROM public.operations_item_status os
       JOIN public.orders o ON o.id=os.order_id AND o.tenant_id=os.tenant_id
       JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
       JOIN public.order_items oi ON oi.id=os.order_item_id AND oi.tenant_id=os.tenant_id
       LEFT JOIN public.price_items pi ON pi.id=oi.price_item_id AND pi.tenant_id=oi.tenant_id
       LEFT JOIN public.branches b ON b.id=o.branch_id WHERE ${where}
       ORDER BY os.ready_at DESC NULLS LAST,oi.id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values, limit, offset]
    );
    const total = Number(count.rows[0]?.total || 0);
    res.json({ items: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) { console.error('Operations ready report error:', error); res.status(500).json({ error: 'Unable to load ready items' }); }
};
export const updateOperationsItem = async (req: AuthRequest, res: Response) => {
  const itemId = Number(req.params.itemId), status = String(req.body.status || '').toUpperCase();
  if (!Number.isSafeInteger(itemId) || itemId < 1 || !statuses.includes(status)) return res.status(400).json({ error: 'Valid item and status are required' });
  const client = await getClient();
  try {
    await beginTenantTransaction(client);
    const found = await client.query(
      `SELECT oi.id,oi.order_id,o.status order_status,o.branch_id FROM public.order_items oi
       JOIN public.orders o ON o.id=oi.order_id AND o.tenant_id=oi.tenant_id
       WHERE oi.id=$1 AND oi.tenant_id=app_current_tenant_id() FOR UPDATE OF o`, [itemId]
    );
    if (!found.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order item not found' }); }
    if (String(found.rows[0].order_status).toUpperCase() === 'DELIVERED') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Delivered items are read-only in Operations' }); }
    const branchFilter = branchIdFor(req);
    if (branchFilter !== null && Number(found.rows[0].branch_id) !== branchFilter) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'You cannot update this branch item' }); }
    await client.query(
      `INSERT INTO public.operations_item_status(tenant_id,order_id,order_item_id,status,ready_at,updated_by,updated_at)
       SELECT oi.tenant_id,oi.order_id,oi.id,$2,CASE WHEN $2='READY' THEN NOW() ELSE NULL END,$3,NOW()
       FROM public.order_items oi WHERE oi.id=$1 AND oi.tenant_id=app_current_tenant_id()
       ON CONFLICT(tenant_id,order_item_id) DO UPDATE SET status=EXCLUDED.status,ready_at=EXCLUDED.ready_at,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [itemId,status,req.user!.id]
    );
    const totals = await client.query(
      `SELECT count(*)::int total,count(*) FILTER(WHERE os.status='READY')::int ready FROM public.order_items oi
       LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
       WHERE oi.order_id=$1 AND oi.tenant_id=app_current_tenant_id()`, [found.rows[0].order_id]
    );
    const ready = Number(totals.rows[0].total) > 0 && Number(totals.rows[0].total) === Number(totals.rows[0].ready);
    const old = String(found.rows[0].order_status).toUpperCase();
    await client.query("SELECT set_config('app.operations_status_update','true',true)");
    if (ready && old !== 'READY') await client.query("UPDATE public.orders SET status='READY',updated_at=NOW() WHERE id=$1 AND tenant_id=app_current_tenant_id()", [found.rows[0].order_id]);
    else if (!ready && old === 'READY') await client.query("UPDATE public.orders SET status='PROCESSING',updated_at=NOW() WHERE id=$1 AND tenant_id=app_current_tenant_id()", [found.rows[0].order_id]);
    else if (!ready && ['PENDING'].includes(old)) await client.query("UPDATE public.orders SET status='PROCESSING',updated_at=NOW() WHERE id=$1 AND tenant_id=app_current_tenant_id()", [found.rows[0].order_id]);
    await client.query('COMMIT');
    res.json({ success: true, order_ready: ready });
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} console.error('Operations item update error:', error); res.status(500).json({ error: 'Unable to update item status' }); }
  finally { client.release(); }
};

export const markOperationsOrderReady = async (req: AuthRequest, res: Response) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({ error: 'Valid order is required' });
  const client = await getClient();
  try {
    await beginTenantTransaction(client);
    const found = await client.query(
      `SELECT id,status,branch_id FROM public.orders WHERE id=$1 AND tenant_id=app_current_tenant_id() FOR UPDATE`,
      [orderId]
    );
    if (!found.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    const currentStatus = String(found.rows[0].status || '').toUpperCase();
    if (['DELIVERED', 'CANCELLED'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Delivered or cancelled orders cannot be changed in Operations' });
    }
    const branchFilter = branchIdFor(req);
    if (branchFilter !== null && Number(found.rows[0].branch_id) !== branchFilter) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You cannot update this branch order' });
    }

    await client.query("SELECT set_config('app.operations_status_update','true',true)");
    const itemResult = await client.query(
      `INSERT INTO public.operations_item_status AS existing(tenant_id,order_id,order_item_id,status,ready_at,updated_by,updated_at)
       SELECT oi.tenant_id,oi.order_id,oi.id,'READY',NOW(),$2,NOW()
       FROM public.order_items oi WHERE oi.order_id=$1 AND oi.tenant_id=app_current_tenant_id()
       ON CONFLICT(tenant_id,order_item_id) DO UPDATE
         SET status='READY',ready_at=COALESCE(existing.ready_at,NOW()),updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [orderId, req.user!.id]
    );
    if (itemResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This order has no items to mark ready' });
    }
    await client.query(
      `UPDATE public.orders SET status='READY',updated_at=NOW() WHERE id=$1 AND tenant_id=app_current_tenant_id()`,
      [orderId]
    );
    await client.query('COMMIT');
    res.json({ success: true, order_ready: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Operations order ready error:', error);
    res.status(500).json({ error: 'Unable to mark order ready' });
  } finally {
    client.release();
  }
};
export const updateOperationsItemNote = async (req: AuthRequest, res: Response) => {
  const itemId = Number(req.params.itemId), note = String(req.body.note || '').trim();
  if (!Number.isSafeInteger(itemId) || itemId < 1 || note.length > 500) return res.status(400).json({ error: 'Operations notes must be 500 characters or fewer' });
  try {
    const branch = branchIdFor(req);
    const result = await query(
      `INSERT INTO public.operations_item_status AS existing
        (tenant_id,order_id,order_item_id,status,operations_note,updated_by,updated_at)
       SELECT oi.tenant_id,o.id,oi.id,'RECEIVED',$2,$4,NOW()
       FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id AND o.tenant_id=oi.tenant_id
       WHERE oi.id=$1 AND oi.tenant_id=app_current_tenant_id() AND upper(o.status::text)<>'DELIVERED'
         AND upper(o.status::text)<>'CANCELLED' AND ($3::int IS NULL OR o.branch_id=$3)
       ON CONFLICT (tenant_id,order_item_id) DO UPDATE
         SET operations_note=EXCLUDED.operations_note,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING existing.order_item_id`, [itemId,note || null,branch,req.user?.id || null]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Active item not found or outside your branch' });
    res.json({ success: true });
  } catch (error) { console.error('Operations note error:', error); res.status(500).json({ error: 'Unable to save item note' }); }
};
export const getOperationsMessages = async (req: AuthRequest, res: Response) => {
  try {
    const branch = branchIdFor(req), values: unknown[] = [];
    let where = 'm.tenant_id=app_current_tenant_id()';
    if (branch !== null) { values.push(branch); where += ` AND m.branch_id=$${values.length}`; }
    const result = await query(
      `SELECT m.id,m.branch_id,b.name branch_name,m.order_id,o.order_number,m.message,u.full_name sender,m.created_at
       FROM public.operations_messages m LEFT JOIN public.branches b ON b.id=m.branch_id
       LEFT JOIN public.orders o ON o.id=m.order_id AND o.tenant_id=m.tenant_id
       LEFT JOIN public.users u ON u.id=m.sender_id AND u.tenant_id=m.tenant_id
       WHERE ${where} ORDER BY m.created_at DESC LIMIT 100`, values
    );
    res.json({ messages: result.rows });
  } catch (error) { console.error('Operations messages error:', error); res.status(500).json({ error: 'Unable to load messages' }); }
};
export const sendOperationsMessage = async (req: AuthRequest, res: Response) => {
  const message = String(req.body.message || '').trim(), branch = Number(req.body.branch_id);
  const orderId = req.body.order_id ? Number(req.body.order_id) : null;
  if (!message || message.length > 2000 || !Number.isSafeInteger(branch) || branch < 1) return res.status(400).json({ error: 'Choose a branch and enter a message of up to 2,000 characters' });
  try {
    const b = await query('SELECT id,name FROM public.branches WHERE id=$1',[branch]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Branch not found' });
    if (orderId) {
      const o = await query('SELECT id FROM public.orders WHERE id=$1 AND branch_id=$2',[orderId,branch]);
      if (!o.rows[0]) return res.status(404).json({ error: 'Order not found at that branch' });
    }
    const saved = await query(
      'INSERT INTO public.operations_messages(tenant_id,branch_id,order_id,sender_id,message) VALUES(app_current_tenant_id(),$1,$2,$3,$4) RETURNING id,created_at',
      [branch,orderId,req.user!.id,message]
    );
    const recipients = await query(
      "SELECT id FROM public.users WHERE tenant_id=app_current_tenant_id() AND status='ACTIVE' AND branch_id=$1 AND role IN('ADMIN','MANAGER','DESKTOP_AGENT') AND id<>$2",
      [branch,req.user!.id]
    );
    for (const recipient of recipients.rows) await query(
      "INSERT INTO public.notifications(user_id,type,title,message,data) VALUES($1,'SYSTEM_ALERT','Operations message',$2,$3::jsonb)",
      [recipient.id,message,JSON.stringify({operations_message_id:saved.rows[0].id,order_id:orderId,branch_id:branch})]
    );
    res.status(201).json({ message: { id:saved.rows[0].id,branch_id:branch,branch_name:b.rows[0].name,order_id:orderId,message,sender:req.user!.full_name,created_at:saved.rows[0].created_at } });
  } catch (error) { console.error('Operations message send error:',error); res.status(500).json({error:'Unable to send message'}); }
};

export const getOperationsBranches = async (_req: AuthRequest, res: Response) => {
 try {
  const result = await query("SELECT id,name FROM public.branches WHERE tenant_id=app_current_tenant_id() AND is_active=TRUE ORDER BY is_default DESC,name");
  res.json({ branches: result.rows });
 } catch (error) { console.error('Operations branch list error:',error); res.status(500).json({error:'Unable to load branches'}); }
};
