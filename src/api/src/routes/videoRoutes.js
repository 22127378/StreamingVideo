import { Router } from 'express';
import {
  requestUploadUrl,
  completeUpload,
  listVideos,
  getVideo,
  deleteVideo,
} from '../controllers/videoController.js';

const router = Router();

// Routes
router.post('/upload-url', requestUploadUrl);
router.post('/complete', completeUpload);
router.get('/', listVideos);
router.get('/:id', getVideo);
router.delete('/:id', deleteVideo);

export default router;
