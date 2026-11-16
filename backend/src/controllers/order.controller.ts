import { Response } from 'express';
import { validationResult } from 'express-validator';
import { query, getClient, beginTenantTransaction } from '../config/database';
import { isSystemAdminEmail } from '../utils/systemAdmin';
import { AuthRequest } from '../middleware/auth';
import { OrderStatus } from '../models/Order';
import { sendOrderDeliveredNotification, sendOrderReadyNotification, sendOrderReceipt } from '../services/sms.service';
import { sendOrderConfirmation } from '../services/whatsapp.service';
import { sendOrderReady } from '../services/whatsapp.service';
import { generateOrderReceiptPDF } from '../services/pdf.service';
import { logCreate, logUpdate, logDelete } from '../utils/activityLogger';
import { getMaxDiscountForRole } from '../utils/roleLimits';
import { resolveListBranchId, forbiddenIfOutsideBranch } from '../utils/branchScope';
import { notifyAdministrators } from './notifications.controller';
import { calendarDateToTimestamp, extractYmd, kampalaTodayYmd, toKampalaYmd, ymdToPgTimestamp } from '../utils/businessDate';
import fs from 'fs';
import ExcelJS from 'exceljs';

type SettingsQuerier = { query: (text: string) => Promise<any> };

function parseSettingJson(raw: any): any {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * VAT is charged only when URA compliance is switched on in Settings.
 * `ura_compliance_enabled` is what the Settings page writes; `vat_enabled` is
 * the older shape and is still honoured so existing installs keep working.
 */
export async function resolveVatConfig(
  db: SettingsQuerier
): Promise<{ enabled: boolean; rate: number }> {
  const result = await db.query(
    `SELECT setting_key, setting_value FROM business_settings
     WHERE setting_key IN ('ura_compliance_enabled', 'vat_enabled', 'vat_rate')
       AND tenant_id = app_current_tenant_id()`
  );

  const settings: Record<string, any> = {};
  result.rows.forEach((row: any) => {
    settings[row.setting_key] = parseSettingJson(row.setting_value);
  });

  const uraFlag = settings.ura_compliance_enabled;
  const uraEnabled = uraFlag === true || uraFlag === 'true';

  const legacy = settings.vat_enabled;
  const legacyEnabled = legacy?.enabled === true || legacy === true || legacy === 'true';

  const rate =
    parseFloat(String(settings.vat_rate ?? legacy?.rate ?? 18)) || 18;

  return { enabled: uraEnabled || legacyEnabled, rate };
}

export const getAllOrders = async (req: AuthRequest, res: Response) => {
  try {
    const { status, payment_status, customer_id, from_date, to_date, search, page = 1, limit = 15, is_backdated, historical, branch_id } = req.query;
    const userRole = req.user?.role;
    
    // Build WHERE clause
    let whereClause = 'WHERE 1=1';
    const values: any[] = [];
    let paramCount = 1;
    
    // BUSINESS RULE: Only ADMIN can see cancelled orders
    if (userRole !== 'ADMIN') {
      whereClause += ` AND o.status != 'cancelled'`;
    }

    // Search by order number, customer name, phone, or staff name
    if (search) {
      whereClause += ` AND (
        o.order_number ILIKE $${paramCount} OR 
        c.name ILIKE $${paramCount} OR 
        c.customer_id ILIKE $${paramCount} OR
        c.phone ILIKE $${paramCount} OR
        u.full_name ILIKE $${paramCount}
      )`;
      values.push(`%${search}%`);
      paramCount++;
    }
    
    if (status) {
      whereClause += ` AND o.status = $${paramCount++}`;
      values.push(status);
    }
    
    if (payment_status) {
      whereClause += ` AND o.payment_status = $${paramCount++}`;
      values.push(payment_status);
    }
    
    if (customer_id) {
      whereClause += ` AND o.customer_id = $${paramCount++}`;
      values.push(customer_id);
    }
    
    if (from_date) {
      whereClause += ` AND o.created_at >= $${paramCount++}`;
      values.push(from_date);
    }
    
    if (to_date) {
      whereClause += ` AND o.created_at <= $${paramCount++}`;
      values.push(to_date);
    }

    const listBranchId = resolveListBranchId(req, branch_id);
    if (listBranchId) {
      whereClause += ` AND o.branch_id = $${paramCount++}`;
      values.push(listBranchId);
    }

    const historicalFilterOn = ['true', '1', 'yes'].includes(
      String(historical ?? is_backdated ?? '').toLowerCase()
    );
    if (historicalFilterOn) {
      whereClause += ` AND COALESCE(o.is_backdated, FALSE) = TRUE`;
    }
    
    // Get total count
    const countSql = `
      SELECT COUNT(*) 
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN users u ON o.user_id = u.id
      ${whereClause}
    `;
    const countResult = await query(countSql, values);
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated orders
    const offset = (Number(page) - 1) * Number(limit);
    values.push(Number(limit));
    values.push(offset);
    
    const sql = `
      SELECT o.id, o.order_number, o.customer_id, o.user_id,
        o.status as order_status,
        o.payment_status, o.payment_method, o.subtotal, o.discount,
        o.tax, o.total, o.notes, o.created_at, o.updated_at,
        o.amount_paid, o.total_amount, o.balance, o.due_date, o.pickup_date,
        o.transaction_reference, o.invoice_number,
        o.discount_percentage, o.discount_amount, o.bargain_amount,
        COALESCE(o.surcharge_amount, 0) as surcharge_amount,
        o.tax_rate, o.tax_amount,
        COALESCE(o.is_backdated, FALSE) as is_backdated,
        o.recorded_at,
        c.name as customer_name,
        c.phone as customer_phone,
        u.full_name as staff_name,
        u.role as user_role,
        u.email as staff_email,
        u.status as staff_status,
        o.branch_id,
        b.name as branch_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN users u ON o.user_id = u.id
      LEFT JOIN branches b ON b.id = o.branch_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${paramCount++} OFFSET $${paramCount++}
    `;
    
    const result = await query(sql, values);
    
    const orders = result.rows.map(({ staff_email, ...order }: any) => ({
      ...order,
      user_role: isSystemAdminEmail(staff_email) ? null : order.user_role,
    }));

    res.json({
      orders,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit))
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
};

export const exportOrdersXlsx = async (req: AuthRequest, res: Response) => {
  try {
    const { from_date, to_date, branch_id, status, payment_status, search, historical } = req.query;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const fromDate = from_date ? String(from_date) : '';
    const toDate = to_date ? String(to_date) : '';
    if ((fromDate && !datePattern.test(fromDate)) || (toDate && !datePattern.test(toDate))) {
      return res.status(400).json({ error: 'Use valid YYYY-MM-DD dates for the export range.' });
    }
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    }

    const conditions = ['o.tenant_id = app_current_tenant_id()'];
    const values: any[] = [];
    const add = (value: any) => { values.push(value); return `$${values.length}`; };
    if (req.user?.role !== 'ADMIN') conditions.push("o.status <> 'cancelled'");
    if (['true', '1', 'yes'].includes(String(historical || '').toLowerCase())) conditions.push('COALESCE(o.is_backdated, FALSE) = TRUE');
    if (status && status !== 'ALL') conditions.push(`o.status = ${add(status)}`);
    if (payment_status && payment_status !== 'ALL') conditions.push(`o.payment_status = ${add(payment_status)}`);
    if (fromDate) conditions.push(`o.created_at >= ${add(fromDate)}::date`);
    if (toDate) conditions.push(`o.created_at < (${add(toDate)}::date + INTERVAL '1 day')`);
    const branchId = resolveListBranchId(req, branch_id);
    if (branchId !== null) conditions.push(`o.branch_id = ${add(branchId)}`);
    if (search && String(search).trim()) {
      const term = add(`%${String(search).trim()}%`);
      conditions.push(`(o.order_number ILIKE ${term} OR c.name ILIKE ${term} OR c.phone ILIKE ${term} OR c.customer_id ILIKE ${term})`);
    }
    const where = conditions.join(' AND ');

    const ordersResult = await query(
      `SELECT o.id,o.order_number,o.invoice_number,o.created_at,o.due_date,o.pickup_date,
              o.status::text AS order_status,o.payment_status::text AS payment_status,
              o.payment_method,o.subtotal,o.discount_percentage,o.discount_amount,o.bargain_amount,
              COALESCE(o.surcharge_amount,0) AS surcharge_amount,o.tax_rate,o.tax_amount,
              o.total_amount,o.amount_paid,o.balance,o.transaction_reference,o.notes,
              o.catalogue_kg,c.customer_id,c.name AS customer_name,c.phone AS customer_phone,
              c.email AS customer_email,c.location AS customer_location,u.full_name AS recorded_by,
              b.name AS branch_name
       FROM public.orders o
       JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
       JOIN public.users u ON u.id=o.user_id AND u.tenant_id=o.tenant_id
       LEFT JOIN public.branches b ON b.id=o.branch_id AND b.tenant_id=o.tenant_id
       WHERE ${where}
       ORDER BY o.created_at DESC,o.id DESC`,
      values
    );
    const orderIds = ordersResult.rows.map((row: any) => Number(row.id));
    let itemRows: any[] = [];
    if (orderIds.length) {
      const itemResult = await query(
        `SELECT oi.order_id,o.order_number,o.invoice_number,o.created_at,b.name AS branch_name,
                c.customer_id,c.name AS customer_name,c.phone AS customer_phone,
                p.item_id,p.name AS item_name,p.category,oi.service_type,oi.quantity,oi.unit_price,
                oi.discount_amount,oi.surcharge_amount,oi.total_price,oi.notes
         FROM public.order_items oi
         JOIN public.orders o ON o.id=oi.order_id AND o.tenant_id=app_current_tenant_id()
         JOIN public.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
         LEFT JOIN public.branches b ON b.id=o.branch_id AND b.tenant_id=o.tenant_id
         LEFT JOIN public.price_items p ON p.id=oi.price_item_id AND p.tenant_id=o.tenant_id
         WHERE oi.order_id=ANY($1::int[])
         ORDER BY o.created_at DESC,o.id DESC,oi.id ASC`,
        [orderIds]
      );
      itemRows = itemResult.rows;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Soth Dry Cleaners';
    workbook.created = new Date();
    workbook.modified = new Date();
    const headerStyle = (sheet: ExcelJS.Worksheet) => {
      const header = sheet.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153B64' } };
      header.alignment = { vertical: 'middle', wrapText: true };
      header.height = 30;
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      const columnLetter = (columnNumber: number) => {
        let number = columnNumber;
        let letters = '';
        while (number > 0) {
          const remainder = (number - 1) % 26;
          letters = String.fromCharCode(65 + remainder) + letters;
          number = Math.floor((number - 1) / 26);
        }
        return letters;
      };
      sheet.autoFilter = { from: 'A1', to: `${columnLetter(sheet.columnCount)}1` };
    };
    const ordersSheet = workbook.addWorksheet('Orders');
    ordersSheet.columns = [
      { header: 'Order ID', key: 'id', width: 12 }, { header: 'Order Number', key: 'order_number', width: 20 },
      { header: 'Invoice Number', key: 'invoice_number', width: 20 }, { header: 'Order Date', key: 'created_at', width: 22 },
      { header: 'Branch', key: 'branch_name', width: 22 }, { header: 'Customer ID', key: 'customer_id', width: 18 },
      { header: 'Customer', key: 'customer_name', width: 28 }, { header: 'Phone', key: 'customer_phone', width: 18 },
      { header: 'Email', key: 'customer_email', width: 30 }, { header: 'Location', key: 'customer_location', width: 24 },
      { header: 'Recorded By', key: 'recorded_by', width: 24 }, { header: 'Order Status', key: 'order_status', width: 16 },
      { header: 'Payment Status', key: 'payment_status', width: 17 }, { header: 'Payment Method', key: 'payment_method', width: 20 },
      { header: 'Subtotal (UGX)', key: 'subtotal', width: 18 }, { header: 'Order Discount %', key: 'discount_percentage', width: 18 },
      { header: 'Order Discount (UGX)', key: 'discount_amount', width: 22 }, { header: 'Bargain (UGX)', key: 'bargain_amount', width: 18 },
      { header: 'Surcharge (UGX)', key: 'surcharge_amount', width: 18 }, { header: 'VAT %', key: 'tax_rate', width: 12 },
      { header: 'VAT (UGX)', key: 'tax_amount', width: 16 }, { header: 'Total (UGX)', key: 'total_amount', width: 18 },
      { header: 'Amount Paid (UGX)', key: 'amount_paid', width: 20 }, { header: 'Balance (UGX)', key: 'balance', width: 18 },
      { header: 'Due Date', key: 'due_date', width: 18 }, { header: 'Pickup Date', key: 'pickup_date', width: 18 },
      { header: 'Transaction Reference', key: 'transaction_reference', width: 25 }, { header: 'Order Notes', key: 'notes', width: 38 },
      { header: 'Bulk Laundry (kg)', key: 'catalogue_kg', width: 18 },
    ];
    ordersResult.rows.forEach((row: any) => ordersSheet.addRow(row));
    headerStyle(ordersSheet);
    ['subtotal','discount_amount','bargain_amount','surcharge_amount','tax_amount','total_amount','amount_paid','balance'].forEach((key) => {
      ordersSheet.getColumn(key).numFmt = '#,##0;[Red]-#,##0';
    });
    ordersSheet.getColumn('created_at').numFmt = 'yyyy-mm-dd hh:mm';

    const itemsSheet = workbook.addWorksheet('Order Items');
    itemsSheet.columns = [
      { header: 'Order Number', key: 'order_number', width: 20 }, { header: 'Invoice Number', key: 'invoice_number', width: 20 },
      { header: 'Order Date', key: 'created_at', width: 22 }, { header: 'Branch', key: 'branch_name', width: 22 },
      { header: 'Customer ID', key: 'customer_id', width: 18 }, { header: 'Customer', key: 'customer_name', width: 28 },
      { header: 'Phone', key: 'customer_phone', width: 18 }, { header: 'Item ID', key: 'item_id', width: 16 },
      { header: 'Item', key: 'item_name', width: 28 }, { header: 'Category', key: 'category', width: 18 },
      { header: 'Service', key: 'service_type', width: 18 }, { header: 'Quantity', key: 'quantity', width: 12 },
      { header: 'Unit Price (UGX)', key: 'unit_price', width: 18 }, { header: 'Discount (UGX)', key: 'discount_amount', width: 18 },
      { header: 'Surcharge (UGX)', key: 'surcharge_amount', width: 18 }, { header: 'Line Total (UGX)', key: 'total_price', width: 18 },
      { header: 'Item Notes', key: 'notes', width: 40 },
    ];
    itemRows.forEach((row: any) => itemsSheet.addRow(row));
    headerStyle(itemsSheet);
    ['unit_price','discount_amount','surcharge_amount','total_price'].forEach((key) => {
      itemsSheet.getColumn(key).numFmt = '#,##0;[Red]-#,##0';
    });
    itemsSheet.getColumn('created_at').numFmt = 'yyyy-mm-dd hh:mm';

    const customerMap = new Map<string, any>();
    ordersResult.rows.forEach((row: any) => {
      const key = String(row.customer_id);
      const current = customerMap.get(key) || {
        customer_id: row.customer_id, customer_name: row.customer_name, phone: row.customer_phone,
        email: row.customer_email, location: row.customer_location, order_count: 0, total_spend: 0,
      };
      current.order_count += 1;
      current.total_spend += Number(row.total_amount || 0);
      customerMap.set(key, current);
    });
    const customersSheet = workbook.addWorksheet('Customers');
    customersSheet.columns = [
      { header: 'Customer ID', key: 'customer_id', width: 18 }, { header: 'Customer', key: 'customer_name', width: 28 },
      { header: 'Phone', key: 'phone', width: 18 }, { header: 'Email', key: 'email', width: 30 },
      { header: 'Location', key: 'location', width: 24 }, { header: 'Orders in Export', key: 'order_count', width: 18 },
      { header: 'Total Orders (UGX)', key: 'total_spend', width: 22 },
    ];
    customerMap.forEach((row) => customersSheet.addRow(row));
    headerStyle(customersSheet);
    customersSheet.getColumn('total_spend').numFmt = '#,##0;[Red]-#,##0';

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const fromLabel = fromDate || 'all-time';
    const toLabel = toDate ? `-to-${toDate}` : '';
    const fileName = `soth-orders-${fromLabel}${toLabel}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    console.error('Export orders XLSX error:', error);
    return res.status(500).json({ error: 'Unable to export orders. Please narrow the date range and try again.' });
  }
};

export const getOrderById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get order with customer and staff info
    const orderResult = await query(
      `SELECT o.id, o.order_number, o.customer_id, o.user_id,
        o.status as order_status,
        o.payment_status, o.payment_method, o.subtotal, o.discount,
        o.tax, o.total, o.notes, o.created_at, o.updated_at,
        o.amount_paid, o.total_amount, o.balance, o.due_date, o.pickup_date,
        o.transaction_reference, o.invoice_number,
        o.discount_percentage, o.discount_amount, o.bargain_amount,
        COALESCE(o.surcharge_amount, 0) as surcharge_amount,
        o.tax_rate, o.tax_amount,
        COALESCE(o.is_backdated, FALSE) as is_backdated,
        o.recorded_at,
        c.name as customer_name, 
        c.phone as customer_phone,
        c.email as customer_email,
        c.location as customer_location,
        u.full_name as staff_name,
        o.branch_id,
        b.name as branch_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN users u ON o.user_id = u.id
      LEFT JOIN branches b ON b.id = o.branch_id
      WHERE o.id = $1`,
      [id]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (forbiddenIfOutsideBranch(req, res, orderResult.rows[0].branch_id)) {
      return;
    }

    // Get order items
    const itemsResult = await query(
      `SELECT oi.*, p.name as item_name, p.category, p.item_id,
        os.status as operations_status
      FROM order_items oi
      JOIN price_items p ON oi.price_item_id = p.id AND p.tenant_id = oi.tenant_id
      LEFT JOIN public.operations_item_status os ON os.order_item_id = oi.id AND os.tenant_id = oi.tenant_id
      WHERE oi.order_id = $1 AND oi.tenant_id = app_current_tenant_id()
      ORDER BY oi.id`,
      [id]
    );
    
    res.json({
      order: orderResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
};

/**
 * Reconcile an order's item lines while preserving payment ledger entries.
 * Prices are always recalculated from this tenant's active price catalogue.
 */
export const updateOrderItems = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  const orderId = Number(req.params.id);
  const requestedItems = req.body?.items;
  const isAdmin = req.user?.role === 'ADMIN';
  const rejectInvalid = (message: string): never => {
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  };

  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    client.release();
    return res.status(400).json({ error: 'A valid order ID is required' });
  }
  if (!Array.isArray(requestedItems) || requestedItems.length < 1 || requestedItems.length > 500) {
    client.release();
    return res.status(400).json({ error: 'Keep at least one order item. A maximum of 500 items is allowed.' });
  }

  try {
    await beginTenantTransaction(client);
    const orderResult = await client.query(
      `SELECT * FROM public.orders WHERE id=$1 AND tenant_id=app_current_tenant_id() FOR UPDATE`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (forbiddenIfOutsideBranch(req, res, order.branch_id)) {
      await client.query('ROLLBACK');
      return;
    }

    const orderStatus = String(order.status || '').toUpperCase();
    if (!isAdmin && !['PENDING', 'RECEIVED', 'PROCESSING'].includes(orderStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Items can only be edited before the order is marked Ready. Administrators can override this restriction.' });
    }

    const existingResult = await client.query(
      `SELECT oi.*, os.status operations_status
       FROM public.order_items oi
       LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
       WHERE oi.order_id=$1 AND oi.tenant_id=app_current_tenant_id()
       FOR UPDATE OF oi`,
      [orderId]
    );
    const existingById = new Map<number, any>(existingResult.rows.map((row: any) => [Number(row.id), row]));
    const submittedIds = requestedItems
      .filter((item: any) => item.id !== undefined && item.id !== null && Number(item.id) > 0)
      .map((item: any) => Number(item.id));
    if (new Set(submittedIds).size !== submittedIds.length || submittedIds.some((itemId: number) => !existingById.has(itemId))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The submitted items do not match this order.' });
    }

    const submittedIdSet = new Set(submittedIds);
    const removedRows = existingResult.rows.filter((row: any) => !submittedIdSet.has(Number(row.id)));
    if (!isAdmin && removedRows.some((row: any) => String(row.operations_status || 'RECEIVED').toUpperCase() === 'READY')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An item already marked Ready cannot be removed by staff. Ask an administrator to make this correction.' });
    }
    for (const item of requestedItems) {
      const existing = item.id ? existingById.get(Number(item.id)) : null;
      if (existing && !isAdmin && String(existing.operations_status || 'RECEIVED').toUpperCase() === 'READY') {
        const incomingService = String(item.service_type || '').toUpperCase();
        const changed = Number(item.price_item_id) !== Number(existing.price_item_id)
          || incomingService !== String(existing.service_type || '').toUpperCase()
          || Number(item.quantity) !== Number(existing.quantity);
        if (changed) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'An item already marked Ready cannot be edited by staff. Ask an administrator to make this correction.' });
        }
      }
    }

    if (removedRows.length) {
      await client.query(
        `DELETE FROM public.order_items WHERE order_id=$1 AND tenant_id=app_current_tenant_id() AND id=ANY($2::int[])`,
        [orderId, removedRows.map((row: any) => Number(row.id))]
      );
    }

    const standardKgRateResult = await client.query(
      `SELECT setting_value FROM public.business_settings
       WHERE tenant_id=app_current_tenant_id() AND setting_key IN ('standard_kg_rate','kilogram_rate')
       ORDER BY setting_key='standard_kg_rate' DESC LIMIT 1`
    );
    let standardKgRate = 10000;
    if (standardKgRateResult.rows[0]?.setting_value !== undefined) {
      const configured = Number(parseSettingJson(standardKgRateResult.rows[0].setting_value));
      if (Number.isFinite(configured) && configured > 0) standardKgRate = configured;
    }

    for (const item of requestedItems) {
      const priceItemId = Number(item.price_item_id);
      const serviceType = String(item.service_type || 'WASH').toUpperCase();
      const quantity = Number(item.quantity);
      const existing = item.id ? existingById.get(Number(item.id)) : null;
      if (!Number.isSafeInteger(priceItemId) || priceItemId < 1) rejectInvalid('Choose an item from the price list.');
      if (!['WASH', 'IRON', 'EXPRESS'].includes(serviceType)) rejectInvalid('Choose Wash, Iron, or Express for every item.');
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) rejectInvalid('Item quantity must be greater than zero and no more than 10,000.');

      const isUnchanged = existing
        && Number(existing.price_item_id) === priceItemId
        && String(existing.service_type || '').toUpperCase() === serviceType
        && Number(existing.quantity) === quantity;
      if (isUnchanged) continue;

      const priceResult = await client.query(
        `SELECT id,name,category,item_id,unit,COALESCE(pricing_type,'FIXED') pricing_type,
          COALESCE(price_per_kg,0) price_per_kg,price,ironing_price,express_price,
          discount_percentage,discount_start_date,discount_end_date,is_active,
          CASE WHEN discount_percentage>0 AND discount_start_date<=NOW() AND discount_end_date>=NOW()
            THEN ROUND(price*(1-discount_percentage/100)) ELSE price END effective_price,
          CASE WHEN discount_percentage>0 AND discount_start_date<=NOW() AND discount_end_date>=NOW()
            THEN ROUND(ironing_price*(1-discount_percentage/100)) ELSE ironing_price END effective_ironing_price,
          CASE WHEN express_price IS NOT NULL THEN express_price
            WHEN discount_percentage>0 AND discount_start_date<=NOW() AND discount_end_date>=NOW()
            THEN ROUND(price*(1-discount_percentage/100))*2 ELSE price*2 END effective_express_price
         FROM public.price_items
         WHERE id=$1 AND tenant_id=app_current_tenant_id()`,
        [priceItemId]
      );
      const priceItem = priceResult.rows[0];
      if (!priceItem || !priceItem.is_active) rejectInvalid('This item is no longer active in the price list. Choose an active item.');

      const isPerKg = String(priceItem.pricing_type).toUpperCase() === 'PER_KG' || String(priceItem.unit || '').toLowerCase() === 'kg';
      if (!isPerKg && !Number.isInteger(quantity)) rejectInvalid(`${priceItem.name} requires a whole-number quantity.`);
      if (isPerKg && Math.round(quantity * 10) / 10 !== quantity) rejectInvalid(`${priceItem.name} quantity can use up to one decimal place.`);
      let unitPrice: number;
      if (isPerKg) {
        const baseRate = Number(priceItem.price_per_kg) > 0
          ? Number(priceItem.price_per_kg)
          : Number(priceItem.effective_price) || standardKgRate;
        unitPrice = serviceType === 'EXPRESS' ? baseRate * 2 : baseRate;
      } else if (serviceType === 'WASH') unitPrice = Number(priceItem.effective_price);
      else if (serviceType === 'IRON') unitPrice = Number(priceItem.effective_ironing_price);
      else unitPrice = Number(priceItem.effective_express_price);

      const grossTotal = Math.round(quantity * unitPrice);
      const discountAmount = Math.min(grossTotal, Math.max(0, Math.round(Number(existing?.discount_amount) || 0)));
      const surchargeAmount = Math.max(0, Math.round(Number(existing?.surcharge_amount) || 0));
      const totalPrice = Math.max(0, grossTotal + surchargeAmount - discountAmount);
      const notes = typeof item.notes === 'string' ? item.notes.trim().slice(0, 200) || null : existing?.notes || null;
      const expressDueAt = serviceType === 'EXPRESS' ? existing?.express_due_at || null : null;

      if (existing) {
        await client.query(
          `UPDATE public.order_items SET price_item_id=$3,item_name=$4,service_type=$5,quantity=$6,
            unit_price=$7,discount_amount=$8,surcharge_amount=$9,total_price=$10,notes=$11,
            express_due_at=$12,updated_at=NOW()
           WHERE id=$1 AND order_id=$2 AND tenant_id=app_current_tenant_id()`,
          [existing.id,orderId,priceItemId,priceItem.name,serviceType,quantity,unitPrice,discountAmount,surchargeAmount,totalPrice,notes,expressDueAt]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO public.order_items(order_id,price_item_id,item_name,service_type,quantity,unit_price,discount_amount,surcharge_amount,total_price,notes,express_due_at)
           VALUES($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9) RETURNING id`,
          [orderId,priceItemId,priceItem.name,serviceType,quantity,unitPrice,totalPrice,notes,expressDueAt]
        );
        const newItemId = Number(inserted.rows[0].id);
        const initialOperationsStatus = ['READY','DELIVERED'].includes(orderStatus)
          ? 'READY'
          : orderStatus === 'PROCESSING' ? 'PROCESSING' : 'RECEIVED';
        await client.query(
          `INSERT INTO public.operations_item_status(tenant_id,order_id,order_item_id,status,ready_at,updated_by,updated_at)
           SELECT app_current_tenant_id(),$1,$2,$3,CASE WHEN $3='READY' THEN NOW() ELSE NULL END,$4,NOW()
           ON CONFLICT(tenant_id,order_item_id) DO UPDATE SET status=EXCLUDED.status,ready_at=EXCLUDED.ready_at,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
          [orderId,newItemId,initialOperationsStatus,req.user!.id]
        );
      }
    }

    const subtotalResult = await client.query(
      `SELECT COALESCE(SUM(total_price),0)::numeric subtotal FROM public.order_items
       WHERE order_id=$1 AND tenant_id=app_current_tenant_id()`, [orderId]
    );
    const subtotal = Math.max(0, Math.round(Number(subtotalResult.rows[0]?.subtotal) || 0));
    const percentage = Math.max(0, Number(order.discount_percentage) || 0);
    const orderDiscount = percentage > 0
      ? Math.round(subtotal * percentage / 100)
      : Math.min(subtotal, Math.max(0, Math.round(Number(order.discount_amount) || 0)));
    const bargain = Math.min(Math.max(0, subtotal - orderDiscount), Math.max(0, Math.round(Number(order.bargain_amount) || 0)));
    const surcharge = Math.max(0, Math.round(Number(order.surcharge_amount) || 0));
    const taxRate = Math.max(0, Number(order.tax_rate) || 0);
    const taxable = Math.max(0, subtotal - orderDiscount - bargain + surcharge);
    const taxAmount = taxRate > 0 ? Math.round(taxable * taxRate / 100) : 0;
    const totalAmount = Math.max(0, subtotal - orderDiscount - bargain + surcharge + taxAmount);
    const amountPaid = Math.max(0, Number(order.amount_paid) || 0);
    const paymentStatus = amountPaid <= 0 ? 'UNPAID' : amountPaid >= totalAmount ? 'PAID' : 'PARTIAL';
    const balance = Math.max(0, totalAmount - amountPaid);

    await client.query(
      `UPDATE public.orders SET subtotal=$2,discount_amount=$3,bargain_amount=$4,tax_amount=$5,
        total_amount=$6,balance=$7,payment_status=$8,updated_at=NOW()
       WHERE id=$1 AND tenant_id=app_current_tenant_id()`,
      [orderId,subtotal,orderDiscount,bargain,taxAmount,totalAmount,balance,paymentStatus]
    );

    if (!['DELIVERED','CANCELLED'].includes(orderStatus)) {
      const statusCounts = await client.query(
        `SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE os.status='READY')::int ready
         FROM public.order_items oi LEFT JOIN public.operations_item_status os
          ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
         WHERE oi.order_id=$1 AND oi.tenant_id=app_current_tenant_id()`, [orderId]
      );
      const allReady = Number(statusCounts.rows[0]?.total) > 0 && Number(statusCounts.rows[0]?.total) === Number(statusCounts.rows[0]?.ready);
      if (allReady && orderStatus !== 'READY') {
        await client.query("SELECT set_config('app.operations_status_update','true',true)");
        await client.query("UPDATE public.orders SET status='READY' WHERE id=$1 AND tenant_id=app_current_tenant_id()", [orderId]);
      }
    }

    const updatedOrder = await client.query('SELECT * FROM public.orders WHERE id=$1 AND tenant_id=app_current_tenant_id()', [orderId]);
    const updatedItems = await client.query(
      `SELECT oi.*,p.name item_name,p.category,p.item_id,os.status operations_status
       FROM public.order_items oi JOIN public.price_items p ON p.id=oi.price_item_id AND p.tenant_id=oi.tenant_id
       LEFT JOIN public.operations_item_status os ON os.order_item_id=oi.id AND os.tenant_id=oi.tenant_id
       WHERE oi.order_id=$1 AND oi.tenant_id=app_current_tenant_id() ORDER BY oi.id`, [orderId]
    );
    await client.query('COMMIT');

    await logUpdate(req.user!.id,req.user!.email,req.user!.full_name,req.user!.role,'order',orderId,{
      action:'order_items_updated', previous_item_count:existingResult.rows.length, item_count:updatedItems.rows.length,
      previous_total:order.total_amount, total_amount:updatedOrder.rows[0].total_amount,
    },req.ip);
    res.json({ message:'Order items updated successfully', order:updatedOrder.rows[0], items:updatedItems.rows });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Update order items error:', error);
    res.status(error?.statusCode || 500).json({ error:error?.statusCode ? error.message : 'Failed to update order items' });
  } finally {
    client.release();
  }
};

export const createOrder = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    await beginTenantTransaction(client);

    const idempotencyKey = req.get('Idempotency-Key')?.trim() || null;
    if (idempotencyKey) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid Idempotency-Key' });
      }

      // Serialize requests with the same tenant, user, and key. The unique
      // index below remains the database-level backstop if another code path
      // ever writes the same key without taking this lock.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
          'create-order:' || app_current_tenant_id()::text || ':' || $1::text || ':' || $2,
          0
        ))`,
        [req.user!.id, idempotencyKey]
      );

      const existingOrder = await client.query(
        `SELECT * FROM orders
         WHERE tenant_id = app_current_tenant_id()
           AND user_id = $1
           AND idempotency_key = $2
         LIMIT 1`,
        [req.user!.id, idempotencyKey]
      );
      if (existingOrder.rows.length > 0) {
        await client.query('COMMIT');
        return res.status(200).json({
          message: 'Order was already created for this request',
          order: existingOrder.rows[0],
          duplicate_request: true,
        });
      }
    }
    
    const { 
      customer_id, 
      items, 
      discount_percentage = 0,
      bargain_amount = 0,
      order_discount_mode,
      surcharge_amount = 0,
      surcharge_mode = 'amount',
      surcharge_percent = 0,
      payment_status = 'UNPAID',
      payment_method = 'CASH',
      amount_paid = 0,
      transaction_reference,
      historical_payment = false,
      pickup_date, 
      notes,
      branch_id: requestedBranchId,
      tax_rate: frontendTaxRate,
      tax_amount: frontendTaxAmount,
      order_date,          // optional back-date
      payment_date: requestedCreatePaymentDate,
      catalogue_kg,
    } = req.body;

    // Past-date (historical) orders only. Same-day orders stay unmarked even if
    // the backdate checkbox is left on with today's date.
    let customOrderDate: string | null = null;
    let isBackdated = false;
    if (order_date) {
      const parsed = calendarDateToTimestamp(order_date);
      if (parsed && toKampalaYmd(parsed) < kampalaTodayYmd()) {
        customOrderDate = parsed.toISOString();
        isBackdated = true;
      }
    }

    // Branch: staff always book against their own branch; only ADMIN/MANAGER may
    // choose another one, and it must be an active branch.
    const canChooseBranch = req.user!.role === 'ADMIN' || req.user!.role === 'MANAGER';
    let branchId: number | null =
      canChooseBranch && requestedBranchId
        ? Number(requestedBranchId)
        : req.user!.branch_id ?? null;

    if (branchId) {
      const branchCheck = await client.query(
        'SELECT id FROM branches WHERE id = $1 AND is_active = TRUE',
        [branchId]
      );
      if (branchCheck.rows.length === 0) {
        throw new Error('Selected branch is not available');
      }
    } else {
      const defaultBranch = await client.query(
        'SELECT id FROM branches WHERE is_active = TRUE ORDER BY is_default DESC, id ASC LIMIT 1'
      );
      branchId = defaultBranch.rows[0]?.id ?? null;
    }
    
    // ================================================================
    // SECURITY: ALL FINANCIAL CALCULATIONS DONE ON BACKEND
    // NEVER TRUST FRONTEND VALUES FOR MONEY
    // ================================================================
    
    // 1. Calculate subtotal from order items (verify each item price from database)
    let calculatedSubtotal = 0;
    let totalItemDiscount = 0;
    const validatedItems: any[] = [];
    
    const catalogueWeight = Number(catalogue_kg || 0);
    const catalogueMode = catalogueWeight > 0;
    const catalogueRateResult = catalogueMode
      ? await client.query(
        `SELECT setting_value FROM business_settings WHERE setting_key IN ('standard_kg_rate', 'kilogram_rate') AND tenant_id = app_current_tenant_id() ORDER BY setting_key = 'standard_kg_rate' DESC LIMIT 1`
      )
      : { rows: [] };
    const catalogueRate = catalogueMode
      ? Number(parseSettingJson(catalogueRateResult.rows[0]?.setting_value) || 10000) || 10000
      : 0;
    const catalogueTotal = Math.round(catalogueWeight * catalogueRate);
    const catalogueUnits = items.reduce((sum: number, entry: any) => sum + Math.max(1, Math.round(Number(entry.quantity) || 1)), 0);
    let catalogueAllocated = 0;

    const discountSetting = await client.query(
      `SELECT setting_value FROM business_settings WHERE setting_key = 'discount_limits' AND tenant_id = app_current_tenant_id()`
    );
    let configuredDiscountLimits: Record<string, unknown> = {};
    if (discountSetting.rows[0]?.setting_value) {
      try {
        configuredDiscountLimits = JSON.parse(discountSetting.rows[0].setting_value);
      } catch {
        configuredDiscountLimits = {};
      }
    }
    const roleKey = req.user!.role === 'DESKTOP_AGENT' ? 'desktop_agent'
      : req.user!.role === 'MANAGER' ? 'manager' : 'admin';
    const defaultItemDiscountPercent = 100;
    const fullItemAmountAllowed = configuredDiscountLimits[roleKey + '_full_item_amount'] !== false;
    const fullOrderAmountAllowed = configuredDiscountLimits[roleKey + '_full_order_amount'] !== false;
    const configuredItemDiscountMode = ['percent', 'amount', 'both'].includes(String(configuredDiscountLimits.item_discount_mode))
      ? String(configuredDiscountLimits.item_discount_mode)
      : 'both';
    const configuredOrderDiscountMode = ['percent', 'amount', 'both'].includes(String(configuredDiscountLimits.order_discount_mode))
      ? String(configuredDiscountLimits.order_discount_mode)
      : 'both';
    const configuredItemDiscountPercent = configuredItemDiscountMode !== 'amount'
      ? Number(configuredDiscountLimits[roleKey + '_item'])
      : 100;
    const maxItemDiscountPercent = Number.isFinite(configuredItemDiscountPercent) && configuredItemDiscountPercent >= 0 && configuredItemDiscountPercent <= 100
      ? configuredItemDiscountPercent
      : defaultItemDiscountPercent;

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      const requestedPricingMode = item.pricing_mode === 'catalogue_kg'
        ? 'catalogue_kg'
        : item.pricing_mode === 'kg' ? 'kg' : 'piece';
      const requestedKgRate = Number(item.kg_rate ?? 0);
      const standardKgRateResult = await client.query(
        `SELECT setting_value FROM business_settings WHERE setting_key IN ('standard_kg_rate', 'kilogram_rate') AND tenant_id = app_current_tenant_id() ORDER BY setting_key = 'standard_kg_rate' DESC LIMIT 1`
      );
      const standardKgRate = Number(
        standardKgRateResult.rows[0]?.setting_value && !Number.isNaN(Number(JSON.parse(standardKgRateResult.rows[0].setting_value)))
          ? JSON.parse(standardKgRateResult.rows[0].setting_value)
          : 10000
      ) || 10000;

      // Fetch actual price from database (prevent price manipulation)
      const priceResult = await client.query(
        `SELECT id, name, unit,
         COALESCE(pricing_type, 'FIXED') as pricing_type,
         COALESCE(price_per_kg, 0) as price_per_kg,
         price, ironing_price, express_price,
         discount_percentage, discount_start_date, discount_end_date,
         CASE 
           WHEN discount_percentage > 0 
                AND discount_start_date <= NOW() 
                AND discount_end_date >= NOW()
           THEN ROUND(price * (1 - discount_percentage / 100))
           ELSE price
         END as effective_price,
         CASE 
           WHEN discount_percentage > 0 
                AND discount_start_date <= NOW() 
                AND discount_end_date >= NOW()
           THEN ROUND(ironing_price * (1 - discount_percentage / 100))
           ELSE ironing_price
         END as effective_ironing_price,
         CASE 
           WHEN express_price IS NOT NULL THEN express_price
           WHEN discount_percentage > 0 
                AND discount_start_date <= NOW() 
                AND discount_end_date >= NOW()
           THEN ROUND(price * (1 - discount_percentage / 100)) * 2
           ELSE price * 2
         END as effective_express_price
         FROM price_items 
         WHERE id = $1`,
        [item.price_item_id]
      );
      
      if (priceResult.rows.length === 0) {
        throw new Error(`Invalid price item ID: ${item.price_item_id}`);
      }
      
      const priceItem = priceResult.rows[0];
      const serviceType = item.service_type?.toUpperCase(); // Normalize to uppercase
      const quantity = Number(item.quantity);
      let expressDueAt: Date | null = null;
      if (serviceType === 'EXPRESS' && item.express_due_at) {
        const parsedExpressDueAt = new Date(item.express_due_at);
        if (!Number.isFinite(parsedExpressDueAt.getTime()) || parsedExpressDueAt.getTime() <= Date.now()) {
          throw new Error('An Express needed-by time must be in the future');
        }
        expressDueAt = parsedExpressDueAt;
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for item ID ${item.price_item_id}`);
      }

      const isPerKg = requestedPricingMode === 'kg' || priceItem.pricing_type === 'PER_KG' || priceItem.unit === 'kg';
      const isCatalogueLine = catalogueMode && requestedPricingMode === 'catalogue_kg';
      if (isCatalogueLine && !Number.isInteger(quantity)) {
        throw new Error(`${priceItem.name} must use a whole number quantity in catalogue kg mode`);
      }
      if (!isPerKg && !Number.isInteger(quantity)) {
        throw new Error(`${priceItem.name} must use a whole number quantity`);
      }
      
      let actualUnitPrice = 0;
      if (isCatalogueLine) {
        const lineUnits = Math.max(1, Math.round(quantity));
        const lineGross = itemIndex === items.length - 1
          ? catalogueTotal - catalogueAllocated
          : Math.round(catalogueTotal * lineUnits / catalogueUnits);
        catalogueAllocated += lineGross;
        actualUnitPrice = Math.round(lineGross / lineUnits);
      } else if (isPerKg) {
        // Manual kg entry uses the configured standard rate unless this item has an item-specific kg rate.
        const baseKgRate = requestedKgRate > 0
          ? requestedKgRate
          : (Number(priceItem.price_per_kg) > 0 ? Number(priceItem.price_per_kg) : Number(priceItem.effective_price) || standardKgRate);
        if (serviceType === 'EXPRESS') {
          actualUnitPrice = baseKgRate * 2;
        } else {
          actualUnitPrice = baseKgRate;
        }
      } else if (serviceType === 'WASH') {
        actualUnitPrice = priceItem.effective_price;
      } else if (serviceType === 'IRON') {
        actualUnitPrice = priceItem.effective_ironing_price;
      } else if (serviceType === 'EXPRESS') {
        actualUnitPrice = priceItem.effective_express_price;
      } else {
        throw new Error(`Invalid service type: ${item.service_type}`);
      }
      
      // PER_KG quantities round to nearest 0.1kg; FIXED quantities must be whole
      const normalizedQuantity = isPerKg ? Math.round(quantity * 10) / 10 : quantity;
      const grossItemTotal = Math.round(normalizedQuantity * actualUnitPrice);

      // Per-item discounts use a distinct role cap; whole-order discounts are validated separately below.
      const requestedItemDiscountPercent = item.item_discount_percent === undefined || item.item_discount_percent === null
        ? null
        : Number(item.item_discount_percent);
      const itemDiscountMode = item.discount_mode ?? configuredItemDiscountMode;
      if (itemDiscountMode !== 'percent' && itemDiscountMode !== 'amount') {
        throw new Error(`Choose either a percentage or UGX discount for ${priceItem.name}`);
      }
      if (configuredItemDiscountMode !== 'both' && itemDiscountMode !== configuredItemDiscountMode) {
        throw new Error(`The administrator has set per-item discounts to ${configuredItemDiscountMode === 'percent' ? 'percentage' : 'fixed UGX'} mode`);
      }
      if (itemDiscountMode === 'percent' && requestedItemDiscountPercent === null) {
        throw new Error(`Enter a percentage discount for ${priceItem.name}`);
      }
      if (itemDiscountMode === 'amount' && requestedItemDiscountPercent !== null) {
        throw new Error(`Choose only one discount mode for ${priceItem.name}`);
      }
      if (requestedItemDiscountPercent !== null &&
          (!Number.isFinite(requestedItemDiscountPercent) || requestedItemDiscountPercent < 0 || requestedItemDiscountPercent > maxItemDiscountPercent)) {
        throw new Error(`Per-item discount on ${priceItem.name} exceeds your role limit of ${maxItemDiscountPercent}%`);
      }
      const requestedItemDiscount = itemDiscountMode === 'amount'
        ? Math.round(Number(item.discount_amount) || 0)
        : Math.round(grossItemTotal * (requestedItemDiscountPercent ?? 0) / 100);
      if (requestedItemDiscount < 0) {
        throw new Error(`Item discount cannot be negative for ${priceItem.name}`);
      }

      const roleDiscountCeiling = Math.round(
        grossItemTotal * (getMaxDiscountForRole(req.user!.role) / 100)
      );
      if (requestedItemDiscountPercent === null && !fullItemAmountAllowed && requestedItemDiscount > roleDiscountCeiling) {
        throw new Error(
          `Discount on ${priceItem.name} exceeds your limit (max ${getMaxDiscountForRole(req.user!.role)}% = ${roleDiscountCeiling})`
        );
      }

      const itemDiscount = Math.min(requestedItemDiscount, grossItemTotal);

      // Per-item surcharge (price-up): available to all authenticated staff
      const itemSurchargeMode = item.surcharge_mode === 'percent' ? 'percent' : 'amount';
      const requestedItemSurchargePercent = Number(item.surcharge_percent ?? 0);
      const hasItemSurcharge = Number(item.surcharge_amount) > 0 || requestedItemSurchargePercent > 0;
      if (hasItemSurcharge && configuredItemDiscountMode !== 'both' && itemSurchargeMode !== configuredItemDiscountMode) {
        throw new Error(`The administrator has set per-item adjustments to ${configuredItemDiscountMode === 'percent' ? 'percentage' : 'fixed UGX'} mode`);
      }
      if (itemSurchargeMode === 'percent' && (!Number.isFinite(requestedItemSurchargePercent) || requestedItemSurchargePercent < 0)) {
        throw new Error(`Price-up percentage is invalid for ${priceItem.name}`);
      }
      const requestedItemSurcharge = itemSurchargeMode === 'percent'
        ? Math.round(grossItemTotal * requestedItemSurchargePercent / 100)
        : Math.round(Number(item.surcharge_amount) || 0);
      if (!Number.isFinite(requestedItemSurcharge) || requestedItemSurcharge < 0) {
        throw new Error(`Item surcharge cannot be negative for ${priceItem.name}`);
      }
      if (itemDiscount > 0 && requestedItemSurcharge > 0) {
        throw new Error(`Choose either a bargain or a price-up for ${priceItem.name}, not both`);
      }

      const itemTotal = grossItemTotal + requestedItemSurcharge - itemDiscount;
      calculatedSubtotal += itemTotal;
      totalItemDiscount += itemDiscount;
      
      // Staff-facing garment description (colour, brand, marks). Trimmed and
      // capped to match the column; never shown to the customer.
      const itemNotes =
        typeof item.notes === 'string' && item.notes.trim()
          ? item.notes.trim().slice(0, 200)
          : null;

      validatedItems.push({
        price_item_id: item.price_item_id,
        service_type: item.service_type,
        quantity: normalizedQuantity,
        unit_price: actualUnitPrice, // Use actual DB price, not frontend
        discount_amount: itemDiscount,
        surcharge_amount: requestedItemSurcharge,
        total_price: itemTotal,
        item_discount_percent: requestedItemDiscountPercent,
        notes: itemNotes,
        express_due_at: expressDueAt
      });
    }
    
    // 2. Validate and calculate discount (role-based limit)
    const requestedDiscountPercentage = parseFloat(discount_percentage.toString()) || 0;
    const requestedBargainAmount = parseInt(bargain_amount.toString()) || 0;
    const orderDiscountMode = order_discount_mode ?? configuredOrderDiscountMode;
    if (orderDiscountMode !== 'percent' && orderDiscountMode !== 'amount') {
      throw new Error('Choose either a percentage or fixed UGX discount for the whole order');
    }
    if (configuredOrderDiscountMode !== 'both' && orderDiscountMode !== configuredOrderDiscountMode) {
      throw new Error(`The administrator has set whole-order discounts to ${configuredOrderDiscountMode === 'percent' ? 'percentage' : 'fixed UGX'} mode`);
    }
    if (orderDiscountMode === 'percent' && requestedBargainAmount > 0) {
      throw new Error('Clear the fixed UGX bargain or switch the whole-order mode to Fixed UGX');
    }
    if (orderDiscountMode === 'amount' && requestedDiscountPercentage > 0) {
      throw new Error('Clear the percentage discount or switch the whole-order mode to Percentage');
    }
    const discountPercentageValue = orderDiscountMode === 'percent' ? requestedDiscountPercentage : 0;
    let maxDiscountForRole = getMaxDiscountForRole(req.user!.role);
    const configuredOrderDiscount = Number(configuredDiscountLimits[roleKey]);
    if (Number.isFinite(configuredOrderDiscount) && configuredOrderDiscount >= 0 && configuredOrderDiscount <= 100) {
      maxDiscountForRole = configuredOrderDiscount;
    }
    
    if (discountPercentageValue < 0 || discountPercentageValue > maxDiscountForRole) {
      throw new Error(
        `Invalid discount percentage: ${discountPercentageValue}%. Your role allows up to ${maxDiscountForRole}%`
      );
    }
    
    const discount_amount = Math.round(calculatedSubtotal * (discountPercentageValue / 100));
    
    // 2.5. Validate bargain amount (role-based limit)
    const bargainAmountValue = orderDiscountMode === 'amount' ? requestedBargainAmount : 0;
    
    if (bargainAmountValue < 0) {
      throw new Error('Bargain amount cannot be negative');
    }
    
    // Fetch user's maximum bargain limits (overall + per-item)
    const userResult = await client.query(
      `SELECT max_bargain_amount, max_item_bargain_amount FROM users WHERE id = $1`,
      [req.user!.id]
    );

    if (userResult.rows.length === 0) throw new Error('User not found');

    const { max_bargain_amount, max_item_bargain_amount } = userResult.rows[0];

    // Fixed-amount caps are configurable by role. Full-value permission is
    // separately capped at the actual line/order amount below.
    const configuredOverallLimit = Number(configuredDiscountLimits[roleKey + '_limit']);
    const configuredPerItemLimit = Number(configuredDiscountLimits[roleKey + '_item_limit']);
    const maxOverall = fullOrderAmountAllowed
      ? Math.max(0, calculatedSubtotal)
      : Number.isFinite(configuredOverallLimit) && configuredOverallLimit >= 0
        ? configuredOverallLimit
        : Math.max(0, Number(max_bargain_amount) || 0);
    const maxPerItem = Number.isFinite(configuredPerItemLimit) && configuredPerItemLimit >= 0
      ? configuredPerItemLimit
      : Math.max(0, Number(max_item_bargain_amount) || 0);

    // Enforce per-item ceiling for every line that has a bargain
    if (!fullItemAmountAllowed) {
      for (const item of validatedItems) {
        if (item.item_discount_percent !== null && item.item_discount_percent !== undefined) continue;
        const itemDiscount = Number(item.discount_amount || 0);
        if (itemDiscount > maxPerItem) {
          throw new Error(
            `Item bargain of UGX ${itemDiscount.toLocaleString()} on one or more items exceeds your per-item limit of UGX ${maxPerItem.toLocaleString()}`
          );
        }
      }
    }

    // The UGX bargain ceiling applies to the whole-order fixed bargain only.
    // Per-item discounts have their own percentage and fixed-amount limits.
    if (bargainAmountValue > maxOverall) {
      throw new Error(
        `Order bargain of UGX ${bargainAmountValue.toLocaleString()} exceeds your overall limit of UGX ${maxOverall.toLocaleString()}`
      );
    }
    
    // Validate bargain amount doesn't exceed order subtotal
    if (bargainAmountValue > calculatedSubtotal) {
      const bargainDisplay = bargainAmountValue.toLocaleString('en-UG');
      const subtotalDisplay = calculatedSubtotal.toLocaleString('en-UG');
      throw new Error(`Bargain amount (UGX ${bargainDisplay}) cannot exceed order subtotal (UGX ${subtotalDisplay})`);
    }
    
    // 2.6. Validate order-level surcharge (price-up) — available to all staff
    const surchargeMode = surcharge_mode === 'percent' ? 'percent' : 'amount';
    const surchargePercentValue = Number(surcharge_percent) || 0;
    const hasOrderSurcharge = Number(surcharge_amount) > 0 || surchargePercentValue > 0;
    if (hasOrderSurcharge && configuredOrderDiscountMode !== 'both' && surchargeMode !== configuredOrderDiscountMode) {
      throw new Error(`The administrator has set whole-order adjustments to ${configuredOrderDiscountMode === 'percent' ? 'percentage' : 'fixed UGX'} mode`);
    }
    if (!Number.isFinite(surchargePercentValue) || surchargePercentValue < 0) {
      throw new Error('Order price-up percentage must be a valid non-negative number');
    }
    const surchargeAmountValue = surchargeMode === 'percent'
      ? Math.round(calculatedSubtotal * surchargePercentValue / 100)
      : Math.max(0, parseInt(surcharge_amount.toString()) || 0);
    if (!Number.isFinite(surchargeAmountValue)) {
      throw new Error('Order price-up amount is too large');
    }
    if (surchargeAmountValue > 0 && (discount_amount > 0 || bargainAmountValue > 0)) {
      throw new Error('Choose either a whole-order bargain or a price-up, not both');
    }

    // 3. Calculate tax.
    // VAT is only ever charged when URA compliance is switched on in Settings.
    // The client's tax values are never trusted — they only signal intent; the
    // rate and amount are always resolved and recomputed here.
    let tax_amount = 0;
    let tax_rate = 0;

    try {
      const vatConfig = await resolveVatConfig(client);

      if (vatConfig.enabled) {
        const clientWantsVat =
          frontendTaxRate === undefined ||
          parseFloat(String(frontendTaxRate)) > 0 ||
          parseInt(String(frontendTaxAmount ?? 0)) > 0;

        if (clientWantsVat) {
          tax_rate = vatConfig.rate;
          // VAT on the amount after discount, bargain, plus any surcharge
          const taxableAmount =
            calculatedSubtotal - discount_amount - bargainAmountValue + surchargeAmountValue;
          tax_amount = Math.round(Math.max(0, taxableAmount) * (tax_rate / 100));
        }
      } else if (parseFloat(String(frontendTaxRate ?? 0)) > 0) {
        console.warn('⚠️ VAT requested but URA compliance is off — charging no VAT');
      }
    } catch (error) {
      console.error('VAT setting fetch error:', error);
      tax_amount = 0;
      tax_rate = 0;
    }
    
    // 4. Calculate final total
    // Formula: subtotal - discount - bargain + surcharge + tax
    const total_amount = calculatedSubtotal - discount_amount - bargainAmountValue + surchargeAmountValue + tax_amount;
    
    // Use backend-calculated subtotal
    const subtotal = calculatedSubtotal;
    
    // Generate order number (format: ORD20260001)
    // Use MAX to avoid race conditions and handle deleted orders
    const maxOrderResult = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 8) AS INTEGER)), 0) as max_number 
       FROM orders 
       WHERE order_number LIKE $1`,
      [`ORD${new Date().getFullYear()}%`]
    );
    const nextNumber = parseInt(maxOrderResult.rows[0].max_number) + 1;
    const year = new Date().getFullYear();
    const order_number = `ORD${year}${String(nextNumber).padStart(4, '0')}`;
    
    // On Account = credit sale: force unpaid with zero amount paid
    let finalPaymentMethod = payment_method || 'CASH';
    let finalAmountPaidValue = Math.max(0, Number(amount_paid) || 0);
    const requestedStatus = String(payment_status || 'UNPAID').toUpperCase();

    if (finalPaymentMethod === 'ON_ACCOUNT') {
      finalAmountPaidValue = 0;
      console.log('💳 On Account selected — payment status forced to UNPAID');
    } else if (
      // Staff clicked Cash + Paid but left Amount Paid empty → treat as full payment received
      requestedStatus === 'PAID' &&
      finalAmountPaidValue <= 0 &&
      total_amount > 0
    ) {
      finalAmountPaidValue = total_amount;
      console.log(`💵 PAID with blank amount — auto-filled full payment UGX ${total_amount.toLocaleString()}`);
    }

    // Derive payment_status from amounts (source of truth)
    if (finalAmountPaidValue > total_amount) {
      const amountPaidDisplay = finalAmountPaidValue.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      const totalDisplay = total_amount.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      throw new Error(`Payment amount (UGX ${amountPaidDisplay}) exceeds the order total (UGX ${totalDisplay}). Maximum payment allowed is UGX ${totalDisplay}.`);
    }

    let finalPaymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID';
    if (finalAmountPaidValue <= 0) {
      finalPaymentStatus = 'UNPAID';
      finalAmountPaidValue = 0;
    } else if (finalAmountPaidValue >= total_amount && total_amount > 0) {
      finalPaymentStatus = 'PAID';
      finalAmountPaidValue = total_amount;
    } else if (total_amount <= 0) {
      finalPaymentStatus = 'UNPAID';
      finalAmountPaidValue = 0;
    } else {
      finalPaymentStatus = 'PARTIAL';
    }

    // Calculate balance
    const balance = Math.max(0, total_amount - finalAmountPaidValue);
    
    // Generate invoice number
    const invoiceMaxResult = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 10) AS INTEGER)), 0) as max_number 
       FROM orders 
       WHERE invoice_number LIKE $1`,
      [`INV-${year}-%`]
    );
    const nextInvoiceNumber = parseInt(invoiceMaxResult.rows[0].max_number) + 1;
    const invoice_number = `INV-${year}-${String(nextInvoiceNumber).padStart(6, '0')}`;
    
    // Create order — recorded_at is always "entered now"; created_at is the business date
    const orderResult = await client.query(
      `INSERT INTO orders (
        order_number, customer_id, user_id, subtotal, tax_rate, tax_amount,
        discount_percentage, discount_amount, bargain_amount, surcharge_amount,
        total_amount, payment_status, payment_method, amount_paid, balance,
        status, transaction_reference, invoice_number, notes, branch_id, catalogue_kg,
        created_at, recorded_at, is_backdated, idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),$23,$24)
      RETURNING *`,
      [
        order_number, customer_id, req.user!.id, subtotal, tax_rate, tax_amount,
        discount_percentage, discount_amount, bargainAmountValue, surchargeAmountValue,
        total_amount, finalPaymentStatus, finalPaymentMethod, finalAmountPaidValue,
        balance, 'pending', transaction_reference || null, invoice_number, notes, branchId,
        catalogueMode ? catalogueWeight : null,
        customOrderDate
          ? ymdToPgTimestamp(extractYmd(customOrderDate) || toKampalaYmd(new Date(customOrderDate)))
          : new Date().toISOString(),
        isBackdated,
        idempotencyKey,
      ]
    );
    
    const orderId = orderResult.rows[0].id;
    
    // Create order items using VALIDATED data from backend
    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id, 
          price_item_id, 
          service_type, 
          quantity, 
          unit_price, 
          discount_amount,
          surcharge_amount,
          total_price,
          notes,
          express_due_at
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orderId, 
          item.price_item_id, 
          item.service_type.toUpperCase(), 
          item.quantity, 
          item.unit_price,
          item.discount_amount || 0,
          item.surcharge_amount || 0,
          item.total_price,
          item.notes,
          item.express_due_at
        ]
      );
    }
    
    // Always create a payments ledger row when money was received (links order ↔ Payments ↔ accounting)
    if (finalAmountPaidValue > 0 && finalPaymentMethod !== 'ON_ACCOUNT') {
      const todayYmd = kampalaTodayYmd();
      const requestedPaymentYmd = extractYmd(requestedCreatePaymentDate);
      const isHistoricalPayment = historical_payment === true || historical_payment === 'true';
      if (isHistoricalPayment && req.user!.role !== 'ADMIN' && req.user!.role !== 'MANAGER' && !isBackdated) {
        throw new Error('Desktop agents can backdate an initial payment only when creating a historical order.');
      }
      if (isHistoricalPayment && (!requestedPaymentYmd || requestedPaymentYmd >= todayYmd)) {
        throw new Error('Choose a payment date earlier than today for a historical payment.');
      }
      const paymentYmd = isHistoricalPayment ? requestedPaymentYmd! : todayYmd;
      await client.query(
        `INSERT INTO payments (
          order_id,
          customer_id,
          amount,
          payment_method,
          transaction_reference,
          payment_date,
          notes,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7, $8)`,
        [
          orderId,
          customer_id,
          finalAmountPaidValue,
          finalPaymentMethod,
          transaction_reference || null,
          ymdToPgTimestamp(paymentYmd),
          `Initial payment for order ${order_number}`,
          req.user!.id
        ]
      );
      console.log(`💰 Payment transaction created: ${finalPaymentMethod} - UGX ${finalAmountPaidValue.toLocaleString()} → order ${order_number}`);
    }
    
    await client.query('COMMIT');
    
    const createdOrder = orderResult.rows[0];
    
    // 💰 Notify admin if bargain deduction was used
    if (bargainAmountValue > 0) {
      try {
        // Get all admin users
        const admins = await client.query(
          `SELECT id FROM users WHERE role = 'ADMIN'`
        );

        // Get staff name who created the order
        const staffName = req.user!.full_name || req.user!.email;
        
        // Create notification for each admin
        for (const admin of admins.rows) {
          await client.query(
            `INSERT INTO notifications (user_id, type, title, message, link, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              admin.id,
              'bargain_used',
              'Bargain Deduction Applied',
              `${staffName} applied a UGX ${bargainAmountValue.toLocaleString()} bargain deduction on order ${order_number}`,
              `/orders?order=${order_number}`,
            ]
          );
        }
        
        console.log(`🔔 Admin notified: ${staffName} used UGX ${bargainAmountValue.toLocaleString()} bargain on order ${order_number}`);
      } catch (notifError) {
        // Don't fail the order if notification fails
        console.error('⚠️ Failed to create bargain notification:', notifError);
      }
    }
    
    // Get customer details for SMS receipt
    const customerResult = await client.query(
      'SELECT name, phone FROM customers WHERE id = $1',
      [customer_id]
    );
    
    if (customerResult.rows.length > 0 && customerResult.rows[0].phone) {
      const customerName = customerResult.rows[0].name;
      const customerPhone = customerResult.rows[0].phone;
      
      const receiptItemsResult = await client.query(
        `SELECT oi.quantity, oi.unit_price, oi.discount_amount, oi.total_price, pi.name as item_name
         FROM order_items oi
         JOIN price_items pi ON oi.price_item_id = pi.id
         WHERE oi.order_id = $1`,
        [orderId]
      );

      const receiptItems = receiptItemsResult.rows.map((item: any) => ({
        name: item.item_name || 'Item',
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unit_price) || 0,
        discountAmount: Number(item.discount_amount) || 0,
        totalPrice: Number(item.total_price) || 0,
      }));

      // Prepare order details for receipt with proper item names
      const orderDetails = {
        items: receiptItems,
        subtotal,
        orderDiscountAmount: discount_amount,
        bargainAmount: bargainAmountValue,
        taxAmount: tax_amount,
        total: total_amount,
        amountPaid: finalAmountPaidValue,
        balance,
        pickupDate: pickup_date ? new Date(pickup_date).toLocaleDateString() : 'TBD',
        orderStatus: createdOrder.status,
        paymentStatus: finalPaymentStatus,
      };
      
      // 🔥 Check automation setting before sending WhatsApp order confirmation
      const automationCheck = await query(
        `SELECT setting_value FROM automation_settings WHERE setting_key = 'whatsapp_auto_send_receipt' AND tenant_id = app_current_tenant_id()`
      );
      const autoSendReceipt = automationCheck.rows[0]?.setting_value ?? true;
      
      if (autoSendReceipt) {
        const customerId = customer_id; // Store before client is released
        sendOrderConfirmation(customerName, customerPhone, order_number, orderDetails)
          .then(async (result: any) => {
            if (result.success) {
              console.log(`✅ WhatsApp confirmation sent for order ${order_number}`);
              
              // Save message to database (use standalone query, not client)
              try {
                await query(
                  `INSERT INTO whatsapp_messages 
                   (customer_id, phone_number, message_text, message_type, status, whatsapp_message_id, cost_ugx)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    customerId,
                    customerPhone,
                    `Order confirmation for ${order_number}`,
                    'order_confirmation',
                    'sent',
                    result.messageId,
                    193.00
                  ]
                );
                console.log(`✅ Message logged to database for order ${order_number}`);
              } catch (dbError) {
                console.error(`❌ Database error logging message:`, dbError);
              }
            } else {
              console.error(`❌ WhatsApp failed for order ${order_number}:`, result.error);
            }
          })
          .catch((error: any) => {
            console.error(`❌ WhatsApp error for order ${order_number}:`, error);
          });
      } else {
        console.log(`ℹ️ Automation disabled - WhatsApp confirmation NOT sent for order ${order_number}`);
      }
      
      // Calculate pickup date (3 days from now)
      const pickupDate = new Date();
      pickupDate.setDate(pickupDate.getDate() + 3);
      
      // Generate PDF receipt asynchronously
      console.log(`📄 Generating PDF receipt for ${order_number}`);
      
      generateOrderReceiptPDF({
        orderNumber: order_number,
        customerName,
        customerPhone,
        orderDate: new Date(),
        pickupDate,
        items: receiptItems,
        subtotal,
        orderDiscountAmount: discount_amount,
        bargainAmount: bargainAmountValue,
        taxAmount: tax_amount,
        total: total_amount,
        amountPaid: finalAmountPaidValue,
        balance,
        paymentStatus: finalPaymentStatus,
        orderStatus: createdOrder.status,
      })
        .then(async (pdfPath) => {
          console.log(`✅ PDF receipt generated: ${pdfPath}`);
          
          // TODO: Upload PDF to public URL (ngrok, S3, or temp hosting)
          // For now, send WhatsApp with PDF disabled (Twilio sandbox limitation)
          const pdfUrl = undefined; // Set this when you have public PDF hosting
          
          // The WhatsApp confirmation was already sent above with receipt details
          // This PDF is for future attachment capability
          
          // Send text receipt via SMS as backup
          sendOrderReceipt(
            customerPhone,
            order_number,
            customerName,
            {
              items: receiptItems,
              subtotal,
              orderDiscountAmount: discount_amount,
              bargainAmount: bargainAmountValue,
              taxAmount: tax_amount,
              total: total_amount,
              amountPaid: finalAmountPaidValue,
              balance,
              paymentStatus: finalPaymentStatus,
              orderStatus: createdOrder.status,
            }
          ).then((sent) => {
            if (sent) {
              console.log(`✅ SMS backup receipt sent for ${order_number}`);
            }
          }).catch((error: any) => {
            console.error(`❌ SMS receipt failed:`, error);
          });
          
          // Clean up PDF file after delay
          setTimeout(() => {
            try {
              fs.unlinkSync(pdfPath);
              console.log(`🗑️ Cleaned up PDF: ${pdfPath}`);
            } catch (err) {
              console.error(`⚠️ Failed to delete PDF: ${err}`);
            }
          }, 30000);
        })
        .catch((error: any) => {
          console.error(`❌ Failed to generate/send receipt for ${order_number}:`, error);
        });
    }

    // Create payment notification for mobile money or bank transfer
    if ((payment_method.includes('MOBILE_MONEY') || payment_method === 'BANK_TRANSFER') && amount_paid > 0) {
      const paymentMethodDisplay = payment_method.includes('MTN') ? 'MTN Mobile Money' :
                                   payment_method.includes('AIRTEL') ? 'Airtel Money' :
                                   'Bank Transfer';

      // Notify all admins and the cashier
      const usersToNotify = await client.query(
        `SELECT id FROM users WHERE role IN ('ADMIN', 'DESKTOP_AGENT')`
      );

      const notificationMessage = `Payment of UGX ${amount_paid.toLocaleString()} received via ${paymentMethodDisplay} for order ${order_number}${transaction_reference ? ` (Ref: ${transaction_reference})` : ''}`;

      for (const user of usersToNotify.rows) {
        await client.query(
          `INSERT INTO notifications (user_id, type, title, message, link, created_at)
           VALUES ($1, 'payment', 'Payment Received', $2, '/orders', NOW())`,
          [user.id, notificationMessage]
        );
      }

      console.log(`✅ Payment notifications sent for order ${order_number}`);
    }
    
    // Log order creation for audit trail
    await logCreate(
      req.user!.id,
      req.user!.email,
      req.user!.full_name,
      req.user!.role,
      'order',
      orderId,
      { 
        order_number,
        customer_id,
        total_amount,
        items: validatedItems.length,
        payment_status
      },
      req.ip
    );
    
    res.status(201).json({
      message: 'Order created successfully',
      order: { ...createdOrder, item_discount_total: totalItemDiscount },
    });
    
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    const message = error?.message || 'Failed to create order';
    const statusCode = error?.message && !error?.code ? 400 : 500;
    res.status(statusCode).json({ error: message });
  } finally {
    client.release();
  }
};

export const updateOrder = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { id } = req.params;
    const { 
      status: order_status, 
      payment_status, 
      payment_method, 
      amount_paid, 
      balance,
      pickup_date, 
      discount_percentage,
      discount_amount,
      notes,
      transaction_reference,
      payment_date: requestedPaymentDate,
      historical_payment = false,
    } = req.body;

    // Cancelling is an administrator action. This generic update route must not
    // become a side door around the same rule enforced in updateOrderStatus.
    if (
      order_status &&
      String(order_status).toLowerCase() === 'cancelled' &&
      req.user!.role !== 'ADMIN' &&
      req.user!.role !== 'MANAGER'
    ) {
      return res.status(403).json({
        error: 'Only administrators and managers can cancel an order',
      });
    }

    // Parse numeric values properly (handle both integer and decimal inputs)
    // Database columns: subtotal, discount, tax, total, amount_paid are DECIMAL
    // Validate and cap values to prevent overflow
    const MAX_DECIMAL_VALUE = 999999999.99; // Max for DECIMAL(10,2)
    
    const parseAndValidateAmount = (value: any, fieldName: string): number | undefined => {
      if (value === undefined || value === null) return undefined;
      const parsed = parseFloat(value);
      if (isNaN(parsed)) {
        throw new Error(`Invalid ${fieldName}: ${value}`);
      }
      if (parsed > MAX_DECIMAL_VALUE) {
        throw new Error(`${fieldName} exceeds maximum allowed value (${MAX_DECIMAL_VALUE})`);
      }
      if (parsed < 0) {
        throw new Error(`${fieldName} cannot be negative`);
      }
      return parsed;
    };
    
    const parsedAmountPaid = parseAndValidateAmount(amount_paid, 'amount_paid');
    const parsedBalance = parseAndValidateAmount(balance, 'balance');
    const parsedDiscountAmount = parseAndValidateAmount(discount_amount, 'discount_amount');
    const parsedDiscountPercentage = discount_percentage !== undefined ? parseFloat(discount_percentage) : undefined;

    // Get the current order to check if payment amount changed
    const currentOrderResult = await query('SELECT * FROM orders WHERE id = $1', [id]);
    if (currentOrderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const currentOrder = currentOrderResult.rows[0];

    if (parsedAmountPaid !== undefined && parsedAmountPaid > currentOrder.amount_paid
      && (historical_payment === true || historical_payment === 'true')) {
      if (req.user!.role !== 'ADMIN' && req.user!.role !== 'MANAGER') {
        return res.status(403).json({ error: 'Only administrators and managers can record a historical payment.' });
      }
      const historicalYmd = extractYmd(requestedPaymentDate);
      if (!historicalYmd || historicalYmd >= kampalaTodayYmd()) {
        return res.status(400).json({ error: 'Choose a payment date earlier than today for a historical payment.' });
      }
    }

    if (forbiddenIfOutsideBranch(req, res, currentOrder.branch_id)) {
      return;
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;
    
    if (order_status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(order_status);
    }
    if (payment_method !== undefined) {
      updates.push(`payment_method = $${paramCount++}`);
      values.push(payment_method);
    }
    if (transaction_reference !== undefined) {
      updates.push(`transaction_reference = $${paramCount++}`);
      values.push(transaction_reference);
    }

    // When amount_paid changes (or payment_status sent alone), derive status from money
    const nextAmountPaid = parsedAmountPaid !== undefined
      ? parsedAmountPaid
      : Number(currentOrder.amount_paid) || 0;
    const orderTotal = Number(currentOrder.total_amount) || 0;

    if (parsedAmountPaid !== undefined && orderTotal > 0 && parsedAmountPaid > orderTotal + 0.009) {
      const remaining = Math.max(0, orderTotal - (Number(currentOrder.amount_paid) || 0));
      return res.status(400).json({
        error: `Payment of UGX ${parsedAmountPaid.toLocaleString()} exceeds the order total of UGX ${orderTotal.toLocaleString()}. Remaining balance is UGX ${remaining.toLocaleString()}.`,
        remaining,
        order_total: orderTotal,
      });
    }

    if (parsedAmountPaid !== undefined || payment_status !== undefined) {
      let derivedStatus: 'PAID' | 'PARTIAL' | 'UNPAID';
      let cappedPaid = Math.max(0, nextAmountPaid);

      if (cappedPaid <= 0) {
        derivedStatus = 'UNPAID';
        cappedPaid = 0;
      } else if (orderTotal > 0 && cappedPaid >= orderTotal) {
        derivedStatus = 'PAID';
        cappedPaid = orderTotal;
      } else if (orderTotal <= 0) {
        derivedStatus = 'UNPAID';
        cappedPaid = 0;
      } else {
        derivedStatus = 'PARTIAL';
      }

      // Reject fake PAID with zero paid
      if (payment_status === 'PAID' && cappedPaid <= 0) {
        return res.status(400).json({
          error: 'Cannot mark order as PAID with UGX 0 paid. Use Add Payment to record a payment first.',
        });
      }

      updates.push(`amount_paid = $${paramCount++}`);
      values.push(cappedPaid);
      updates.push(`payment_status = $${paramCount++}`);
      values.push(derivedStatus);
      updates.push(`balance = $${paramCount++}`);
      values.push(Math.max(0, orderTotal - cappedPaid));
    } else if (parsedBalance !== undefined) {
      updates.push(`balance = $${paramCount++}`);
      values.push(parsedBalance);
    }
    if (pickup_date !== undefined) {
      updates.push(`pickup_date = $${paramCount++}`);
      values.push(pickup_date);
    }
    if (parsedDiscountPercentage !== undefined) {
      updates.push(`discount_percentage = $${paramCount++}`);
      values.push(parsedDiscountPercentage);
    }
    if (parsedDiscountAmount !== undefined) {
      updates.push(`discount_amount = $${paramCount++}`);
      values.push(parsedDiscountAmount);
      
      // CRITICAL: Recalculate total_amount when discount changes
      // Formula: total = subtotal + tax - discount
      const newTotal = currentOrder.subtotal + (currentOrder.tax_amount || 0) - discount_amount;
      updates.push(`total_amount = $${paramCount++}`);
      values.push(newTotal);
      
      // Recalculate balance = total - amount_paid
      const currentAmountPaid = parsedAmountPaid !== undefined ? parsedAmountPaid : currentOrder.amount_paid;
      const newBalance = newTotal - currentAmountPaid;
      updates.push(`balance = $${paramCount++}`);
      values.push(newBalance);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramCount++}`);
      values.push(notes);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    values.push(id);
    
    const result = await query(
      `UPDATE orders SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const updatedOrder = result.rows[0];

    // If payment was added (amount_paid increased), create a payment transaction record
    if (parsedAmountPaid !== undefined && parsedAmountPaid > currentOrder.amount_paid) {
      const paymentAmount = parsedAmountPaid - currentOrder.amount_paid;
      const userId = req.user?.id;

      try {
        const todayYmd = kampalaTodayYmd();
        const requestedPaymentYmd = extractYmd(requestedPaymentDate);
        const isHistoricalPayment = historical_payment === true || historical_payment === 'true';
        if (isHistoricalPayment && req.user!.role !== 'ADMIN' && req.user!.role !== 'MANAGER') {
          throw new Error('Only administrators and managers can record a historical payment.');
        }
        if (isHistoricalPayment && (!requestedPaymentYmd || requestedPaymentYmd >= todayYmd)) {
          throw new Error('Choose a payment date earlier than today for a historical payment.');
        }
        const paymentYmd = isHistoricalPayment ? requestedPaymentYmd! : todayYmd;

        await query(`
          INSERT INTO payments (
            order_id,
            customer_id,
            amount,
            payment_method,
            transaction_reference,
            payment_date,
            notes,
            created_by
          ) VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7, $8)
        `, [
          id,
          updatedOrder.customer_id,
          paymentAmount,
          payment_method || currentOrder.payment_method || 'CASH',
          transaction_reference || null,
          ymdToPgTimestamp(paymentYmd),
          notes ? `Manual payment: ${notes}` : 'Manual payment added to order',
          userId
        ]);

        console.log(`✅ Payment transaction record created: ${paymentAmount} for order ${id} on ${paymentYmd}`);
      } catch (paymentError) {
        console.error('Error creating payment record:', paymentError);
        throw paymentError;
      }
    }
    
    // Log order update for audit trail
    await logUpdate(
      req.user!.id,
      req.user!.email,
      req.user!.full_name,
      req.user!.role,
      'order',
      parseInt(id),
      { 
        status: order_status,
        payment_status,
        amount_paid: amount_paid || currentOrder.amount_paid,
        balance: balance || updatedOrder.balance,
        updated_fields: Object.keys(req.body)
      },
      req.ip
    );
    
    res.json({
      message: 'Order updated successfully',
      order: updatedOrder,
    });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
};

export const updateOrderStatus = async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { id } = req.params;
    const { status } = req.body;
    
    // Get order details with customer info before updating
    const orderBeforeUpdate = await query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone 
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [id]
    );
    
    if (orderBeforeUpdate.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (forbiddenIfOutsideBranch(req, res, orderBeforeUpdate.rows[0].branch_id)) {
      return;
    }

    const oldStatus = orderBeforeUpdate.rows[0].status;
    const orderNumber = orderBeforeUpdate.rows[0].order_number;
    const customerName = orderBeforeUpdate.rows[0].customer_name;
    const customerPhone = orderBeforeUpdate.rows[0].customer_phone;
    
    console.log(`🔄 Status Update: ${orderNumber} from ${oldStatus} to ${status}`);
    console.log(`📞 Customer: ${customerName}, Phone: ${customerPhone}`);
    
    // Convert status to lowercase to match database enum (pending, processing, ready, delivered, cancelled)
    const dbStatus = status.toLowerCase();
    
    // BUSINESS RULE: Only ADMIN can cancel orders
    if (dbStatus === 'cancelled' && req.user?.role !== 'ADMIN' && req.user?.role !== 'MANAGER') {
      return res.status(403).json({ 
        error: 'Only administrators and managers can cancel orders',
        businessRule: 'CANCELLATION_RESTRICTED',
        requiredRole: 'ADMIN or MANAGER',
        yourRole: req.user?.role
      });
    }
    
    // Auto-update pickup_date when status changes to DELIVERED
    let updateQuery = 'UPDATE orders SET status = $1';
    const updateValues: any[] = [dbStatus];
    let paramCount = 2;
    
    if (dbStatus === 'delivered' && oldStatus !== 'delivered') {
      updateQuery += `, pickup_date = CURRENT_TIMESTAMP`;
      console.log(`📅 Auto-updating pickup_date to current timestamp for DELIVERED order`);
    }
    
    updateQuery += ` WHERE id = $${paramCount} RETURNING *`;
    updateValues.push(id);
    
    // Update order status
    const result = await query(updateQuery, updateValues);
    
    // Send SMS notification if status changed to READY
    if (oldStatus !== 'ready' && dbStatus === 'ready' && customerPhone) {
      console.log(`📱 Sending notifications for order ${orderNumber} to ${customerPhone}`);
      
      // Get order total and payment details
      const totalAmount = orderBeforeUpdate.rows[0].total_amount;
      const amountPaid = orderBeforeUpdate.rows[0].amount_paid || 0;
      const balance = totalAmount - amountPaid;
      const paymentStatus = orderBeforeUpdate.rows[0].payment_status || 'UNPAID';
      const orderDate = new Date(orderBeforeUpdate.rows[0].created_at).toLocaleDateString();
      
      // Get order items for WhatsApp message
      const orderItems = await query(
        `SELECT oi.quantity, pi.name as item_name
         FROM order_items oi
         JOIN price_items pi ON oi.price_item_id = pi.id
         WHERE oi.order_id = $1`,
        [id]
      );
      
      const items = orderItems.rows.map((item: any) => ({
        name: item.item_name,
        quantity: item.quantity
      }));
      
      // Send SMS notification
      sendOrderReadyNotification(
        customerPhone,
        orderNumber,
        customerName,
        paymentStatus,
        balance,
        ['cash', 'MTN Mobile Money', 'Airtel Money', 'bank transfer']
      )
        .then((sent) => {
          if (sent) {
            console.log(`✅ SMS notification sent for order ${orderNumber}`);
          } else {
            console.log(`ℹ️ SMS notification skipped for order ${orderNumber} (SMS disabled or failed)`);
          }
        })
        .catch((error: any) => {
          console.error(`❌ Failed to send SMS for order ${orderNumber}:`, error);
        });
      
      // Check automation setting before sending WhatsApp ready notification
      const automationCheck = await query(
        `SELECT setting_value FROM automation_settings WHERE setting_key = 'whatsapp_auto_send_ready' AND tenant_id = app_current_tenant_id()`
      );
      const autoSendReady = automationCheck.rows[0]?.setting_value ?? true;
      
      if (autoSendReady) {
        // Send WhatsApp ready notification with order details
        sendOrderReady(
          customerName,
          customerPhone,
          orderNumber,
          {
            items,
            orderDate,
            totalAmount,
            amountPaid,
            balance
          }
        )
          .then(async (result: any) => {
            if (result.success) {
              console.log(`✅ WhatsApp ready notification sent for order ${orderNumber}`);
              
              // Save to database
              try {
                await query(
                  `INSERT INTO whatsapp_messages 
                   (customer_id, phone_number, message_text, message_type, status, whatsapp_message_id, cost_ugx)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    orderBeforeUpdate.rows[0].customer_id,
                    customerPhone,
                    `Order ready notification for ${orderNumber}`,
                    'order_ready',
                    'sent',
                    result.messageId,
                    193.00
                  ]
                );
                console.log(`✅ WhatsApp message logged to database`);
              } catch (dbError) {
                console.error(`❌ Database error:`, dbError);
              }
            } else {
              console.error(`❌ WhatsApp failed for order ${orderNumber}:`, result.error);
            }
          })
          .catch((error: any) => {
            console.error(`❌ WhatsApp error for order ${orderNumber}:`, error);
          });
      } else {
        console.log(`ℹ️ Automation disabled - WhatsApp ready notification NOT sent for order ${orderNumber}`);
      }
    }

    if (oldStatus !== 'delivered' && dbStatus === 'delivered' && customerPhone) {
      console.log(`📱 Sending delivered notification for order ${orderNumber} to ${customerPhone}`);

      const totalAmount = orderBeforeUpdate.rows[0].total_amount;
      const amountPaid = orderBeforeUpdate.rows[0].amount_paid || 0;
      const balance = totalAmount - amountPaid;
      const paymentStatus = orderBeforeUpdate.rows[0].payment_status || 'UNPAID';

      sendOrderDeliveredNotification(
        customerPhone,
        orderNumber,
        customerName,
        paymentStatus,
        balance,
        ['cash', 'MTN Mobile Money', 'Airtel Money', 'bank transfer']
      )
        .then((sent) => {
          if (sent) {
            console.log(`✅ SMS delivered notification sent for order ${orderNumber}`);
          } else {
            console.log(`ℹ️ SMS delivered notification skipped for order ${orderNumber} (SMS disabled or failed)`);
          }
        })
        .catch((error: any) => {
          console.error(`❌ Failed to send delivered SMS for order ${orderNumber}:`, error);
        });
    }
    
    res.json({
      message: 'Order status updated successfully',
      order: result.rows[0],
    });

    if (dbStatus === 'cancelled' && req.user?.role === 'MANAGER') {
      notifyAdministrators(
        'order',
        'Order cancelled by manager',
        `${req.user.full_name} cancelled order ${orderNumber} (${customerName}).`,
        `/orders`
      ).catch(() => undefined);
    }
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
};

