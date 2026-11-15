import { Response } from 'express';
import { validationResult } from 'express-validator';
import { beginTenantTransaction, getClient, query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { resolveWriteBranchId, resolveListBranchId } from '../utils/branchScope';

function toDateOnly(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const raw = String(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parsed.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeExpenseRow(row: Record<string, unknown>) {
  return {
    ...row,
    expense_date: toDateOnly(row.expense_date ?? row.date),
    status: row.status || row.approval_status,
  };
}

/**
 * Record a new expense
 */
export const recordExpense = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      expense_date,
      category,
      description,
      amount,
      payment_method,
      receipt_number,
      branch_id: requestedBranchId,
    } = req.body;

    const userId = req.user?.id;
    const branchId = resolveWriteBranchId(req, requestedBranchId);

    if (!branchId) {
      return res.status(400).json({ error: 'Assign this expense to an active branch before recording it.' });
    }
    const branchCheck = await query(
      'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE',
      [branchId, req.user?.tenant_id]
    );
    if (!branchCheck.rows.length) {
      return res.status(400).json({ error: 'Choose an active branch for this expense.' });
    }
    const branchName = branchCheck.rows[0].name;

    const categoryCheck = await query(
      `SELECT id FROM expense_categories
       WHERE tenant_id = $1 AND name = $2 AND is_active = TRUE`,
      [req.user?.tenant_id, category]
    );
    if (!categoryCheck.rows.length) {
      return res.status(400).json({ error: 'Choose an active expense category.' });
    }

    const isAdminEntry = req.user?.role === 'ADMIN';
    const initialStatus = isAdminEntry ? 'APPROVED' : 'PENDING';
    const result = await query(
      `INSERT INTO expenses
       (expense_date, category, description, amount, payment_method, receipt_number, submitted_by,
        status, approval_status, approved_by, approved_at, created_at, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $8::text, $9,
         CASE WHEN $8::text = 'APPROVED' THEN NOW() ELSE NULL END, NOW(), $10)
       RETURNING id, expense_date, description, amount, status, approval_status, approved_by, approved_at, branch_id`,
      [expense_date || new Date(), category, description, amount, payment_method || 'CASH', receipt_number, userId, initialStatus, isAdminEntry ? userId : null, branchId]
    );

    // Log activity
    await query(
      `INSERT INTO activity_logs (user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, 'RECORD_EXPENSE', JSON.stringify({ expense_id: result.rows[0].id, amount, description, branch_id: branchId, status: initialStatus })]
    );

    // Professional hierarchical notification system
    const creatorRole = req.user?.role;
    const creatorName = req.user?.full_name || 'Staff';
    
    if (creatorRole === 'DESKTOP_AGENT') {
      // Desktop Agent creates an expense for administrator approval.
      const approvers = await query(
        `SELECT id, full_name, role FROM users WHERE role = 'ADMIN' AND id != $1 AND tenant_id = $2`,
        [userId, req.user?.tenant_id]
      );

      for (const approver of approvers.rows) {
        await query(
          `INSERT INTO notifications (user_id, type, title, message, link, created_at)
           VALUES ($1, 'expense', 'Pending Expense Approval', $2, '/expenses', NOW())`,
          [
            approver.id,
            `${creatorName} submitted an expense of UGX ${parseFloat(amount).toLocaleString()} at ${branchName} for approval. ${description}`
          ]
        );
      }
    } else if (creatorRole === 'MANAGER') {
      // Manager creates → Notify Admin only (only Admin can approve)
      const admins = await query(
        `SELECT id FROM users WHERE role = 'ADMIN' AND tenant_id = $1`,
        [req.user?.tenant_id]
      );

      for (const admin of admins.rows) {
        await query(
          `INSERT INTO notifications (user_id, type, title, message, link, created_at)
           VALUES ($1, 'expense', 'Pending Expense Approval', $2, '/expenses', NOW())`,
          [
            admin.id,
            `${creatorName} submitted an expense of UGX ${parseFloat(amount).toLocaleString()} at ${branchName} for approval. ${description}`
          ]
        );
      }
    }

    res.status(201).json({
      message: isAdminEntry ? 'Expense recorded and approved successfully' : 'Expense recorded and submitted for approval',
      expense: result.rows[0],
    });

  } catch (error) {
    console.error('Record expense error:', error);
    res.status(500).json({ error: 'Failed to record expense' });
  }
};

/**
 * Get all expenses with filters and pagination
 * - Hides REJECTED expenses from Desktop Agents
 */
export const getAllExpenses = async (req: AuthRequest, res: Response) => {
  try {
    const {
      page = 1,
      limit = 20,
      from_date,
      to_date,
      category_id,
      category,
      approval_status,
      status,
      search,
      branch_id,
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const userRole = req.user?.role;

    // Build WHERE clause
    let whereClause = 'WHERE 1=1';
    const values: any[] = [];
    let paramCount = 1;

    // RULE: Desktop Agents cannot see REJECTED expenses
    if (userRole === 'DESKTOP_AGENT') {
      whereClause += ` AND e.status != 'REJECTED'`;
    }

    const listBranchId = resolveListBranchId(req, branch_id);
    if (listBranchId) {
      whereClause += ` AND e.branch_id = $${paramCount++}`;
      values.push(listBranchId);
    }

    if (from_date) {
      whereClause += ` AND e.expense_date >= $${paramCount++}`;
      values.push(from_date);
    }

    if (to_date) {
      whereClause += ` AND e.expense_date <= $${paramCount++}`;
      values.push(to_date);
    }

    const categoryFilter = category || category_id;
    if (categoryFilter) {
      whereClause += ` AND e.category = $${paramCount++}`;
      values.push(categoryFilter);
    }

    const statusFilter = approval_status || status;
    if (statusFilter) {
      whereClause += ` AND e.status = $${paramCount++}`;
      values.push(statusFilter);
    }

    if (search) {
      whereClause += ` AND (e.description ILIKE $${paramCount} OR e.receipt_number ILIKE $${paramCount})`;
      values.push(`%${search}%`);
      paramCount++;
    }

    values.push(limit, offset);

    const result = await query(
      `SELECT 
        e.*,
        e.category as category_name,
        COALESCE(ec.color, '#3B82F6') as category_color,
        u1.full_name as recorded_by_name,
        u2.full_name as approved_by_name,
        u3.full_name as rejected_by_name,
        b.name as branch_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.tenant_id = e.tenant_id AND ec.name = e.category
       LEFT JOIN users u1 ON e.submitted_by = u1.id
       LEFT JOIN users u2 ON e.approved_by = u2.id
       LEFT JOIN users u3 ON e.rejected_by = u3.id
       LEFT JOIN branches b ON e.branch_id = b.id
       ${whereClause}
       ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
       LIMIT $${paramCount++} OFFSET $${paramCount}`,
      values
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM expenses e ${whereClause}`,
      values.slice(0, -2)
    );

    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      expenses: result.rows.map((row) => normalizeExpenseRow(row)),
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)),
        totalCount,
        pageSize: Number(limit),
      },
    });

  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'Failed to get expenses' });
  }
};

