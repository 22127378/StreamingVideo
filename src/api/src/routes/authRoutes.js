import { Router } from 'express';
import { issuePlaybackToken, verifyPlaybackAccess } from '../controllers/authController.js';

const router = Router();

router.post('/playback-token', issuePlaybackToken);
router.post('/verify-playback', verifyPlaybackAccess);

export default router;
