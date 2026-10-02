import { bot, tg } from './runtime.js';
import { getState, setState } from './state.js';
import { createPrivateCacheMegagroup } from './mtproto.js';

const STATE_KEY = 'rj_extra_cache_lanes_v1';
const TARGET_COUNT = 4;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function laneUsable(chatId) {
  if (!chatId) return false;
  try {
    const chat = await bot.getChat(chatId);
    return Boolean(chat?.id);
  } catch {
    return false;
  }
}

export async function ensureRjExtraCacheLanes() {
  const current = await getState(STATE_KEY, { lanes: [] });
  const lanes = Array.isArray(current?.lanes) ? [...current.lanes] : [];
  const good = [];

  for (const lane of lanes) {
    if (await laneUsable(lane?.chatId)) good.push(lane);
  }

  for (let i = good.length; i < TARGET_COUNT; i += 1) {
    const created = await createPrivateCacheMegagroup(
      tg,
      `Navazon Cache Lane ${i + 2}`,
      'Private cache lane for Navazon media ingestion'
    );

    let ready = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await laneUsable(created.peerId)) {
        ready = true;
        break;
      }
      await sleep(700);
    }
    if (!ready) {
      throw new Error(`Bot cannot access newly created cache lane ${created.peerId}`);
    }

    const lane = {
      name: `extra-${i + 1}`,
      chatId: created.peerId,
      title: created.title,
      channelId: created.channelId,
      createdAt: Date.now(),
    };
    good.push(lane);
    await setState(STATE_KEY, { lanes: good });
    console.log('[rj cache lanes] created', JSON.stringify(lane));
    await sleep(500);
  }

  await setState(STATE_KEY, { lanes: good });
  console.log('[rj cache lanes] ready', JSON.stringify({
    count: good.length,
    chatIds: good.map(lane => lane.chatId),
  }));

  return good;
}

export async function getRjExtraCacheLanes() {
  const current = await getState(STATE_KEY, { lanes: [] });
  return Array.isArray(current?.lanes) ? current.lanes : [];
}