/**
 * Get expense by ID
 */
export const getExpenseById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT 
        e.*,
        e.category as category_name,
        COALESCE(ec.color, '#3B82F6') as category_color,
        u1.full_name as recorded_by_name,
        u1.email as recorded_by_email,
        u2.full_name as approved_by_name,
        u3.full_name as rejected_by_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON ec.tenant_id = e.tenant_id AND ec.name = e.category
       LEFT JOIN users u1 ON e.submitted_by = u1.id
       LEFT JOIN users u2 ON e.approved_by = u2.id
       LEFT JOIN users u3 ON e.rejected_by = u3.id
       WHERE e.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    res.json(normalizeExpenseRow(result.rows[0]));

  } catch (error) {
    console.error('Get expense by ID error:', error);
    res.status(500).json({ error: 'Failed to get expense' });
  }
};

/**
 * Update expense (only if not approved)
 */
export const updateExpense = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const expenseCheck = await query(
      'SELECT id, status, submitted_by, expense_date, category, description, amount, payment_method, receipt_number FROM expenses WHERE id = $1 AND tenant_id = $2',
      [id, user.tenant_id]
    );
    if (!expenseCheck.rows.length) return res.status(404).json({ error: 'Expense not found' });

    const current = expenseCheck.rows[0];
    const isAdmin = user.role === 'ADMIN';
    const isOwnerPending = current.status === 'PENDING' && Number(current.submitted_by) === user.id;
    if (!isAdmin && !isOwnerPending) {
      return res.status(403).json({
        error: current.status === 'APPROVED'
          ? 'Only an administrator can edit an approved expense.'
          : 'You can edit only your own pending expenses.',
      });
    }

    const body = req.body;
    const values = [
      body.expense_date !== undefined ? body.expense_date : current.expense_date,
      body.category !== undefined ? body.category : current.category,
      body.description !== undefined ? body.description : current.description,
      body.amount !== undefined ? body.amount : current.amount,
      body.payment_method !== undefined ? body.payment_method : current.payment_method,
      body.receipt_number !== undefined ? body.receipt_number : current.receipt_number,
      id,
      user.tenant_id,
      user.role,
      user.id,
    ];

    const result = await query(
      `UPDATE expenses
       SET expense_date = $1, category = $2, description = $3, amount = $4,
           payment_method = $5, receipt_number = $6, updated_at = NOW()
       WHERE id = $7 AND tenant_id = $8
         AND ($9 = 'ADMIN' OR (status = 'PENDING' AND submitted_by = $10))
       RETURNING *`,
      values
    );
    if (!result.rows.length) {
      return res.status(409).json({ error: 'This expense changed status and can no longer be edited by this account.' });
    }

    await query(
      `INSERT INTO activity_logs (user_id, action, details, created_at)
       VALUES ($1, 'EDIT_EXPENSE', $2, NOW())`,
      [user.id, JSON.stringify({ expense_id: id, old_status: current.status, old_amount: current.amount, new_amount: result.rows[0].amount })]
    );

    res.json({ message: 'Expense updated successfully', expense: normalizeExpenseRow(result.rows[0]) });
  } catch (error) {
    console.error('Update expense error:', error);
    res.status(500).json({ error: 'Failed to update expense' });
  }
};
/**
 * Approve/reject expense (administrator only).
 */
