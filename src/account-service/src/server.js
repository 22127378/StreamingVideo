import { startServer } from '@streamforge/shared/http';
import { createApp } from './app.js';

startServer(createApp(), { service: 'account' });
