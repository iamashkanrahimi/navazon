import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = readline.createInterface({ input, output });
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH?.trim();

if (!apiId || !apiHash) {
  throw new Error('Put TG_API_ID and TG_API_HASH in .env first.');
}

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => (await rl.question('Proxy phone number (+...): ')).trim(),
  phoneCode: async () => (await rl.question('Telegram login code: ')).trim(),
  password: async () => (await rl.question('2FA password (if enabled): ')).trim(),
  onError: err => console.error(err),
});

const me = await client.getMe();
console.log('\n=== COPY THESE INTO .env ===');
console.log(`PROXY_USER_ID=${me.id.toString()}`);
console.log(`TG_STRING_SESSION=${client.session.save()}`);
console.log('=============================\n');
console.log('Keep TG_STRING_SESSION secret. Anyone who has it may be able to access this Telegram session.');

await client.disconnect();
rl.close();
