import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

/** Bounded fixed-window limiter, local to this single-process application. */
export class RequestLimits {
  private buckets = new Map<string, { count: number; until: number }>();
  take(key: string, max: number, windowMs: number, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 10000) {
        for (const [k, b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
        if (this.buckets.size >= 10000) return Math.ceil(windowMs / 1000);
      }
      bucket = { count: 0, until: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count > max ? Math.max(1, Math.ceil((bucket.until - now) / 1000)) : 0;
  }
}

export function registerSecurity(app: FastifyInstance, config: Config): void {
  const limits = new RequestLimits();
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    if (!req.url.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store, private').header('pragma', 'no-cache').header('vary', 'Cookie');
    const path = req.url.split('?')[0];
    if (path === '/api/v1/health') return;
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers.origin;
    const expectedOrigin = config.publicOrigin ?? `${req.protocol}://${req.headers.host}`;
    if (['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'])) || (mutation && (
      req.headers['x-sentinel-request'] !== '1' ||
      (origin !== undefined && origin !== expectedOrigin) ||
      (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
    ))) {
      return reply.code(403).send({ error: 'Request origin could not be verified. Reload this page and try again.' });
    }
    let retry = limits.take(`ip:${req.ip}`, 600, 60_000);
    if (path === '/api/v1/auth/login') {
      retry = Math.max(retry, limits.take(`login:${req.ip}`, 10, 5 * 60_000), limits.take('login:total', 120, 60_000));
    }
    if (retry) return reply.header('retry-after', retry).code(429).send({ error: 'Too many requests. Please wait before trying again.' });
  });
  app.addHook('preHandler', async (req, reply) => {
    if (!req.sessionUser || !req.url.startsWith('/api/')) return;
    const heavy = req.method === 'POST' && /^\/api\/v1\/(plates|reports)\//.test(req.url);
    const retry = heavy
      ? Math.max(limits.take(`heavy:${req.sessionUser.sessionId}`, 12, 60_000), limits.take('heavy:total', 120, 60_000))
      : limits.take(`session:${req.sessionUser.sessionId}`, 240, 60_000);
    if (retry) return reply.header('retry-after', retry).code(429).send({ error: 'Please wait a moment before running another analysis or request.' });
  });
}
