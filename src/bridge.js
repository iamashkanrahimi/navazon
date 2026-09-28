function mediaFromBotMessage(message) {
  if (message.audio) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      title: message.audio.title || undefined,
      performer: message.audio.performer || undefined,
      duration: message.audio.duration || undefined,
      fileSize: message.audio.file_size || undefined,
    };
  }

  if (message.document) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileName: message.document.file_name || undefined,
      fileSize: message.document.file_size || undefined,
    };
  }

  if (Array.isArray(message.photo) && message.photo.length) {
    const best = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: best.file_id,
      fileUniqueId: best.file_unique_id,
      width: best.width || undefined,
      height: best.height || undefined,
      fileSize: best.file_size || undefined,
    };
  }

  return null;
}

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
        mode: 'single',
        resolve: value => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(value);
        },
      };
    });
  }

  expectManyMedia(count, timeoutMs = 60000) {
    const expected = Math.max(1, Number(count || 0));
    if (this.waiter) throw new Error('Bridge already has a pending media transfer');

    return new Promise((resolve, reject) => {
      const items = [];
      const timer = setTimeout(() => {
        this.waiter = null;
        if (items.length) {
          resolve({ items: items.slice(), complete: false, expected });
        } else {
          reject(new Error('Timed out waiting for forwarded files to reach our bot'));
        }
      }, timeoutMs);

      this.waiter = {
        mode: 'many',
        expected,
        items,
        push: value => {
          items.push(value);
          if (items.length >= expected) {
            clearTimeout(timer);
            this.waiter = null;
            resolve({ items: items.slice(), complete: true, expected });
          }
        },
      };
    });
  }

  consumeBotMessage(message) {
    if (!this.waiter) return false;
    if (!message?.from || message.from.id !== this.proxyUserId) return false;

    const media = mediaFromBotMessage(message);
    if (!media) return false;

    if (this.waiter.mode === 'many') {
      this.waiter.push(media);
      return true;
    }

    this.waiter.resolve(media);
    return true;
  }
}
