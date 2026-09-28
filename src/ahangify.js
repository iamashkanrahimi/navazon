import { config } from './config.js';
import {
  collectNewMessages,
  isAudioMessage,
  latestMessageId,
  messageText,
} from './mtproto.js';

function cleanText(value = '') {
  return String(value)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSize(value) {
  if (!value) return undefined;
  return cleanText(value).replace(/\s+/g, '');
}

export function parseAhangifyResults(messages) {
  const results = [];

  for (const message of messages) {
    const text = messageText(message);
    if (!text) continue;

    const normalized = text.replace(/[\u200e\u200f\u202a-\u202e]/g, '');
    const starts = [...normalized.matchAll(/^(?:🎯\s*)?(\d+)\.\s*([^\n]+)/gm)];

    for (let i = 0; i < starts.length; i++) {
      const current = starts[i];
      const next = starts[i + 1];
      const blockStart = current.index;
      const blockEnd = next ? next.index : normalized.length;
      const block = normalized.slice(blockStart, blockEnd);

      const download = block.match(/\/dl_[A-Za-z0-9_-]+/);
      if (!download) continue;

      const duration = block.match(/🕒\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/)?.[1];
      const size = block.match(/💾\s*([0-9]+(?:\.[0-9]+)?\s*(?:KB|MB|GB))/i)?.[1];
      const bitrate = block.match(/📀\s*(\d{2,4})/)?.[1];

      results.push({
        rank: Number(current[1]),
        title: cleanText(current[2]),
        cmd: download[0],
        duration,
        size: normalizeSize(size),
        bitrate: bitrate ? Number(bitrate) : undefined,
        message,
      });
    }
  }

  const seenCommands = new Set();
  return results
    .filter(item => {
      if (seenCommands.has(item.cmd)) return false;
      seenCommands.add(item.cmd);
      return true;
    })
    .sort((a, b) => a.rank - b.rank);
}

export async function searchAhangify(client, query) {
  const peer = config.ahangifyUsername;
  const beforeSearch = await latestMessageId(client, peer);

  await client.sendMessage(peer, { message: query });

  const search = await collectNewMessages(client, peer, beforeSearch, {
    timeoutMs: config.searchTimeoutMs,
    quietMs: 1000,
  });

  const candidates = parseAhangifyResults(search.messages);
  if (candidates.length) return candidates;

  const combined = search.messages.map(messageText).filter(Boolean).join('\n');
  throw new Error(
    `Ahangify search returned no usable result. Last response: ${combined.slice(0, 500)}`
  );
}

export async function downloadAhangifyResult(client, candidate) {
  const peer = config.ahangifyUsername;
  const beforeDownload = await latestMessageId(client, peer);

  await client.sendMessage(peer, { message: candidate.cmd });

  const download = await collectNewMessages(client, peer, beforeDownload, {
    timeoutMs: config.downloadTimeoutMs,
    stopWhen: message => {
      if (isAudioMessage(message)) return true;
      const text = messageText(message).toLowerCase();
      return (
        text.includes('copyright') ||
        text.includes('blocked') ||
        text.includes('کپی‌رایت')
      );
    },
    quietMs: 1500,
  });

  const audio = download.messages.find(isAudioMessage);
  if (audio) {
    return {
      source: 'ahangify',
      command: candidate.cmd,
      candidate,
      audioMessage: audio,
    };
  }

  const responseText = download.messages.map(messageText).filter(Boolean).join('\n');

  if (/copyright|blocked|کپی.?رایت/i.test(responseText)) {
    throw new Error('این نسخه در دسترس نیست.');
  }

  if (/عضو|کانال|join/i.test(responseText)) {
    throw new Error('اکانت واسط نیاز به تأیید عضویت Ahangify دارد.');
  }

  throw new Error('فایل در زمان مقرر دریافت نشد.');
}
