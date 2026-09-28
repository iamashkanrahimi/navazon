export class BotApi {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Bot API ${method}: ${data.description || 'unknown error'}`);
    return data.result;
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
