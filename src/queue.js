export class SerialQueue {
  constructor(worker, {
    priorityOf = () => 0,
    keyOf = () => null,
  } = {}) {
    this.worker = worker;
    this.priorityOf = priorityOf;
    this.keyOf = keyOf;
    this.items = [];
    this.busy = false;
    this.sequence = 0;
    this.activeItem = null;
  }

  push(item) {
    const key = this.keyOf(item);
    if (key) {
      if (this.activeItem?.key === key || this.items.some(entry => entry.key === key)) {
        return false;
      }
    }

    const wrapped = {
      item,
      key,
      priority: Number(this.priorityOf(item) || 0),
      sequence: this.sequence++,
      queuedAt: Date.now(),
    };
    this.items.push(wrapped);
    this.items.sort((a, b) =>
      b.priority - a.priority || a.sequence - b.sequence
    );
    this.drain().catch(err => console.error('[queue]', err));
    return true;
  }

  isIdle() {
    return !this.busy && this.items.length === 0;
  }

  size() {
    return this.items.length + (this.busy ? 1 : 0);
  }

  pendingSize() {
    return this.items.length;
  }

  hasPending(predicate) {
    return this.items.some(entry => predicate(entry.item));
  }

  active() {
    return this.activeItem?.item || null;
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.items.length) {
        const entry = this.items.shift();
        this.activeItem = entry;
        try {
          await this.worker({
            ...entry.item,
            _queueMeta: {
              queuedAt: entry.queuedAt,
              priority: entry.priority,
              sequence: entry.sequence,
            },
          });
        } catch (err) {
          console.error('[job]', err);
        } finally {
          this.activeItem = null;
        }
      }
    } finally {
      this.busy = false;
      this.activeItem = null;
    }
  }
}
