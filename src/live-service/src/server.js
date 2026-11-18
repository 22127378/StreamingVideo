import { startServer } from '@streamforge/shared/http';
import { createApp } from './app.js';
import { config } from './config.js';
import { db, pruneMessages } from './repository.js';

// Xoá bình luận cũ mỗi giờ (mọi pod đều chạy; DELETE lặp lại không sao)
setInterval(
  () =>
    pruneMessages(config.chatRetentionDays)
      .then((n) => n && console.log(`[live] pruned ${n} old chat messages`))
      .catch((err) => console.warn('[live] prune failed', err.message)),
  3_600_000
).unref();

startServer(createApp(), {
  service: 'live',
  onShutdown: async () => {
    await db.pool.end();
  },
});