export const deleteOrder = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  
  try {
    const { id } = req.params;
    const { deletion_reason } = req.body;
    const userId = req.user?.id;
    const userName = req.user?.full_name || 'Administrator';
    
    await beginTenantTransaction(client);
    
    // Get complete order details with customer info
    const orderCheck = await client.query(
      `SELECT o.*, c.name as customer_name 
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [id]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderCheck.rows[0];
    
    // BUSINESS RULE: Only ADMIN can delete, and ONLY if status is CANCELLED
    if (order.status !== 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Cannot delete order #${order.order_number}. Only CANCELLED orders can be deleted.`,
        currentStatus: order.status,
        businessRule: 'DELETION_REQUIRES_CANCELLATION',
        suggestion: 'First cancel the order, then delete it'
      });
    }
    
    // Get order items for audit trail
    const orderItems = await client.query(
      `SELECT oi.*, pi.name as item_name
       FROM order_items oi
       JOIN price_items pi ON oi.price_item_id = pi.id
       WHERE oi.order_id = $1`,
      [id]
    );
    
    // Get payments for audit trail
    const payments = await client.query(
      `SELECT * FROM payments WHERE order_id = $1`,
      [id]
    );
    
    // Create audit record in order_deletions table
    // CRITICAL: Convert money values to integers (never floats)
    const totalAmount = parseInt(order.total_amount) || 0;
    const amountPaid = parseInt(order.amount_paid) || 0;
    const balance = totalAmount - amountPaid;
    
    await client.query(
      `INSERT INTO order_deletions (
        order_id, order_number, customer_id, customer_name,
        total_amount, amount_paid, balance, payment_status, status,
        created_at, cancelled_at, deleted_by, deleted_by_name,
        deletion_reason, order_items, payments
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        order.id,
        order.order_number,
        order.customer_id,
        order.customer_name,
        totalAmount,
        amountPaid,
        balance,
        order.payment_status,
        order.status,
        order.created_at,
        order.updated_at, // Approximation of when it was cancelled
        userId,
        userName,
        deletion_reason || 'No reason provided',
        JSON.stringify(orderItems.rows),
        JSON.stringify(payments.rows)
      ]
    );
    
    console.log(`🗑️ Deleting order #${order.order_number}`);
    console.log(`💰 Financial Impact: Total=${totalAmount}, Paid=${amountPaid}, Balance=${balance}`);
    
    // Delete order (cascade will handle order_items and payments)
    await client.query('DELETE FROM orders WHERE id = $1', [id]);
    
    // Log the deletion for activity tracking
    await logDelete(
      userId!,
      req.user?.email || 'unknown',
      userName,
      req.user?.role || 'ADMIN',
      'orders',
      parseInt(id),
      {
        order_number: order.order_number,
        customer_name: order.customer_name,
        total_amount: totalAmount,
        amount_paid: amountPaid,
        balance: balance,
        deletion_reason
      }
    );
    
    await client.query('COMMIT');
    
    console.log(`✅ Order #${order.order_number} deleted and archived`);
    
    res.json({ 
      message: `Order #${order.order_number} deleted successfully`,
      archivedTo: 'order_deletions',
      financialImpact: {
        totalAmount: totalAmount,
        amountPaid: amountPaid,
        balance: balance
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  } finally {
    client.release();
  }
};

// Get order statistics for a specific year
export const getOrderStats = async (req: AuthRequest, res: Response) => {
  try {
    const { year, status, payment_status } = req.query;
    
    if (!year) {
      return res.status(400).json({ error: 'Year is required' });
    }

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const sql = `
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(total_amount), 0) as total_amount
      FROM orders
      WHERE 
        created_at >= $1 
        AND created_at <= $2
        AND status = $3
        AND payment_status = $4
    `;

    const result = await query(sql, [startDate, endDate, status || 'DELIVERED', payment_status || 'PAID']);

    res.json({
      count: parseInt(result.rows[0].count),
      totalAmount: parseFloat(result.rows[0].total_amount)
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({ error: 'Failed to get order statistics' });
  }
};

// Bulk delete old orders (admin only - PAID and DELIVERED only)
export const bulkDeleteOrders = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  
  try {
    const { year } = req.body;
    
    if (!year) {
      return res.status(400).json({ error: 'Year is required' });
    }

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    await beginTenantTransaction(client);

    // Only delete PAID and DELIVERED orders
    const deleteSql = `
      DELETE FROM orders
      WHERE 
        created_at >= $1 
        AND created_at <= $2
        AND status = 'DELIVERED'
        AND payment_status = 'PAID'
      RETURNING id
    `;

    const result = await client.query(deleteSql, [startDate, endDate]);
    const deletedCount = result.rowCount || 0;

    // Note: order_items will be automatically deleted via CASCADE foreign key

    await client.query('COMMIT');

    res.json({ 
      message: `Successfully deleted ${deletedCount} completed orders`,
      count: deletedCount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Bulk delete orders error:', error);
    res.status(500).json({ error: 'Failed to delete orders' });
  } finally {
    client.release();
  }
};

// Get deleted orders audit log (ADMIN only)
export const getDeletedOrders = async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, from_date, to_date, customer_id } = req.query;
    
    let whereClause = 'WHERE 1=1';
    const values: any[] = [];
    let paramCount = 1;
    
    if (from_date) {
      whereClause += ` AND deleted_at >= $${paramCount++}`;
      values.push(from_date);
    }
    
    if (to_date) {
      whereClause += ` AND deleted_at <= $${paramCount++}`;
      values.push(to_date);
    }
    
    if (customer_id) {
      whereClause += ` AND customer_id = $${paramCount++}`;
      values.push(customer_id);
    }
    
    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total FROM order_deletions ${whereClause}`,
      values
    );
    const totalCount = parseInt(countResult.rows[0].total);
    
    // Calculate pagination
    const offset = (Number(page) - 1) * Number(limit);
    values.push(Number(limit), offset);
    
    // Get deleted orders with pagination
    const result = await query(
      `SELECT 
        od.*,
        u.full_name as deleted_by_full_name,
        u.email as deleted_by_email
       FROM order_deletions od
       LEFT JOIN users u ON od.deleted_by = u.id
       ${whereClause}
       ORDER BY od.deleted_at DESC
       LIMIT $${paramCount++} OFFSET $${paramCount++}`,
      values
    );
    
    res.json({
      deletedOrders: result.rows,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)),
        totalCount,
        limit: Number(limit)
      }
    });
  } catch (error) {
    console.error('Get deleted orders error:', error);
    res.status(500).json({ error: 'Failed to get deleted orders' });
  }
};
