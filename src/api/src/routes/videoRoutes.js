import { Router } from 'express';
import {
  requestUploadUrl,
  completeUpload,
  listVideos,
  getVideo,
  deleteVideo,
  startPlayback,
} from '../controllers/videoController.js';
import { requireAuth } from '../middlewares/auth.js';

const router = Router();

// Xem danh sách và chi tiết không cần đăng nhập
router.get('/', listVideos);
router.get('/:id', getVideo);

// Upload, xoá và phát cần đăng nhập
router.post('/upload-url', requireAuth, requestUploadUrl);
router.post('/complete', requireAuth, completeUpload);
router.post('/:id/playback', requireAuth, startPlayback);
router.delete('/:id', requireAuth, deleteVideo);

export default router;
