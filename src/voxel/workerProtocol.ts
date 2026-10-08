import type { MeshResult } from './mesher';
import type { TileResult, BakeResult } from '../planet/tilegen';
import type { TextureSet } from '../render/textureGen';
import type { PlanetGenParams } from '../universe/types';
// inlined as a blob so the game also runs from file:// (standalone build / desktop app)
import TerrainWorker from './terrain.worker.ts?worker&inline';

export type WorkerRequest =
  | { type: 'init'; id: number; bodyId: string; params: PlanetGenParams }
  | { type: 'drop'; id: number; bodyId: string }
  | { type: 'gen'; id: number; bodyId: string; face: number; cx: number; cy: number; cz: number }
  | { type: 'mesh'; id: number; bodyId: string; face: number; cx: number; cy: number; cz: number; vox: Uint8Array }
  | { type: 'tile'; id: number; bodyId: string; face: number; x0: number; y0: number; size: number }
  | { type: 'bake'; id: number; bodyId: string; width: number; height: number }
  | { type: 'textures'; id: number; size: number }
  | { type: 'columns'; id: number; bodyId: string; face: number; cx: number; cy: number };

export type WorkerResponse =
  | { type: 'ok'; id: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'gen'; id: number; data: Uint8Array; count: number }
  | { type: 'mesh'; id: number; result: MeshResult }
  | { type: 'tile'; id: number; tile: TileResult }
  | { type: 'bake'; id: number; bake: BakeResult }
  | { type: 'textures'; id: number; set: TextureSet }
  | { type: 'columns'; id: number; minTop: number; maxTop: number };

type Req<T extends WorkerRequest['type']> = Omit<Extract<WorkerRequest, { type: T }>, 'id'>;
type Res<T extends WorkerResponse['type']> = Extract<WorkerResponse, { type: T }>;

interface Pending {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}

interface Job {
  msg: WorkerRequest;
  transfer: Transferable[];
  priority: number;
  pending: Pending;
  cancelled?: () => boolean;
}

/**
 * Pool of terrain workers with a priority queue. Body init messages are
 * broadcast so every worker can generate any body.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private initialised = new Set<string>();
  readonly size: number;
  private maxInFlight = 2;

  constructor(count?: number) {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.size = count ?? Math.max(2, Math.min(6, hc - 1));
    for (let i = 0; i < this.size; i++) {
      const w = new TerrainWorker();
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(i, ev.data);
      w.onerror = (ev) => console.error('worker error', ev.message);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  private onMessage(wi: number, msg: WorkerResponse): void {
    this.busy[wi]--;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (p) {
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    }
    this.pump();
  }

  private pump(): void {
    while (this.queue.length) {
      let best = -1;
      for (let i = 0; i < this.workers.length; i++) {
        if (this.busy[i] < this.maxInFlight && (best < 0 || this.busy[i] < this.busy[best])) best = i;
      }
      if (best < 0) return;
      // highest priority = lowest number
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[bi].priority) bi = i;
      const job = this.queue.splice(bi, 1)[0];
      if (job.cancelled && job.cancelled()) {
        job.pending.reject(new Error('cancelled'));
        continue;
      }
      this.pending.set(job.msg.id, job.pending);
      this.busy[best]++;
      this.workers[best].postMessage(job.msg, job.transfer);
    }
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Re-prioritise queued jobs (e.g. by distance to the camera). */
  reprioritise(fn: (msg: WorkerRequest, old: number) => number): void {
    for (const j of this.queue) j.priority = fn(j.msg, j.priority);
  }

  async initBody(bodyId: string, params: PlanetGenParams): Promise<void> {
    if (this.initialised.has(bodyId)) return;
    this.initialised.add(bodyId);
    await Promise.all(this.workers.map((w, i) => {
      const id = this.nextId++;
      return new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve: () => resolve(), reject });
        this.busy[i]++;
        w.postMessage({ type: 'init', id, bodyId, params } satisfies WorkerRequest);
      });
    }));
  }

  run<T extends WorkerRequest['type'], R extends WorkerResponse['type']>(
    msg: Req<T> & { type: T },
    priority = 0,
    transfer: Transferable[] = [],
    cancelled?: () => boolean,
  ): Promise<Res<R>> {
    const id = this.nextId++;
    const full = { ...msg, id } as unknown as WorkerRequest;
    return new Promise<Res<R>>((resolve, reject) => {
      this.queue.push({ msg: full, transfer, priority, pending: { resolve: resolve as (r: WorkerResponse) => void, reject }, cancelled });
      this.pump();
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
