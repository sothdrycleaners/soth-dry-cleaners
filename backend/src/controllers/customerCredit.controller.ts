import { Response } from 'express';
import { getClient, beginTenantTransaction, query } from '../config/database';
import { AuthRequest } from '../middleware/auth';

const validMethods = new Set(['CASH', 'MOBILE_MONEY_MTN', 'MOBILE_MONEY_AIRTEL', 'BANK_TRANSFER']);

export const getCustomerCredit = async (req: AuthRequest, res: Response) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) return res.status(400).json({ error: 'Invalid customer ID' });
    const result = await query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS available_credit
       FROM customer_credit_transactions
       WHERE tenant_id = app_current_tenant_id() AND customer_id = $1`,
      [customerId]
    );
    const transactions = await query(
      `SELECT ct.id, ct.entry_type, ct.amount, ct.payment_method, ct.transaction_reference,
              ct.payment_date, ct.notes, ct.order_id, o.order_number,
              CASE WHEN ct.entry_type IN ('DEPOSIT', 'ORDER_OVERPAYMENT') THEN
                GREATEST(0, ct.amount - COALESCE((
                  SELECT SUM(CASE WHEN a.allocation_type = 'APPLY' THEN a.amount ELSE -a.amount END)
                  FROM customer_credit_allocations a
                  WHERE a.tenant_id = ct.tenant_id AND a.source_transaction_id = ct.id
                ), 0))
              ELSE NULL END AS remaining_amount
       FROM customer_credit_transactions ct
       LEFT JOIN orders o ON o.id = ct.order_id
       WHERE ct.tenant_id = app_current_tenant_id() AND ct.customer_id = $1
       ORDER BY ct.payment_date DESC, ct.id DESC LIMIT 100`,
      [customerId]
    );
    res.json({ available_credit: Number(result.rows[0]?.available_credit || 0), transactions: transactions.rows });
  } catch (error) {
    console.error('Get customer credit error:', error);
    res.status(500).json({ error: 'Failed to fetch customer credit' });
  }
};

export const recordCustomerDeposit = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await beginTenantTransaction(client);
    const customerId = Number(req.params.id);
    const amount = Number(req.body.amount);
    const paymentMethod = String(req.body.payment_method || '').toUpperCase();
    const transactionReference = String(req.body.transaction_reference || '').trim() || null;
    const notes = String(req.body.notes || '').trim() || 'Customer advance deposit';
    const paymentDate = req.body.payment_date ? String(req.body.payment_date) : null;
    if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      throw Object.assign(new Error('Choose a valid payment date'), { statusCode: 400 });
    }
    if (paymentDate && paymentDate > new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
      throw Object.assign(new Error('Payment date cannot be in the future'), { statusCode: 400 });
    }
    if (!Number.isInteger(customerId) || customerId <= 0) throw Object.assign(new Error('Invalid customer ID'), { statusCode: 400 });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999) throw Object.assign(new Error('Enter a valid deposit amount'), { statusCode: 400 });
    if (!validMethods.has(paymentMethod)) throw Object.assign(new Error('Choose a valid payment method'), { statusCode: 400 });
    const customer = await client.query(
      `SELECT id FROM customers WHERE id = $1 AND tenant_id = app_current_tenant_id() FOR UPDATE`,
      [customerId]
    );
    if (!customer.rowCount) throw Object.assign(new Error('Customer not found'), { statusCode: 404 });
    const branchId = req.user?.branch_id ?? null;
    await client.query(
      `INSERT INTO customer_credit_transactions
         (customer_id, entry_type, amount, payment_method, transaction_reference, payment_date, notes, created_by, branch_id)
       VALUES ($1, 'DEPOSIT', $2, $3, $4, COALESCE($5::timestamp, NOW()), $6, $7, $8)`,
      [customerId, amount, paymentMethod, transactionReference, paymentDate, notes, req.user!.id, branchId]
    );
    const balance = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS available_credit
       FROM customer_credit_transactions WHERE tenant_id = app_current_tenant_id() AND customer_id = $1`,
      [customerId]
    );
    await client.query('COMMIT');
    res.status(201).json({ message: 'Customer deposit recorded', available_credit: Number(balance.rows[0].available_credit) });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Record customer deposit error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to record customer deposit' });
  } finally {
    client.release();
  }
};
