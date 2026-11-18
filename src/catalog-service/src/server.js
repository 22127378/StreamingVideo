// HTTP API và consumer sự kiện chạy trong cùng một process. Mỗi pod đều đọc hàng đợi; SQS chia
// message cho các pod, và xử lý idempotent nên hai pod nhận trùng một sự kiện cũng không sao.
import { consumeEvents } from '@streamforge/shared/events';
import { startServer } from '@streamforge/shared/http';
import { createApp, eventsProcessed } from './app.js';
import { config } from './config.js';
import { handleEvent } from './projector.js';
import { db, pruneProcessedEvents } from './repository.js';

const stop = new AbortController();
let consumer = Promise.resolve();

if (config.eventsQueueUrl) {
  consumer = consumeEvents({
    queueUrl: config.eventsQueueUrl,
    stopSignal: stop.signal,
    handler: async (event) => {
      const outcome = await handleEvent(event);
      eventsProcessed.inc({ type: event.type, outcome });
    },
    onResult: (type, outcome) => {
      if (outcome !== 'ok') eventsProcessed.inc({ type, outcome });
    },
  });
  // Dọn bảng processed_events mỗi giờ
  setInterval(() => pruneProcessedEvents().catch((err) => console.warn('prune failed', err.message)), 3_600_000).unref();
} else {
  console.warn('CATALOG_EVENTS_QUEUE_URL not set: not consuming events');
}

startServer(createApp(), {
  service: 'catalog',
  onShutdown: async () => {
    stop.abort();
    await consumer;
    await db.pool.end();
  },
});
