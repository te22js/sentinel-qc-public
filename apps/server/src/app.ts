/** Fastify app assembly, separated from the listener so tests can use inject(). */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { OpenedDb } from '@sentinel/db';
import type { Config } from './config.js';
import { SESSION_COOKIE, lookupSession, cleanWorkspaces, type SessionUser } from './auth.js';
import { registerRoutes } from './routes.js';
import { authorizeWorkspace } from './workspace.js';
import { registerSecurity } from './security.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}

export async function buildApp(config: Config, opened: OpenedDb): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024, trustProxy: 'loopback', requestTimeout: 30_000 });
  await app.register(cookie);
  registerSecurity(app, config);

  app.decorateRequest('sessionUser', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.sessionUser = token ? lookupSession(opened.sqlite, token) : null;
  });
  app.addHook('preHandler', async (req, reply) => authorizeWorkspace(opened.sqlite, req, reply));

  cleanWorkspaces(opened.sqlite, config.dataDir);
  const cleanup = setInterval(() => cleanWorkspaces(opened.sqlite, config.dataDir), 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); });

  registerRoutes(app, { sqlite: opened.sqlite, config });

  // static hosting of the built web app with SPA fallback
  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error, _req, reply) => {
    const err = (error && typeof error === 'object' ? error : {}) as { code?: string; statusCode?: number; message?: string };
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return reply.code(409).send({ error: 'That name already exists in this workspace. Choose a different name.' });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Unable to complete this request. Please try again.' : err.message ?? 'Invalid request.' });
  });

  return app;
}
