import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate, requireAdmin } from '../middleware/auth';
import { authValidation as newAuthValidation } from '../middleware/validation.middleware';
import { adminPinLoginLimiter, loginLimiter } from '../middleware/security.middleware';
import { upload } from '../config/multer';

const router = Router();

// Public routes with validation
router.post('/register', newAuthValidation.register, authController.register as any);
router.post('/login', loginLimiter, newAuthValidation.login, authController.login as any);
router.post('/verify-admin-pin', adminPinLoginLimiter, authController.verifyAdminPin as any);
router.post('/request-admin-pin-reset', adminPinLoginLimiter, authController.requestAdminPinReset as any);
router.post('/forgot-password', newAuthValidation.forgotPassword, authController.forgotPassword as any);

// Protected routes
router.get('/me', authenticate as any, authController.getMe as any);
router.put('/profile', authenticate as any, authController.updateProfile as any);
router.post('/profile-picture', authenticate as any, upload.single('profilePicture'), authController.uploadProfilePicture as any);
router.post('/session-timeout', authenticate as any, authController.updateSessionTimeout as any);
router.post('/change-password', authenticate as any, authController.changePassword as any);
router.put('/admin-pin/settings', authenticate as any, requireAdmin as any, authController.updateAdminPinSettings as any);
router.post('/admin-pin/request-disable', authenticate as any, requireAdmin as any, authController.requestAdminPinReset as any);

export default router;
