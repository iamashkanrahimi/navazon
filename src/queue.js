export class SerialQueue {
  constructor(worker) {
    this.worker = worker;
    this.items = [];
    this.busy = false;
  }

  push(item) {
    this.items.push(item);
    this.drain().catch(err => console.error('[queue]', err));
  }

  isIdle() {
    return !this.busy && this.items.length === 0;
  }

  size() {
    return this.items.length + (this.busy ? 1 : 0);
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        try {
          await this.worker(item);
        } catch (err) {
          console.error('[job]', err);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
