import { config } from './config.js';
import { BotApi } from './botApi.js';
import { BridgeInbox } from './bridge.js';
import { FileCache } from './cache.js';
import { CatalogStore } from './catalog.js';
import { FollowStore } from './follows.js';
import { SessionStore } from './sessions.js';
import { initDb, db } from './db.js';
import { createTelegramClient } from './mtproto.js';

await initDb();

export const bot = new BotApi(config.botToken);
export const bridge = new BridgeInbox(config.proxyUserId);
export const cache = new FileCache();
export const catalog = new CatalogStore();
export const follows = new FollowStore();
export const sessions = new SessionStore();
export const tg = createTelegramClient();

await tg.connect();
if (!(await tg.checkAuthorization())) throw new Error('Proxy Telegram session is not authorized');

console.log('Proxy MTProto connected.');
console.log(`Primary source: @${config.melobotUsername} (Premium/HQ)`);
console.log(`Fallback source: @${config.ahangifyUsername}`);
console.log(`Delivery bot: @${config.botUsername}`);

export { db };
