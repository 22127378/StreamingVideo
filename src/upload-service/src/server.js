import { startServer } from '@streamforge/shared/http';
import { createApp } from './app.js';
import { db } from './repository.js';

startServer(createApp(), { service: 'upload', onShutdown: () => db.pool.end() });
