// Metric Prometheus của API, phục vụ ở GET /metrics (Prometheus scrape qua ServiceMonitor).
// /metrics không ra internet: ALB chỉ chuyển /api/* tới pod.
import client from 'prom-client';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'api' });
client.collectDefaultMetrics({ register: registry, prefix: 'streamforge_' });

export const httpRequestDuration = new client.Histogram({
  name: 'streamforge_http_request_duration_seconds',
  help: 'API request duration by route template, method and status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const uploadsCreated = new client.Counter({
  name: 'streamforge_uploads_created_total',
  help: 'Presigned upload URLs issued',
  registers: [registry],
});

export const playbackDecisions = new client.Counter({
  name: 'streamforge_playback_decisions_total',
  help: 'Playback requests by result (allowed, denied_tier, not_ready, not_found)',
  labelNames: ['result', 'video_tier', 'user_tier'],
  registers: [registry],
});

export async function metricsHandler(req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
