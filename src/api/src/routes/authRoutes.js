import { Router } from 'express';
import { devLogin, getAuthConfig, getMe, upgrade } from '../controllers/authController.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

router.get('/config', getAuthConfig);
router.post('/dev-login', devLogin);
router.get('/me', requireAuth, getMe);
router.post('/upgrade', requireAuth, upgrade);

export default router;
