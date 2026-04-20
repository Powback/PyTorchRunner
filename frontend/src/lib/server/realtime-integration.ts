/**
 * PyTorchRunner PowSync Realtime Integration
 *
 * Boots the PowSync WebSocket server + schema stack.
 * Used as an Astro integration (astro:server:setup in dev) and
 * as a lazy initializer (via ensureStarted() in middleware for production).
 *
 * Architecture:
 *   - Discovers src/schemas/ for schema files (schema.ts or index.ts)
 *   - Bundles them via esbuild to avoid Vite module runner issues
 *   - Initializes ServerStore with registered table definitions
 *   - Hydrates ServerStore from PostgreSQL (jobs, metrics, media)
 *   - Starts WebSocket server on WS_PORT (default 1239)
 *   - Attaches SyncServer to WebSocket server
 *   - Connects PubSubBridge to Redis (if REDIS_URL is set)
 *   - Exposes serverStore + router as process globals
 */

import type { AstroIntegration } from 'astro';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { createServer } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { setPowsync } from '../powsync/globals';

type ViteDevServer = any;

// Node.js-native require — bypasses Vite's module system for esbuild bundles
const _require = createRequire(path.join(process.cwd(), 'src', 'dummy.js'));

// Persist WS server across HMR reloads via globals
declare global {
  var __pytorchWss: InstanceType<typeof WebSocketServer> | undefined;
  var __pytorchHttpServer: ReturnType<typeof createServer> | undefined;
  var __pytorchCleanup: (() => Promise<void>) | undefined;
  var __pytorchInitPromise: Promise<void> | null;
}

// ============================================================================
// Schema discovery
// ============================================================================

function discoverSchemaFiles(): string[] {
  const cwd = process.cwd();
  const schemasDir = path.join(cwd, 'src', 'schemas');
  if (!fs.existsSync(schemasDir)) return [];

  const files: string[] = [];
  scanDir(schemasDir, files);
  return files;
}

function scanDir(dir: string, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = new Set(entries.map(e => e.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, out);
    } else if (entry.name === 'schema.ts') {
      out.push(full);
    } else if (entry.name === 'index.ts' && !names.has('schema.ts')) {
      out.push(full);
    }
  }
}

// ============================================================================
// Module loading via esbuild (bypasses Vite's broken SSR module runner in Docker)
// ============================================================================

