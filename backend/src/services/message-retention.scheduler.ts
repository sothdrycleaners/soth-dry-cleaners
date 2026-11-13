import { query } from '../config/database';
import { runWithTenantContext } from '../utils/tenantContext';

const DEFAULT_RETENTION_DAYS = 30;
const BATCH_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
let cleanupRunning = false;

async function getRetentionDays(): Promise<number | null> {
  const result = await query(
    `SELECT setting_value FROM business_settings WHERE tenant_id=app_current_tenant_id() AND setting_key='message_retention_days' LIMIT 1`
  );
  if (!result.rows.length) return DEFAULT_RETENTION_DAYS;
  const raw = result.rows[0].setting_value;
  const value = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw;
  if (value === null || value === 'permanent') return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 7 ? days : DEFAULT_RETENTION_DAYS;
}

async function cleanupTenantMessages(tenantId: number): Promise<number> {
  return runWithTenantContext(tenantId, async () => {
    const days = await getRetentionDays();
    if (days === null) return 0;
    let deleted = 0;
    while (true) {
      const expired = await query(
        `SELECT id FROM operations_messages
         WHERE tenant_id=app_current_tenant_id() AND created_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY id LIMIT $2`,
        [days, BATCH_SIZE]
      );
      if (!expired.rows.length) break;
      const ids = expired.rows.map((row: { id: string | number }) => String(row.id));
      await query(
        `DELETE FROM notifications WHERE user_id IN (
           SELECT DISTINCT recipient_id FROM operations_messages
           WHERE tenant_id=app_current_tenant_id() AND id=ANY($1::bigint[]) AND recipient_id IS NOT NULL
         ) AND data->>'operations_message_id'=ANY($2::text[])`,
        [ids, ids]
      );
      const removed = await query(
        `DELETE FROM operations_messages WHERE tenant_id=app_current_tenant_id() AND id=ANY($1::bigint[]) RETURNING id`,
        [ids]
      );
      deleted += removed.rowCount || 0;
      if (expired.rows.length < BATCH_SIZE) break;
    }
    return deleted;
  });
}

async function cleanupAllTenants(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const tenants = await query('SELECT id FROM tenants WHERE is_active=TRUE ORDER BY id');
    for (const tenant of tenants.rows) {
      const tenantId = Number(tenant.id);
      try {
        const removed = await cleanupTenantMessages(tenantId);
        if (removed) console.log(`Message retention: removed ${removed} expired messages for tenant ${tenantId}`);
      } catch (error: any) {
        console.error(`Message retention cleanup failed for tenant ${tenantId}:`, error?.message || error);
      }
    }
  } catch (error: any) {
    console.error('Message retention cleanup failed:', error?.message || error);
  } finally {
    cleanupRunning = false;
  }
}

export function initializeMessageRetentionScheduler(): void {
  void cleanupAllTenants();
  setInterval(() => void cleanupAllTenants(), DAY_MS);
  console.log('Message retention cleanup scheduled daily; the policy is read from Settings for each tenant.');
}
