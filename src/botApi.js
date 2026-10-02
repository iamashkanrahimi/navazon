export class BotApi {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
    const max429WaitSeconds = Math.max(0, Number(options.max429WaitSeconds ?? 8));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let res;
      try {
        res = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`Bot API ${method} network error: ${err.message}`);
      }

      if (res.status >= 500 && attempt < maxAttempts - 1) {
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
      if (
        ['editMessageText', 'editMessageCaption', 'editMessageReplyMarkup'].includes(method)
        && /message is not modified/i.test(description)
      ) {
        return null;
      }

      if (Number(data.error_code) === 429) {
        const retryAfter = Math.max(1, Number(data.parameters?.retry_after || 1));
        if (attempt < maxAttempts - 1 && retryAfter <= max429WaitSeconds) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
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

  editMessageCaption(chatId, messageId, caption, extra = {}) {
    return this.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, ...extra });
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });
  }

  sendAudio(chatId, fileId, extra = {}, callOptions = {}) {
    return this.call('sendAudio', { chat_id: chatId, audio: fileId, ...extra }, callOptions);
  }

  sendDocument(chatId, fileId, extra = {}) {
    return this.call('sendDocument', { chat_id: chatId, document: fileId, ...extra });
  }

  sendPhoto(chatId, fileId, extra = {}, callOptions = {}) {
    return this.call('sendPhoto', { chat_id: chatId, photo: fileId, ...extra }, callOptions);
  }

  async sendPhotoBuffer(chatId, buffer, filename = 'image.jpg', extra = {}, callOptions = {}) {
    const maxAttempts = Math.max(1, Number(callOptions.maxAttempts || 3));
    const max429WaitSeconds = Math.max(0, Number(callOptions.max429WaitSeconds ?? 8));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('photo', new Blob([buffer]), filename);
      for (const [key, value] of Object.entries(extra || {})) {
        if (value == null) continue;
        form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }

      let res;
      try {
        res = await fetch(`${this.base}/sendPhoto`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`Bot API sendPhoto network error: ${err.message}`);
      }

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Bot API sendPhoto: invalid response (HTTP ${res.status})`);
      }

      if (data.ok) return data.result;

      const description = data.description || 'unknown error';
      if (Number(data.error_code) === 429) {
        const retryAfter = Math.max(1, Number(data.parameters?.retry_after || 1));
        if (attempt < maxAttempts - 1 && retryAfter <= max429WaitSeconds) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }

      if (res.status >= 500 && attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }

      const err = new Error(`Bot API sendPhoto: ${description}`);
      err.code = data.error_code;
      err.parameters = data.parameters;
      throw err;
    }

    throw new Error('Bot API sendPhoto: retry limit reached');
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

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }
}
