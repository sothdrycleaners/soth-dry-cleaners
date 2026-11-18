import { PoolClient } from 'pg';

export async function getAvailableCustomerCredit(client: PoolClient, customerId: number) {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS available_credit
     FROM customer_credit_transactions
     WHERE tenant_id = app_current_tenant_id() AND customer_id = $1`,
    [customerId]
  );
  return Math.max(0, Number(result.rows[0]?.available_credit) || 0);
}

/** Apply a requested amount from dated credit lots, oldest first. The caller
 * must lock the customer row in this transaction before calling this helper. */
export async function applyCustomerCreditInTransaction(
  client: PoolClient,
  input: { customerId: number; orderId: number; branchId: number | null; amount: number; paymentDate: string; createdBy: number; notes: string }
) {
  const available = await getAvailableCustomerCredit(client, input.customerId);
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > available + 0.009) {
    throw new Error(`Requested credit exceeds the available customer credit of UGX ${Math.floor(available).toLocaleString()}.`);
  }
  const application = await client.query(
    `INSERT INTO customer_credit_transactions
       (customer_id, order_id, branch_id, entry_type, amount, payment_method, payment_date, notes, created_by)
     VALUES ($1, $2, $3, 'APPLICATION', $4, 'CUSTOMER_CREDIT', $5::timestamp, $6, $7)
     RETURNING id`,
    [input.customerId, input.orderId, input.branchId, -input.amount, input.paymentDate, input.notes, input.createdBy]
  );
  const applicationId = Number(application.rows[0].id);
  const sources = await client.query(
    `SELECT src.id, src.amount,
       src.amount - COALESCE((
         SELECT SUM(CASE WHEN a.allocation_type = 'APPLY' THEN a.amount ELSE -a.amount END)
         FROM customer_credit_allocations a
         WHERE a.tenant_id = app_current_tenant_id() AND a.source_transaction_id = src.id
       ), 0) AS remaining
     FROM customer_credit_transactions src
     WHERE src.tenant_id = app_current_tenant_id() AND src.customer_id = $1
       AND src.entry_type IN ('DEPOSIT', 'ORDER_OVERPAYMENT')
     ORDER BY src.payment_date ASC, src.id ASC`,
    [input.customerId]
  );
  let amountLeft = input.amount;
  for (const source of sources.rows) {
    const lotRemaining = Math.max(0, Number(source.remaining) || 0);
    if (!lotRemaining || !amountLeft) continue;
    const allocation = Math.min(lotRemaining, amountLeft);
    await client.query(
      `INSERT INTO customer_credit_allocations
         (application_transaction_id, source_transaction_id, allocation_type, amount, created_by)
       VALUES ($1, $2, 'APPLY', $3, $4)`,
      [applicationId, source.id, allocation, input.createdBy]
    );
    amountLeft -= allocation;
  }
  if (amountLeft > 0.009) throw new Error('Customer credit lots do not reconcile to the available balance.');
  return applicationId;
}

export async function releaseOrderCreditAllocations(client: PoolClient, orderId: number, createdBy: number) {
  const applications = await client.query(
    `SELECT ct.id, ct.customer_id, ct.branch_id, -ct.amount AS amount
     FROM customer_credit_transactions ct
     WHERE ct.tenant_id = app_current_tenant_id() AND ct.order_id = $1
       AND ct.entry_type = 'APPLICATION'
     ORDER BY ct.id`, [orderId]
  );
  const total = applications.rows.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);
  if (total <= 0) return 0;
  const order = await client.query('SELECT customer_id, branch_id, order_number FROM orders WHERE id = $1', [orderId]);
  if (!order.rowCount) return 0;
  const reversal = await client.query(
    `INSERT INTO customer_credit_transactions
       (customer_id, order_id, branch_id, entry_type, amount, payment_method, notes, created_by)
     VALUES ($1, $2, $3, 'REVERSAL', $4, 'CUSTOMER_CREDIT', $5, $6)
     ON CONFLICT (tenant_id, order_id) WHERE entry_type = 'REVERSAL' AND order_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [order.rows[0].customer_id, orderId, order.rows[0].branch_id, total,
     `Restored applied customer credit after cancellation of ${order.rows[0].order_number}`, createdBy]
  );
  if (!reversal.rowCount) return 0;
  for (const application of applications.rows) {
    const allocations = await client.query(
      `SELECT source_transaction_id,
         SUM(CASE WHEN allocation_type = 'APPLY' THEN amount ELSE -amount END) AS net_amount
       FROM customer_credit_allocations
       WHERE tenant_id = app_current_tenant_id() AND application_transaction_id = $1
       GROUP BY source_transaction_id
       HAVING SUM(CASE WHEN allocation_type = 'APPLY' THEN amount ELSE -amount END) > 0`,
      [application.id]
    );
    for (const allocation of allocations.rows) {
      await client.query(
        `INSERT INTO customer_credit_allocations
           (application_transaction_id, source_transaction_id, allocation_type, amount, created_by)
         VALUES ($1, $2, 'RELEASE', $3, $4)`,
        [application.id, allocation.source_transaction_id, allocation.net_amount, createdBy]
      );
    }
  }
  return total;
}
