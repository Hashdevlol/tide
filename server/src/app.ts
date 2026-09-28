import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { config } from './config.ts';
import { Orchestrator } from './orchestrator.ts';
import { createApi } from './api.ts';

export interface TideServer { http: HttpServer; io: Server; orch: Orchestrator; close(): Promise<void> }

export function createTideServer(): TideServer {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  const http = createServer(app);
  const io = new Server(http, { cors: { origin: '*' }, maxHttpBufferSize: 4e6, pingInterval: 20_000, pingTimeout: 25_000 });
  const orch = new Orchestrator(io);

  app.use(createApi(orch));

  // Serve the built web app (production). In dev, Vite serves it and proxies here.
  if (existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get(/^\/(?!api\/|v1\/|socket\.io\/).*/, (_req, res) => res.sendFile(join(config.webDist, 'index.html')));
  }

  return {
    http, io, orch,
    close: () => new Promise((resolve) => { orch.stop(); io.close(); http.close(() => resolve()); }),
  };
}