async function loadViaEsbuild(schemaFiles: string[], logger: any): Promise<any> {
  const cwd = process.cwd();
  // Write cache outside node_modules/ — Node 22 refuses to strip TS inside node_modules/
  const cacheDir = path.join(cwd, '.powsync-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const srcDir = path.join(cwd, 'src');
  const tmpEntry = path.join(srcDir, '.powsync-entry.ts');

  const schemaImports = schemaFiles
    .map(f => './' + path.relative(srcDir, f).replace(/\\/g, '/'))
    .map(f => `import '${f}';`)
    .join('\n');

  // Export from the local powsync copy (resolves via node_modules/powsync → file:../../PowSync)
  fs.writeFileSync(tmpEntry, `${schemaImports}\nexport * from 'powsync/server';\n`);

  const outfile = path.join(cacheDir, `bundle-${Date.now()}.cjs`);

  let esbuild: typeof import('esbuild');
  try {
    esbuild = _require('esbuild');
  } catch {
    const fr = createRequire(path.join(cwd, 'package.json'));
    esbuild = fr('esbuild');
  }

  await esbuild.build({
    entryPoints: [tmpEntry],
    bundle: true,
    format: 'cjs',
    target: 'node18',
    platform: 'node',
    outfile,
    // Bundle powsync (TypeScript source) into the CJS output.
    // Only mark truly-compiled/native packages external so Node 22 never
    // tries to load TypeScript from node_modules/ at require() time.
    external: [
      'pg', 'pg-native', 'pg-cloudflare',
      'ws', 'ioredis', 'redis',
      'chokidar', 'esbuild',
      'node:*',
    ],
    logLevel: 'warning',
  });

  try { fs.unlinkSync(tmpEntry); } catch {}

  const mod = _require(outfile);
  delete _require.cache[_require.resolve(outfile)];
  setTimeout(() => { try { fs.unlinkSync(outfile); } catch {} }, 2000);

  return mod;
}

// ============================================================================
// PostgreSQL hydration
// ============================================================================

async function hydrateFromPostgres(serverStore: any, logger: any): Promise<void> {
  // Lazily import query to avoid circular deps — db.ts is loaded by Vite separately
  const { query } = await import('../db');

  // Hydrate jobs
  try {
    const jobsTable = serverStore.getTable('jobs');
    if (jobsTable) {
      const result = await query(
        `SELECT job_id, namespace, script, args, cwd, env_vars, job_name, tags,
                status, progress, stdout_preview, stderr_preview,
                stdout_line_count, stderr_line_count, runner_id,
                created_at, updated_at, started_at, completed_at, exit_code, error
         FROM jobs
         ORDER BY created_at DESC
         LIMIT 500`
      );
      for (const row of result.rows) {
        jobsTable.insert({
          job_id: row.job_id,
          namespace: row.namespace || 'default',
          script: row.script || '',
          args: Array.isArray(row.args) ? row.args : [],
          cwd: row.cwd || '',
          env_vars: row.env_vars || {},
          job_name: row.job_name || '',
          tags: Array.isArray(row.tags) ? row.tags : [],
          status: row.status || 'queued',
          progress: parseFloat(row.progress) || 0,
          stdout_preview: row.stdout_preview || '',
          stderr_preview: row.stderr_preview || '',
          stdout_line_count: row.stdout_line_count || 0,
          stderr_line_count: row.stderr_line_count || 0,
          runner_id: row.runner_id || '',
          created_at: row.created_at ? row.created_at.toISOString() : '',
          updated_at: row.updated_at ? row.updated_at.toISOString() : '',
          started_at: row.started_at ? row.started_at.toISOString() : '',
          completed_at: row.completed_at ? row.completed_at.toISOString() : '',
          exit_code: row.exit_code || 0,
          error: row.error || '',
        });
      }
      logger.info(`[powsync] Hydrated ${result.rows.length} job(s) from PostgreSQL`);
    }
  } catch (err: any) {
    logger.warn(`[powsync] Job hydration failed (non-critical): ${err.message}`);
  }

  // Hydrate recent metrics (only for active/recent jobs to keep store lean)
  try {
    const metricsTable = serverStore.getTable('job_metrics_scalars');
    if (metricsTable) {
      const result = await query(
        `SELECT m.id, m.job_id, m.tag, m.step, m.value, m.wall_time
         FROM job_metrics_scalars m
         JOIN jobs j ON j.job_id = m.job_id
         WHERE j.status IN ('running', 'queued')
            OR j.updated_at > NOW() - INTERVAL '1 hour'
         ORDER BY m.recorded_at DESC
         LIMIT 50000`
      );
      for (const row of result.rows) {
        metricsTable.insert({
          id: row.id,
          job_id: row.job_id,
          tag: row.tag,
          step: row.step,
          value: parseFloat(row.value),
          wall_time: parseFloat(row.wall_time) || 0,
        });
      }
      if (result.rows.length > 0) {
        logger.info(`[powsync] Hydrated ${result.rows.length} metric(s) from PostgreSQL`);
      }
    }
  } catch (err: any) {
    logger.warn(`[powsync] Metrics hydration failed (non-critical): ${err.message}`);
  }
}

// ============================================================================
// Core initialization
// ============================================================================

async function initPowsync(logger: any): Promise<void> {
  const WS_PORT = parseInt(process.env.WS_PORT || '1239', 10);

  // Tear down previous instance (HMR)
  if (global.__pytorchCleanup) {
    logger.info('[powsync] Cleaning up previous instance...');
    await global.__pytorchCleanup();
    global.__pytorchCleanup = undefined;
  }
  if (global.__pytorchWss) {
    await new Promise<void>(r => { global.__pytorchWss!.close(() => r()); });
    global.__pytorchWss = undefined;
  }
  if (global.__pytorchHttpServer) {
    await new Promise<void>(r => { global.__pytorchHttpServer!.close(() => r()); });
    global.__pytorchHttpServer = undefined;
    await new Promise(r => setTimeout(r, 100));
  }

  const schemaFiles = discoverSchemaFiles();
  logger.info(`[powsync] Found ${schemaFiles.length} schema file(s)`);

  logger.info('[powsync] Loading server modules via esbuild...');
  const powsync = await loadViaEsbuild(schemaFiles, logger);

  const {
    serverStore, SyncServer, ReducerRouter,
    tableRegistry, reducerRegistry,
    initRedis, closeRedis, PubSubBridge,
  } = powsync;

  logger.info(`[powsync] ${tableRegistry.size} tables, ${reducerRegistry.size} reducers`);

  // Initialize ServerStore
  logger.info('[powsync] Initializing ServerStore...');
  await serverStore.init();
  logger.info('[powsync] ServerStore initialized');

  // Hydrate from PostgreSQL
  await hydrateFromPostgres(serverStore, logger);

  // Optional Redis pub/sub
  let pubsub: any = null;
  if (process.env.REDIS_URL) {
    try {
      logger.info('[powsync] Connecting to Redis...');
      await initRedis();
      pubsub = new PubSubBridge();
      await pubsub.start();
      logger.info('[powsync] Redis PubSub connected');
    } catch (err: any) {
      logger.warn(`[powsync] Redis unavailable (non-critical): ${err.message}`);
    }
  }

  // Create WebSocket HTTP server (separate from Astro's HTTP server)
  const httpServer = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required — use WebSocket');
  });
  global.__pytorchHttpServer = httpServer;

  const wss = new WebSocketServer({ noServer: true });
  global.__pytorchWss = wss;

  // Handle WebSocket upgrade
  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  httpServer.listen(WS_PORT, '0.0.0.0', () => {
    logger.info(`[powsync] WebSocket server listening on port ${WS_PORT}`);
  });

  // Create ReducerRouter + expose globally
  const router = new ReducerRouter(serverStore);
  setPowsync('serverStore', serverStore);
  setPowsync('router', router);

  // Attach SyncServer to WebSocket server
  const syncServer = new SyncServer({
    store: serverStore,
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map((s: string) => s.trim()),
    trustProxy: false,
  });
  syncServer.attach(wss);

  global.__pytorchCleanup = async () => {
    syncServer.destroy();
    if (pubsub) pubsub.stop();
    await serverStore.stop();
    if (process.env.REDIS_URL) await closeRedis().catch(() => {});
  };

  logger.info('[powsync] Ready — reactive subscriptions active');
}

