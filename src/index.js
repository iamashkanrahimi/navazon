import http from 'node:http';
import { config } from './config.js';
import { bot, catalog, db, deepCatalog, tg } from './runtime.js';
import { handleUpdate } from './updates.js';
import { sourceQueue } from './jobs.js';
import { getState, setState, getStats } from './state.js';

const startedAt = Date.now();
await setState('service_started_at',{ at: startedAt });

function authorized(req, token) {
  return req.headers.authorization === `Bearer ${token}`;
}

async function queueCrawler() {
  if (!config.discoveryEnabled) return { queued: false, reason: 'disabled' };
  if (!sourceQueue.isIdle()) return { queued: false, reason: 'source_queue_busy' };
  const state = await getState('last_user_activity_at',{ at: startedAt });
  const lastAt = Number(state?.at || startedAt);
  const idleForMs = Date.now() - lastAt;
  if (idleForMs < config.discoveryIdleMs) return { queued: false, reason: 'user_active', idleForMs };

  await deepCatalog.enqueueFeedSweep();
  await deepCatalog.compactQueue();
  const deepTask = await deepCatalog.claimNextTask();
  if (deepTask) {
    sourceQueue.push({ type: 'deep_crawl', task: deepTask });
    return {
      queued: true,
      type: 'deep',
      taskKind: deepTask.kind,
      taskId: deepTask.id,
    };
  }

  // Legacy discovery remains as a low-priority safety net if the deep queue is empty.
  const candidate = await catalog.nextDiscoveryCandidate(config.discoveryArtistMinAgeMs);
  if (candidate) {
    sourceQueue.push({ type: 'discover', candidate });
    return { queued: true, type: 'artist', artist: candidate.artist };
  }

  const lastBootstrap = await getState('last_bootstrap_v2_at',{ at: 0 });
  if (Date.now() - Number(lastBootstrap?.at || 0) < 6 * 60 * 60 * 1000) {
    return { queued: false, reason: 'no_candidate' };
  }
  sourceQueue.push({ type: 'discover_bootstrap' });
  return { queued: true, type: 'bootstrap' };
}

async function readJson(req) {
  const chunks=[]; let total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('request too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url || '/',`http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      await db.query('SELECT 1');
      res.writeHead(200,{ 'content-type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, sourceQueue:sourceQueue.size(), mtproto:true }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) {
        res.writeHead(403).end('forbidden'); return;
      }
      const update = await readJson(req);
      res.writeHead(200,{ 'content-type':'text/plain' }); res.end('ok');
      handleUpdate(update).catch(err => console.error('[update]',err));
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/crawler') {
      if (!authorized(req,config.crawlerToken)) { res.writeHead(401).end('unauthorized'); return; }
      const result = await queueCrawler();
      res.writeHead(200,{ 'content-type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, ...result })); return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/stats') {
      if (!authorized(req,config.adminToken)) { res.writeHead(401).end('unauthorized'); return; }
      res.writeHead(200,{ 'content-type':'application/json; charset=utf-8' });
      res.end(JSON.stringify(await getStats(),null,2)); return;
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    console.error('[http]',err.message);
    if (!res.headersSent) res.writeHead(500,{ 'content-type':'application/json' });
    res.end(JSON.stringify({ ok:false, error:'internal_error' }));
  }
});

server.listen(config.port,'0.0.0.0',async () => {
  console.log(`Navazon Cloud listening on 0.0.0.0:${config.port}`);
  if (!config.publicBaseUrl) {
    console.warn('RENDER_EXTERNAL_URL/PUBLIC_BASE_URL missing; Telegram webhook not changed.');
    return;
  }
  try {
    const webhookUrl = `${config.publicBaseUrl}/telegram/webhook`;
    await bot.setWebhook(webhookUrl,config.webhookSecret);
    console.log(`Telegram webhook ready: ${webhookUrl}`);
  } catch (err) { console.error('[setWebhook]',err.message); }
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down...`);
  server.close();
  try { await tg.disconnect(); } catch {}
  try { await db.end(); } catch {}
  process.exit(0);
}
process.once('SIGTERM',() => shutdown('SIGTERM'));
process.once('SIGINT',() => shutdown('SIGINT'));
