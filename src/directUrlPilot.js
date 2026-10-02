import { bot } from './runtime.js';
import { config } from './config.js';
import { getState, setState } from './state.js';

const PILOT_KEY = 'direct_url_telegram_pilot_v1';
const TEST_URL = 'https://host2.rj-mw1.com/media/mp3/mp3-320/Sogand-Gole-Sangam.mp3';

function compactAudio(message = {}) {
  const audio = message?.audio || null;
  return {
    messageId: message?.message_id || null,
    fileId: audio?.file_id || null,
    fileUniqueId: audio?.file_unique_id || null,
    fileSize: audio?.file_size || null,
    duration: audio?.duration || null,
    title: audio?.title || null,
    performer: audio?.performer || null,
  };
}

export async function runDirectUrlTelegramPilot() {
  const previous = await getState(PILOT_KEY, null);
  if (previous?.status === 'success' && previous?.url === TEST_URL && previous?.reusable === true) {
    console.log('[direct url pilot] skipped; already verified');
    return previous;
  }

  const startedAt = Date.now();
  await setState(PILOT_KEY, {
    status: 'running',
    url: TEST_URL,
    startedAt,
  });

  let first = null;
  let second = null;
  try {
    first = await bot.sendAudio(config.proxyUserId, TEST_URL, {
      title: 'Gole Sangam',
      performer: 'Sogand',
    });
    const firstAudio = compactAudio(first);
    if (!firstAudio.fileId) throw new Error('Telegram URL send returned no audio.file_id');

    second = await bot.sendAudio(config.proxyUserId, firstAudio.fileId, {
      title: 'Gole Sangam',
      performer: 'Sogand',
    });
    const secondAudio = compactAudio(second);
    if (!secondAudio.fileId) throw new Error('Telegram file_id resend returned no audio.file_id');

    const result = {
      status: 'success',
      url: TEST_URL,
      reusable: true,
      sameFileId: firstAudio.fileId === secondAudio.fileId,
      first: firstAudio,
      second: secondAudio,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
    };
    await setState(PILOT_KEY, result);
    console.log('[direct url pilot] success', JSON.stringify(result));

    for (const message of [first, second]) {
      if (!message?.message_id) continue;
      try {
        await bot.deleteMessage(config.proxyUserId, message.message_id);
      } catch (err) {
        console.warn('[direct url pilot] cleanup', err.message);
      }
    }
    return result;
  } catch (err) {
    const result = {
      status: 'failed',
      url: TEST_URL,
      reusable: false,
      error: String(err?.message || err).slice(0, 1000),
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
    };
    await setState(PILOT_KEY, result);
    console.error('[direct url pilot] failed', JSON.stringify(result));
    return result;
  }
}
