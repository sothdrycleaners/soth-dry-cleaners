import { Router, Response, NextFunction } from 'express';
import { AuthRequest, authenticate } from '../middleware/auth';
import * as controller from '../controllers/operations.controller';
import * as messaging from '../controllers/operationsMessaging.controller';

const router = Router();
const requireStaffMessaging = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!['ADMIN', 'MANAGER', 'OPERATIONS', 'DESKTOP_AGENT'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff messaging is not available for this account' });
  }
  next();
};
const requireOperationsAccess = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const allowed = ['ADMIN', 'MANAGER', 'OPERATIONS'].includes(req.user.role) ||
    (req.user.role === 'DESKTOP_AGENT' && !!req.user.operations_access_enabled);
  if (!allowed) return res.status(403).json({ error: 'Operations access is not enabled' });
  next();
};

router.use(authenticate as any);
router.get('/unread-count', requireStaffMessaging as any, messaging.getStaffMessageUnreadCount as any);
router.get('/contacts', requireStaffMessaging as any, messaging.getMessagingContacts as any);
router.get('/conversations/:peerId', requireStaffMessaging as any, messaging.getStaffConversation as any);
router.post('/direct-messages', requireStaffMessaging as any, messaging.sendStaffMessage as any);
router.patch('/direct-messages/:messageId', requireStaffMessaging as any, messaging.editStaffMessage as any);
router.delete('/direct-messages/:messageId', requireStaffMessaging as any, messaging.unsendStaffMessage as any);

router.use(requireOperationsAccess as any);
router.get('/summary', controller.getOperationsSummary as any);
router.get('/branches', controller.getOperationsBranches as any);
router.get('/queue', controller.getOperationsQueue as any);
router.get('/ready-items', controller.getOperationsReadyItems as any);
router.get('/delivered', controller.getOperationsDelivered as any);
router.get('/messages', controller.getOperationsMessages as any);
router.post('/messages', controller.sendOperationsMessage as any);
router.put('/items/:itemId/status', controller.updateOperationsItem as any);
router.put('/orders/:orderId/ready', controller.markOperationsOrderReady as any);
router.put('/items/:itemId/note', controller.updateOperationsItemNote as any);
export default router;
