import { config } from './config.js';
import { BotApi } from './botApi.js';
import { BridgeInbox } from './bridge.js';
import { FileCache } from './cache.js';
import { CatalogStore } from './catalog.js';
import { FollowStore } from './follows.js';
import { SessionStore } from './sessions.js';
import { DeepCatalog } from './deepCatalog.js';
import { initDb, db } from './db.js';
import {
  createTelegramClient,
  installTelegramInbox,
  primeTelegramInboxBoundary,
} from './mtproto.js';

await initDb();

export const bot = new BotApi(config.botToken);
export const bridge = new BridgeInbox(config.proxyUserId);
export const cache = new FileCache();
export const catalog = new CatalogStore();
export const follows = new FollowStore();
export const sessions = new SessionStore();
export const deepCatalog = new DeepCatalog();
export const tg = createTelegramClient();
export let tg2 = null;

await tg.connect();
if (!(await tg.checkAuthorization())) throw new Error('Proxy Telegram session is not authorized');
installTelegramInbox(tg);
for (const peer of [config.melobotUsername, config.ahangifyUsername]) {
  try {
    await primeTelegramInboxBoundary(tg, peer);
  } catch (err) {
    console.warn('[mtproto prime boundary]', peer, err.message);
  }
}

console.log('Proxy MTProto connected.');

if (config.stringSession2 && config.proxyUserId2) {
  try {
    const second = createTelegramClient(config.stringSession2);
    await second.connect();
    if (!(await second.checkAuthorization())) {
      throw new Error('Second Telegram session is not authorized');
    }
    tg2 = second;
    console.log('Second proxy MTProto connected.');
  } catch (err) {
    tg2 = null;
    console.error('[second proxy mtproto]', err?.message || err);
  }
}

console.log(`Primary source: @${config.melobotUsername} (Premium/HQ)`);
console.log(`Fallback source: @${config.ahangifyUsername}`);
console.log(`Delivery bot: @${config.botUsername}`);

export { db };
