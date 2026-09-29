export class BotApi {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`Bot API ${method} network error: ${err.message}`);
      }

      if (res.status >= 500 && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Bot API ${method}: invalid response (HTTP ${res.status})`);
      }

      if (data.ok) return data.result;

      const description = data.description || 'unknown error';
      if (method === 'editMessageText' && /message is not modified/i.test(description)) {
        return null;
      }

      if (Number(data.error_code) === 429 && attempt < 2) {
        const retryAfter = Math.max(1, Math.min(8, Number(data.parameters?.retry_after || 1)));
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      const err = new Error(`Bot API ${method}: ${description}`);
      err.code = data.error_code;
      err.parameters = data.parameters;
      throw err;
    }

    throw new Error(`Bot API ${method}: retry limit reached`);
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });
  }

  sendAudio(chatId, fileId, extra = {}) {
    return this.call('sendAudio', { chat_id: chatId, audio: fileId, ...extra });
  }

  sendDocument(chatId, fileId, extra = {}) {
    return this.call('sendDocument', { chat_id: chatId, document: fileId, ...extra });
  }

  sendPhoto(chatId, fileId, extra = {}) {
    return this.call('sendPhoto', { chat_id: chatId, photo: fileId, ...extra });
  }

  setWebhook(url, secretToken) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }
}
