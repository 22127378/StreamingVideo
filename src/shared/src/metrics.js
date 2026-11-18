// Metric Prometheus dùng chung. Mỗi service có registry riêng, nhãn service=<tên> để phân biệt
// trong Prometheus. /metrics không ra internet: ALB chỉ chuyển /api/* tới pod.
import client from 'prom-client';

export { client };

/**
 * @param {string} service tên service, thành nhãn mặc định của mọi metric
 * @returns {{ client: typeof client, registry: client.Registry, httpRequestDuration: client.Histogram, handler: Function }}
 */
export function createMetrics(service) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry, prefix: 'streamforge_' });

  const httpRequestDuration = new client.Histogram({
    name: 'streamforge_http_request_duration_seconds',
    help: 'HTTP request duration by route template, method and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  async function handler(req, res) {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  }

  return { client, registry, httpRequestDuration, handler };
}
