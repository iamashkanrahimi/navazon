import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inboxes = new WeakMap();

function peerKey(value = '') {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

function messageSenderId(message, event = null) {
  return String(message?.senderId || event?.chatId || '');
}

function trimBuffer(items = [], max = 300) {
  return items.length > max ? items.slice(items.length - max) : items;
}

export function installTelegramInbox(client) {
  const existing = inboxes.get(client);
  if (existing) return existing;

  const state = {
    buffers: new Map(),
    peerIds: new Map(),
    waiters: new Set(),
  };

  const dispatch = event => {
    const message = event?.message;
    if (!message || message.out) return;

    const senderId = messageSenderId(message, event);
    if (!senderId) return;

    const current = state.buffers.get(senderId) || [];
    current.push(message);
    state.buffers.set(senderId, trimBuffer(current));

    for (const waiter of [...state.waiters]) {
      if (waiter.peerId !== senderId) continue;
      waiter.push(message);
    }
  };

  client.addEventHandler(dispatch, new NewMessage({}));
  state.dispatch = dispatch;
  inboxes.set(client, state);
  return state;
}

async function resolveInboxPeerId(client, peer) {
  const state = inboxes.get(client);
  if (!state) return null;

  const key = peerKey(peer);
  if (state.peerIds.has(key)) return state.peerIds.get(key);

  const input = await client.getInputEntity(peer);
  const resolved = String(await client.getPeerId(input));
  state.peerIds.set(key, resolved);
  return resolved;
}

function orderedMessages(seen) {
  return [...seen.values()].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

function evaluateCollector(seen, { stopWhen, stopWhenBatch } = {}) {
  const ordered = orderedMessages(seen);
  if (stopWhen) {
    const hit = ordered.find(stopWhen);
    if (hit) return { done: true, messages: ordered, hit };
  }
  if (stopWhenBatch && stopWhenBatch(ordered)) {
    return { done: true, messages: ordered, hit: null };
  }
  return { done: false, messages: ordered, hit: null };
}

async function collectFromInbox(client, peer, afterId, {
  timeoutMs,
  stopWhen,
  stopWhenBatch,
  quietMs = 900,
  onMessage,
} = {}) {
  const state = inboxes.get(client);
  if (!state) return null;

  const peerId = await resolveInboxPeerId(client, peer);
  if (!peerId) return null;

  const seen = new Map();
  for (const message of state.buffers.get(peerId) || []) {
    if (!message?.out && Number(message.id || 0) > Number(afterId || 0)) {
      seen.set(message.id, message);
    }
  }

  return new Promise(resolve => {
    let settled = false;
    let quietTimer = null;
    let totalTimer = null;

    const finish = (messages = orderedMessages(seen), hit = null) => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (totalTimer) clearTimeout(totalTimer);
      state.waiters.delete(waiter);
      resolve({ messages, hit });
    };

    const scheduleQuiet = () => {
      if (!seen.size || !(quietMs >= 0)) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), Math.max(0, quietMs));
    };

    const check = () => {
      const result = evaluateCollector(seen, { stopWhen, stopWhenBatch });
      if (result.done) {
        finish(result.messages, result.hit);
        return true;
      }
      scheduleQuiet();
      return false;
    };

    const waiter = {
      peerId,
      push(message) {
        if (settled || message?.out) return;
        if (Number(message.id || 0) <= Number(afterId || 0)) return;
        if (seen.has(message.id)) return;

        seen.set(message.id, message);
        if (typeof onMessage === 'function') {
          Promise.resolve(onMessage(message)).catch(err =>
            console.warn('[mtproto inbox onMessage]', err.message)
          );
        }
        check();
      },
    };

    state.waiters.add(waiter);

    // Close the tiny race between the initial buffer snapshot and waiter
    // registration by replaying the current peer buffer once more.
    for (const message of state.buffers.get(peerId) || []) {
      waiter.push(message);
    }

    totalTimer = setTimeout(
      () => finish(),
      Math.max(1, Number(timeoutMs || config.searchTimeoutMs || 18000))
    );

    // Messages may have arrived between latestMessageId() and waiter creation.
    const initial = evaluateCollector(seen, { stopWhen, stopWhenBatch });
    if (initial.done) finish(initial.messages, initial.hit);
    else scheduleQuiet();
  });
}

async function collectByPolling(client, peer, afterId, {
  timeoutMs,
  stopWhen,
  stopWhenBatch,
  quietMs = 900,
  pollMs = 450,
  onMessage,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Map();
  let lastNewAt = Date.now();

  while (Date.now() < deadline) {
    const batch = await client.getMessages(peer, { limit: 100 });
    for (const m of batch) {
      if (m?.out) continue;
      if (m.id > afterId && !seen.has(m.id)) {
        seen.set(m.id, m);
        lastNewAt = Date.now();
        if (typeof onMessage === 'function') {
          await onMessage(m);
        }
      }
    }

    const result = evaluateCollector(seen, { stopWhen, stopWhenBatch });
    if (result.done) return { messages: result.messages, hit: result.hit };

    if (result.messages.length && Date.now() - lastNewAt >= quietMs) {
      return { messages: result.messages, hit: null };
    }
    await sleep(pollMs);
  }
  return { messages: orderedMessages(seen), hit: null };
}

export function createTelegramClient() {
  return new TelegramClient(
    new StringSession(config.stringSession),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5 }
  );
}

export async function latestMessageId(client, peer) {
  const state = inboxes.get(client);
  if (state) {
    const peerId = await resolveInboxPeerId(client, peer);
    const buffered = state.buffers.get(peerId) || [];
    return buffered.reduce(
      (max, message) => Math.max(max, Number(message?.id || 0)),
      0
    );
  }

  const msgs = await client.getMessages(peer, { limit: 1 });
  return msgs?.[0]?.id || 0;
}

export async function collectNewMessages(client, peer, afterId, options = {}) {
  if (inboxes.has(client)) {
    return collectFromInbox(client, peer, afterId, options);
  }
  return collectByPolling(client, peer, afterId, options);
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
