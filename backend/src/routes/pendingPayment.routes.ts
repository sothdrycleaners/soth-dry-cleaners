import { Router } from 'express';
import { authenticate, requireAdmin, requireDesktopWorkspaceAccess } from '../middleware/auth';
import {
  getPendingPayments,
  getAssignedPayments,
  getRejectedPayments,
  searchOrdersForPayment,
  getCustomersWithUnpaidOrders,
  getCustomerUnpaidOrders,
  assignPaymentToOrder,
  rejectPendingPayment,
  reassignRejectedPayment,
  deleteRejectedPayment,
  receiveMobileMoneyPayment
} from '../controllers/pendingPayment.controller';

const router = Router();

// All staff can view and assign pending payments
router.get('/pending', authenticate as any,
  requireDesktopWorkspaceAccess as any, getPendingPayments as any);
router.get('/assigned', authenticate as any,
  requireDesktopWorkspaceAccess as any, getAssignedPayments as any);
router.get('/search-orders', authenticate as any,
  requireDesktopWorkspaceAccess as any, searchOrdersForPayment as any);
router.get('/customers-with-unpaid', authenticate as any,
  requireDesktopWorkspaceAccess as any, getCustomersWithUnpaidOrders as any);
router.get('/customer/:customerId/orders', authenticate as any,
  requireDesktopWorkspaceAccess as any, getCustomerUnpaidOrders as any);
router.post('/:pendingPaymentId/assign', authenticate as any,
  requireDesktopWorkspaceAccess as any, assignPaymentToOrder as any);
router.post('/:pendingPaymentId/reject', authenticate as any,
  requireDesktopWorkspaceAccess as any, rejectPendingPayment as any);

// Admin-only: View, reassign, and delete rejected payments
router.get('/rejected', authenticate as any,
  requireDesktopWorkspaceAccess as any, requireAdmin as any, getRejectedPayments as any);
router.post('/:pendingPaymentId/reassign', authenticate as any,
  requireDesktopWorkspaceAccess as any, requireAdmin as any, reassignRejectedPayment as any);
router.delete('/:pendingPaymentId/delete', authenticate as any,
  requireDesktopWorkspaceAccess as any, requireAdmin as any, deleteRejectedPayment as any);

// Webhook endpoint for mobile money API (no auth - comes from external API)
// In production, add API key validation here
router.post('/webhook/mobile-money', receiveMobileMoneyPayment as any);

export default router;
