import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = readline.createInterface({ input, output });

async function ask(label, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

try {
  const apiIdRaw = process.env.TG_API_ID?.trim()
    || await ask('Telegram API ID');
  const apiHash = process.env.TG_API_HASH?.trim()
    || await ask('Telegram API Hash');

  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('Telegram API ID must be a valid number.');
  }
  if (!apiHash) {
    throw new Error('Telegram API Hash is required.');
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask('Third account phone number (+...)'),
    phoneCode: async () => await ask('Telegram login code'),
    password: async () => await ask('2FA password (if enabled)'),
    onError: err => console.error('[telegram login]', err?.message || err),
  });

  const me = await client.getMe();

  console.log('\n=== COPY THESE INTO RENDER ===');
  console.log(`PROXY_USER_ID_3=${me.id.toString()}`);
  console.log(`TG_STRING_SESSION_3=${client.session.save()}`);
  console.log('================================\n');
  console.log('Do not send TG_STRING_SESSION_3 in chat. Store it only as a secret environment variable.');

  await client.disconnect();
} finally {
  rl.close();
}
