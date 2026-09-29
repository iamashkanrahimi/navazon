import { sleep } from './utils.js';

const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US',
  'x-rj-user-agent': 'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};

export class RjError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RjError';
    Object.assign(this, details);
  }
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function classify(error) {
  const status = Number(error?.status || 0);
  if (status === 400 || status === 404 || status === 410 || error?.category === 'rejected') {
    return { retryable: false, category: 'permanent' };
  }
  if (status === 401 || status === 403) return { retryable: false, category: 'blocked' };
  if (status === 429) return { retryable: true, category: 'throttled' };
  if (status >= 500) return { retryable: true, category: 'server' };
  if (error?.name === 'AbortError') return { retryable: true, category: 'timeout' };
  if (error?.category === 'parse') return { retryable: true, category: 'parse' };
  return { retryable: true, category: 'network' };
}

export class RadioJavanClient {
  constructor({
    baseUrl = process.env.RJ_API_BASE || 'https://rj-deskcloud.com/api2',
    timeoutMs = Number(process.env.RJ_TIMEOUT_MS || 20_000),
    maxAttempts = Number(process.env.RJ_MAX_ATTEMPTS || 4),
    requestDelayMs = Number(process.env.RJ_REQUEST_DELAY_MS || 1100),
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.timeoutMs = Math.max(2000, timeoutMs);
    this.maxAttempts = Math.max(1, Math.min(6, maxAttempts));
    this.requestDelayMs = Math.max(250, requestDelayMs);
    this.nextStartAt = 0;
  }

  async pace() {
    const jitter = Math.floor(Math.random() * 250);
    const wait = Math.max(0, this.nextStartAt - Date.now()) + jitter;
    if (wait) await sleep(wait);
    this.nextStartAt = Date.now() + this.requestDelayMs;
  }

  async once(slug) {
    await this.pace();
    const url = new URL(`${this.baseUrl}/mp3`);
    url.searchParams.set('id', slug);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: BASE_HEADERS, signal: controller.signal, redirect: 'follow' });
      const rawText = await response.text();
      if (!response.ok) {
        throw new RjError(`RJ HTTP ${response.status}: ${rawText.slice(0, 240)}`, {
          status: response.status,
          retryAfterMs: retryAfterMs(response),
        });
      }
      let json;
      try { json = JSON.parse(rawText); }
      catch {
        throw new RjError(`RJ returned non-JSON: ${rawText.slice(0, 240)}`, { category: 'parse' });
      }
      if (json && typeof json === 'object' && json.success === false) {
        throw new RjError(`RJ rejected request: ${json.msg || 'unknown response'}`, { category: 'rejected' });
      }
      return { json, rawText };
    } finally {
      clearTimeout(timer);
    }
  }

  async song(slug) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await this.once(slug);
        return { ...result, attempts: attempt };
      } catch (error) {
        const cls = classify(error);
        error.category = cls.category;
        error.attempt = attempt;
        lastError = error;
        if (!cls.retryable || attempt >= this.maxAttempts) break;
        const retry = error.retryAfterMs ?? Math.min(60_000, 1200 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1000));
        await sleep(retry);
      }
    }
    throw lastError || new RjError('Unknown RJ request failure', { category: 'unknown' });
  }
}

export function isSystemicError(error) {
  return ['blocked', 'throttled', 'network', 'server', 'timeout'].includes(error?.category);
}
