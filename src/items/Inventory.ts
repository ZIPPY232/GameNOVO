import { item } from './items';

export interface Stack {
  id: string;
  count: number;
}

/**
 * Slot-based inventory. Slots 0..HOTBAR-1 form the quick-access bar.
 */
export class Inventory {
  static readonly HOTBAR = 9;
  slots: (Stack | null)[];
  onChange: (() => void) | null = null;

  constructor(size = 36) {
    this.slots = new Array(size).fill(null);
  }

  count(id: string): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  has(id: string, n = 1): boolean {
    return this.count(id) >= n;
  }

  /** Adds items; returns how many could NOT be added. */
  add(id: string, n: number): number {
    const max = item(id).stack;
    for (const s of this.slots) {
      if (n <= 0) break;
      if (s && s.id === id && s.count < max) {
        const k = Math.min(n, max - s.count);
        s.count += k;
        n -= k;
      }
    }
    // prefer non-hotbar empty slots for resources, hotbar first for tools
    const kind = item(id).kind;
    const order: number[] = [];
    const H = Inventory.HOTBAR;
    if (kind === 'tool' || kind === 'block' || kind === 'machine' || kind === 'consumable') {
      for (let i = 0; i < this.slots.length; i++) order.push(i);
    } else {
      for (let i = H; i < this.slots.length; i++) order.push(i);
      for (let i = 0; i < H; i++) order.push(i);
    }
    for (const i of order) {
      if (n <= 0) break;
      if (!this.slots[i]) {
        const k = Math.min(n, max);
        this.slots[i] = { id, count: k };
        n -= k;
      }
    }
    this.onChange?.();
    return n;
  }

  remove(id: string, n: number): boolean {
    if (this.count(id) < n) return false;
    for (let i = this.slots.length - 1; i >= 0 && n > 0; i--) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const k = Math.min(n, s.count);
        s.count -= k;
        n -= k;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    this.onChange?.();
    return true;
  }

  takeFromSlot(i: number, n = 1): Stack | null {
    const s = this.slots[i];
    if (!s) return null;
    const k = Math.min(n, s.count);
    s.count -= k;
    if (s.count <= 0) this.slots[i] = null;
    this.onChange?.();
    return { id: s.id, count: k };
  }

  swap(a: number, b: number): void {
    const t = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = t;
    this.onChange?.();
  }

  /** Merge stack from slot a into b if same id, else swap. */
  move(a: number, b: number): void {
    const sa = this.slots[a], sb = this.slots[b];
    if (sa && sb && sa.id === sb.id && a !== b) {
      const max = item(sa.id).stack;
      const k = Math.min(sa.count, max - sb.count);
      sb.count += k;
      sa.count -= k;
      if (sa.count <= 0) this.slots[a] = null;
      this.onChange?.();
      return;
    }
    this.swap(a, b);
  }

  freeSlots(): number {
    return this.slots.filter((s) => !s).length;
  }

  serialize(): (Stack | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  load(data: (Stack | null)[]): void {
    this.slots = new Array(this.slots.length).fill(null);
    data.forEach((s, i) => {
      if (i < this.slots.length && s) this.slots[i] = { id: s.id, count: s.count };
    });
    this.onChange?.();
  }
}
