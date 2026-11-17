// Metric Prometheus của worker, phục vụ ở http://<pod>:9464/metrics (Prometheus scrape qua PodMonitor).
import http from 'node:http';
import client from 'prom-client';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'worker' });
client.collectDefaultMetrics({ register: registry, prefix: 'streamforge_' });

export const transcodeJobs = new client.Counter({
  name: 'streamforge_transcode_jobs_total',
  help: 'Transcode jobs by outcome (done, retry, failed, rejected, released, skipped, invalid)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const transcodeDuration = new client.Histogram({
  name: 'streamforge_transcode_duration_seconds',
  help: 'Wall time of successful transcode jobs (download, ffmpeg, upload)',
  buckets: [5, 10, 20, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

export const transcodeInProgress = new client.Gauge({
  name: 'streamforge_transcode_in_progress',
  help: 'Jobs currently being transcoded by this worker',
  registers: [registry],
});

/** Bắt đầu HTTP server cho /metrics. Trả về server để đóng khi worker tắt. */
export function startMetricsServer(port = parseInt(process.env.METRICS_PORT || '9464', 10)) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  server.unref();
  return server;
}
