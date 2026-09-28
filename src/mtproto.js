import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createTelegramClient() {
  return new TelegramClient(
    new StringSession(config.stringSession),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5 }
  );
}

export async function latestMessageId(client, peer) {
  const msgs = await client.getMessages(peer, { limit: 1 });
  return msgs?.[0]?.id || 0;
}

export async function collectNewMessages(client, peer, afterId, {
  timeoutMs,
  stopWhen,
  quietMs = 900,
  pollMs = 450,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Map();
  let lastNewAt = Date.now();

  while (Date.now() < deadline) {
    const batch = await client.getMessages(peer, { limit: 30 });
    for (const m of batch) {
      if (m?.out) continue;
      if (m.id > afterId && !seen.has(m.id)) {
        seen.set(m.id, m);
        lastNewAt = Date.now();
      }
    }

    const ordered = [...seen.values()].sort((a, b) => a.id - b.id);
    if (stopWhen) {
      const hit = ordered.find(stopWhen);
      if (hit) return { messages: ordered, hit };
    }

    if (ordered.length && Date.now() - lastNewAt >= quietMs) {
      return { messages: ordered, hit: null };
    }
    await sleep(pollMs);
  }
  return { messages: [...seen.values()].sort((a, b) => a.id - b.id), hit: null };
}

export function messageText(m) {
  return (m?.message || '').trim();
}

export function isAudioMessage(m) {
  const doc = m?.media?.document;
  if (!doc) return false;
  if ((doc.mimeType || '').startsWith('audio/')) return true;
  const attrs = doc.attributes || [];
  return attrs.some(a => a?.className === 'DocumentAttributeAudio');
}

function randomLong() {
  const high = BigInt(Math.floor(Math.random() * 0x7fffffff));
  const low = BigInt(Math.floor(Math.random() * 0xffffffff));
  return (high << 32n) | low;
}

export async function forwardHiddenToOurBot(client, sourcePeer, messageId) {
  return forwardHiddenManyToOurBot(client, sourcePeer, [messageId]);
}

export async function forwardHiddenManyToOurBot(client, sourcePeer, messageIds = []) {
  const ids = (messageIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return null;

  const fromPeer = await client.getInputEntity(sourcePeer);
  const toPeer = await client.getInputEntity(config.botUsername);

  return client.invoke(new Api.messages.ForwardMessages({
    fromPeer,
    id: ids,
    randomId: ids.map(() => randomLong()),
    toPeer,
    dropAuthor: true,
    dropMediaCaptions: true,
  }));
}