// ============================================================================
// Singleton guard — safe for both dev HMR and production middleware
// ============================================================================

const consoleLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * Ensure the WS server is started exactly once.
 * Safe to call from Astro integration OR from middleware.
 */
export function ensureStarted(logger = consoleLogger): Promise<void> {
  if (!global.__pytorchInitPromise) {
    global.__pytorchInitPromise = initPowsync(logger).catch(err => {
      console.error('[powsync] Init failed:', err);
      global.__pytorchInitPromise = null; // Allow retry on next call
    });
  }
  return global.__pytorchInitPromise!;
}

// ============================================================================
// Astro Integration (dev mode — astro:server:setup gives us the Vite server)
// ============================================================================

export function realtimeIntegration(): AstroIntegration {
  return {
    name: 'powsync-pytorch-realtime',
    hooks: {
      'astro:config:setup': ({ updateConfig }: any) => {
        // Exclude schemas dir from Vite's watcher (we manage it via esbuild)
        updateConfig({
          vite: {
            server: {
              watch: { ignored: ['**/src/schemas/**'] },
            },
          },
        });
      },

      'astro:server:setup': async ({ server, logger }: any) => {
        // Dev mode: start WS server before Vite finishes
        await ensureStarted(logger);
      },

      'astro:server:done': async () => {
        if (global.__pytorchCleanup) {
          await global.__pytorchCleanup();
          global.__pytorchCleanup = undefined;
        }
        if (global.__pytorchWss) {
          global.__pytorchWss.close();
          global.__pytorchWss = undefined;
        }
        if (global.__pytorchHttpServer) {
          global.__pytorchHttpServer.close();
          global.__pytorchHttpServer = undefined;
        }
        global.__pytorchInitPromise = null;
      },
    },
  };
}

export default realtimeIntegration;
