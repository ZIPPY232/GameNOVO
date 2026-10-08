/**
 * Versioned persistence on IndexedDB.
 *  - "saves" store: one JSON document per slot (universe seed, player, ship,
 *    inventory, progression, discoveries, custom names, machines...)
 *  - "chunks" store: RLE-compressed voxel data of player-modified chunks only.
 * Procedural content is never stored: it is regenerated from seeds.
 */

export const SAVE_VERSION = 2;
const DB_NAME = 'voxel-realism-space';
const DB_VERSION = 1;

export interface SaveDoc {
  version: number;
  slot: string;
  updated: number;
  galaxySeed: number;
  time: number;
  systemId: string;
  frameBodyId: string | null;
  mode: 'onfoot' | 'ship';
  player: { pos: number[]; vel: number[]; forward: number[]; pitch: number; jetpackOn?: boolean };
  vitals: Record<string, unknown>;
  inventory: ({ id: string; count: number } | null)[];
  hotbarIndex: number;
  ship: Record<string, unknown>;
  shipFrameBodyId: string | null;
  campaign: Record<string, unknown>;
  discoveries: DiscoveryEntry[];
  names: Record<string, string>;
  visitedSystems: string[];
  machines: unknown[];
  suit: { primary: string; secondary: string; accent: string; visor: string; helmet?: number; pack?: number };
  stats: Record<string, number>;
  navTarget: string | null;
  jumpTarget: string | null;
  pois?: string[];
  looted?: string[];
  /** harvested plants per body key */
  floraRemoved?: Record<string, string[]>;
}

export interface DiscoveryEntry {
  id: string;
  kind: 'system' | 'body' | 'resource' | 'species' | 'structure' | 'note';
  title: string;
  text: string;
  time: number;
  systemId: string;
}

export function rleEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let n = 1;
    while (i + n < data.length && data[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  return Uint8Array.from(out);
}

/** Decodes to the encoded length (old blocks-only chunks decode shorter than `size`). */
export function rleDecode(rle: Uint8Array, size: number): Uint8Array {
  let total = 0;
  for (let i = 1; i < rle.length; i += 2) total += rle[i];
  const out = new Uint8Array(Math.min(total, size));
  let o = 0;
  for (let i = 0; i < rle.length; i += 2) {
    out.fill(rle[i], o, o + rle[i + 1]);
    o += rle[i + 1];
  }
  return out;
}

/** Migration hook for older save documents. */
function migrate(doc: SaveDoc): SaveDoc {
  if (doc.version < 2) {
    doc.stats = doc.stats ?? {};
    doc.navTarget = doc.navTarget ?? null;
    doc.jumpTarget = doc.jumpTarget ?? null;
  }
  doc.version = SAVE_VERSION;
  return doc;
}

export class SaveSystem {
  private db: IDBDatabase | null = null;
  available = true;

  async open(): Promise<void> {
    if (this.db) return;
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, saves disabled', e);
      this.available = false;
    }
  }

  private tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve(undefined); return; }
      const t = this.db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  async loadDoc(slot: string): Promise<SaveDoc | null> {
    await this.open();
    const d = await this.tx<SaveDoc>('saves', 'readonly', (s) => s.get(slot));
    return d ? migrate(d) : null;
  }

  async hasSave(slot: string): Promise<boolean> {
    return !!(await this.loadDoc(slot));
  }

  async saveDoc(doc: SaveDoc): Promise<void> {
    await this.open();
    await this.tx('saves', 'readwrite', (s) => s.put(doc, doc.slot));
  }

  /** Persist modified chunks for a body (full replace of the provided keys). */
  async saveChunks(slot: string, systemId: string, bodyId: string, edits: Map<string, Uint8Array>): Promise<void> {
    await this.open();
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const t = this.db!.transaction('chunks', 'readwrite');
      const s = t.objectStore('chunks');
      for (const [k, v] of edits) s.put(rleEncode(v), `${slot}|${systemId}|${bodyId}|${k}`);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async loadChunks(slot: string, systemId: string, bodyId: string, size: number): Promise<Map<string, Uint8Array>> {
    await this.open();
    const out = new Map<string, Uint8Array>();
    if (!this.db) return out;
    const prefix = `${slot}|${systemId}|${bodyId}|`;
    await new Promise<void>((resolve, reject) => {
      const t = this.db!.transaction('chunks', 'readonly');
      const s = t.objectStore('chunks');
      const range = IDBKeyRange.bound(prefix, prefix + '￿');
      const req = s.openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out.set(String(c.key).slice(prefix.length), rleDecode(c.value as Uint8Array, size));
        c.continue();
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    return out;
  }

  async deleteSlot(slot: string): Promise<void> {
    await this.open();
    if (!this.db) return;
    await this.tx('saves', 'readwrite', (s) => s.delete(slot));
    await new Promise<void>((resolve) => {
      const t = this.db!.transaction('chunks', 'readwrite');
      const s = t.objectStore('chunks');
      const range = IDBKeyRange.bound(`${slot}|`, `${slot}|￿`);
      s.delete(range);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  }
}
