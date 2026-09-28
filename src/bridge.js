export class BridgeInbox {
  constructor(proxyUserId) {
    this.proxyUserId = proxyUserId;
    this.waiter = null;
  }

  expectMedia(timeoutMs = 20000) {
    if (this.waiter) throw new Error('Bridge already has a pending media transfer');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Timed out waiting for the forwarded file to reach our bot'));
      }, timeoutMs);

      this.waiter = {
        resolve: value => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(value);
        },
      };
    });
  }

  consumeBotMessage(message) {
    if (!this.waiter) return false;
    if (!message?.from || message.from.id !== this.proxyUserId) return false;

    if (message.audio) {
      this.waiter.resolve({
        kind: 'audio',
        fileId: message.audio.file_id,
        fileUniqueId: message.audio.file_unique_id,
        title: message.audio.title || undefined,
        performer: message.audio.performer || undefined,
        duration: message.audio.duration || undefined,
      });
      return true;
    }

    if (message.document) {
      this.waiter.resolve({
        kind: 'document',
        fileId: message.document.file_id,
        fileUniqueId: message.document.file_unique_id,
        fileName: message.document.file_name || undefined,
      });
      return true;
    }

    return false;
  }
}