export const approveExpense = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { approval_status, approval_notes, rejection_reason } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(approval_status)) {
      return res.status(400).json({ error: 'Invalid approval status' });
    }

    const userId = req.user?.id;
    const approverRole = req.user?.role;

    if (approverRole !== 'ADMIN') {
      return res.status(403).json({ error: 'Only administrators can approve or reject expenses.' });
    }

    const expenseCheck = await query(
      `SELECT e.* FROM expenses e WHERE e.id = $1 AND e.tenant_id = $2`,
      [id, req.user?.tenant_id]
    );
    if (!expenseCheck.rows.length) return res.status(404).json({ error: 'Expense not found' });

    let updateQuery;
    let queryParams;
    
    if (approval_status === 'APPROVED') {
      updateQuery = `UPDATE expenses 
       SET status = $1,
           approval_status = $1,
           approved_by = $2,
           approved_at = NOW(),
           approval_notes = $3,
           rejected_by = NULL,
           rejected_at = NULL,
           rejection_reason = NULL,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`;
      queryParams = [approval_status, userId, approval_notes || null, id, req.user?.tenant_id];
    } else {
      updateQuery = `UPDATE expenses 
       SET status = $1,
           approval_status = $1,
           rejected_by = $2,
           rejected_at = NOW(),
           rejection_reason = $3,
           approved_by = NULL,
           approved_at = NULL,
           approval_notes = NULL,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`;
      queryParams = [approval_status, userId, rejection_reason || null, id, req.user?.tenant_id];
    }

    const result = await query(updateQuery, queryParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    // Log activity
    await query(
      `INSERT INTO activity_logs (user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, 'APPROVE_EXPENSE', JSON.stringify({ expense_id: id, status: approval_status })]
    );

    const expense = result.rows[0];
    if (expense.submitted_by && expense.submitted_by !== userId) {
      const approverResult = await query(
        `SELECT full_name, role FROM users WHERE id = $1`,
        [userId]
      );
      const approverName = approverResult.rows[0]?.full_name || 'Administrator';
      const userRoleName = approverResult.rows[0]?.role || 'ADMIN';
      
      let notificationTitle = '';
      let notificationMessage = '';
      
      if (approval_status === 'APPROVED') {
        notificationTitle = 'Expense Approved ✓';
        notificationMessage = `Your expense of UGX ${parseFloat(expense.amount).toLocaleString()} has been approved by ${approverName} (${userRoleName}).`;
        if (approval_notes) notificationMessage += `\n\nNotes: ${approval_notes}`;
      } else {
        notificationTitle = 'Expense Rejected';
        notificationMessage = `Your expense of UGX ${parseFloat(expense.amount).toLocaleString()} for "${expense.description}" has been rejected by ${approverName} (${userRoleName}).\n\n`;
        if (rejection_reason) notificationMessage += `Reason: ${rejection_reason}\n\n`;
      }

      await query(
        `INSERT INTO notifications (user_id, type, title, message, link, created_at)
         VALUES ($1, 'expense', $2, $3, '/expenses', NOW())`,
        [expense.submitted_by, notificationTitle, notificationMessage]
      );
    }

    res.json({
      message: `Expense ${approval_status.toLowerCase()} successfully`,
      expense: normalizeExpenseRow(result.rows[0]),
    });

  } catch (error) {
    console.error('Approve expense error:', error);
    res.status(500).json({ error: 'Failed to approve/reject expense' });
  }
};

/**
 * Delete expense permanently
 * Rules:
 * - Administrators only.
 * - REJECTED expenses: Can be deleted permanently at any time.
 * - APPROVED expenses: Can be deleted ONLY if approved within the last 7 days.
 * - PENDING expenses: Can be deleted freely.
 */
export const deleteExpense = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;

    if (userRole !== 'ADMIN') {
      return res.status(403).json({ error: 'Only administrators can permanently delete expenses' });
    }

    const expenseCheck = await query(
      'SELECT status, approved_at, created_at FROM expenses WHERE id = $1',
      [id]
    );

    if (expenseCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const { status, approved_at } = expenseCheck.rows[0];

    // Rule 1: Rejected expenses can be deleted permanently at any time
    if (status === 'REJECTED') {
      await query('DELETE FROM expenses WHERE id = $1', [id]);
      return res.json({ message: 'Rejected expense deleted permanently' });
    }

    // Rule 2: Approved expenses can only be deleted within 7 days of approval
    if (status === 'APPROVED') {
      if (!approved_at) {
        return res.status(400).json({ error: 'Approval date missing. Cannot verify 7-day deletion limit.' });
      }

      const approvedTime = new Date(approved_at).getTime();
      const currentTime = new Date().getTime();
      const diffInDays = (currentTime - approvedTime) / (1000 * 60 * 60 * 24);

      if (diffInDays > 7) {
        return res.status(400).json({ 
          error: 'Approved expenses older than 7 days cannot be deleted permanently' 
        });
      }

      await query('DELETE FROM expenses WHERE id = $1', [id]);
      return res.json({ message: 'Approved expense deleted permanently' });
    }

    // Rule 3: Pending expenses
    await query('DELETE FROM expenses WHERE id = $1', [id]);
    res.json({ message: 'Expense deleted successfully' });

  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
};

/**
 * Get expense categories
 */
export const getExpenseCategories = async (req: AuthRequest, res: Response) => {
  try {
    const includeInactive = req.user?.role === 'ADMIN' && req.query.include_inactive === 'true';
    const categories = await query(
      `SELECT id, name, description, color, is_active
       FROM expense_categories
       WHERE tenant_id = $1 AND ($2::boolean OR is_active = TRUE)
       ORDER BY is_active DESC, lower(name), id`,
      [req.user?.tenant_id, includeInactive]
    );
    res.json(categories.rows);
  } catch (error) {
    console.error('Get expense categories error:', error);
    res.status(500).json({ error: 'Failed to get expense categories' });
  }
};

export const createExpenseCategory = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { name, description = '', color = '#3B82F6' } = req.body;
    const result = await query(
      `INSERT INTO expense_categories (tenant_id, name, description, color, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
       RETURNING id, name, description, color, is_active`,
      [req.user?.tenant_id, String(name).trim(), String(description).trim(), color]
    );
    res.status(201).json({ message: 'Expense category added', category: result.rows[0] });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A category with this name already exists.' });
    }
    console.error('Create expense category error:', error);
    res.status(500).json({ error: 'Failed to add expense category' });
  }
};

export const updateExpenseCategory = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await beginTenantTransaction(client);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { name, description = '', color = '#3B82F6' } = req.body;
    const existing = await client.query(
      'SELECT id, name FROM expense_categories WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, req.user?.tenant_id]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Expense category not found.' });
    }

    const oldName = existing.rows[0].name as string;
    const updated = await client.query(
      `UPDATE expense_categories
       SET name = $1, description = $2, color = $3,
           is_active = COALESCE($4, is_active), updated_at = NOW()
       WHERE id = $5 AND tenant_id = $6
       RETURNING id, name, description, color, is_active`,
      [String(name).trim(), String(description).trim(), color, req.body.is_active, id, req.user?.tenant_id]
    );
    if (oldName !== String(name).trim()) {
      await client.query(
        'UPDATE expenses SET category = $1 WHERE tenant_id = $2 AND category = $3',
        [String(name).trim(), req.user?.tenant_id, oldName]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Expense category updated', category: updated.rows[0] });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A category with this name already exists.' });
    }
    console.error('Update expense category error:', error);
    res.status(500).json({ error: 'Failed to update expense category' });
  } finally {
    client.release();
  }
};

export const deleteExpenseCategory = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await beginTenantTransaction(client);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const existing = await client.query(
      'SELECT id, name FROM expense_categories WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, req.user?.tenant_id]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Expense category not found.' });
    }

    const usage = await client.query(
      'SELECT COUNT(*)::int AS count FROM expenses WHERE tenant_id = $1 AND (category = $2 OR category_id = $3)',
      [req.user?.tenant_id, existing.rows[0].name, id]
    );
    const hasHistory = Number(usage.rows[0].count) > 0;
    if (hasHistory) {
      await client.query(
        'UPDATE expense_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND tenant_id = $2',
        [id, req.user?.tenant_id]
      );
    } else {
      await client.query('DELETE FROM expense_categories WHERE id = $1 AND tenant_id = $2', [id, req.user?.tenant_id]);
    }
    await client.query('COMMIT');
    res.json({
      message: hasHistory
        ? 'Category archived to preserve existing expense history.'
        : 'Expense category deleted.',
      archived: hasHistory,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    console.error('Delete expense category error:', error);
    res.status(500).json({ error: 'Failed to delete expense category' });
  } finally {
    client.release();
  }
};

/**
 * Get expense statistics/summary
 */
export const getExpenseStatistics = async (req: AuthRequest, res: Response) => {
  try {
    const { from_date, to_date } = req.query;

    let dateFilter = '';
    const values: any[] = [];

    if (from_date && to_date) {
      dateFilter = 'WHERE expense_date BETWEEN $1 AND $2';
      values.push(from_date, to_date);
    } else {
      dateFilter = `WHERE DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE)`;
    }

    const totalResult = await query(
      `SELECT 
        COALESCE(SUM(amount), 0) as total_expenses,
        COUNT(*) as total_count
       FROM expenses 
       ${dateFilter} AND status = 'APPROVED'`,
      values
    );

    const categoryResult = await query(
      `SELECT 
        e.category,
        '#3B82F6' as color,
        COALESCE(SUM(e.amount), 0) as amount,
        COUNT(e.id) as count
       FROM expenses e
       WHERE e.status = 'APPROVED' 
         ${dateFilter.replace('WHERE', 'AND')}
       GROUP BY e.category
       HAVING COALESCE(SUM(e.amount), 0) > 0
       ORDER BY amount DESC`,
      values
    );

    const pendingResult = await query(
      `SELECT COUNT(*) as pending_count, COALESCE(SUM(amount), 0) as pending_amount
       FROM expenses 
       WHERE status = 'PENDING'`
    );

    res.json({
      total: totalResult.rows[0],
      byCategory: categoryResult.rows,
      pending: pendingResult.rows[0],
    });

  } catch (error) {
    console.error('Get expense statistics error:', error);
    res.status(500).json({ error: 'Failed to get expense statistics' });
  }
};
