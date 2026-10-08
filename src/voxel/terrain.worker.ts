/// <reference lib="webworker" />
import { TerrainGenerator, CHUNK, CHUNK_VOL } from '../planet/terrain';
import { meshChunk, PAD, PAD2 } from './mesher';
import { generateTile, bakePlanet } from '../planet/tilegen';
import { generateTextures } from '../render/textureGen';
import { B } from './blocks';
import type { PlanetGenParams } from '../universe/types';
import type { WorkerRequest, WorkerResponse } from './workerProtocol';

/**
 * Terrain worker: chunk generation, meshing, far-LOD tiles, planet bakes and
 * boot-time texture synthesis. All heavy procedural work stays off the main
 * thread so streaming never stalls rendering.
 */

const gens = new Map<string, TerrainGenerator>();
const ctx = self as unknown as DedicatedWorkerGlobalScope;

function gen(bodyId: string): TerrainGenerator {
  const g = gens.get(bodyId);
  if (!g) throw new Error('unknown body ' + bodyId);
  return g;
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        if (!gens.has(msg.bodyId)) gens.set(msg.bodyId, new TerrainGenerator(msg.params as PlanetGenParams));
        reply({ type: 'ok', id: msg.id });
        break;
      }
      case 'drop': {
        gens.delete(msg.bodyId);
        reply({ type: 'ok', id: msg.id });
        break;
      }
      case 'gen': {
        const g = gen(msg.bodyId);
        const data = new Uint8Array(CHUNK_VOL);
        const count = g.fillChunk(msg.face, msg.cx, msg.cy, msg.cz, data);
        reply({ type: 'gen', id: msg.id, data, count }, [data.buffer]);
        break;
      }
      case 'mesh': {
        const g = gen(msg.bodyId);
        const vox = msg.vox;
        const I0 = msg.cx * CHUNK - 1, J0 = msg.cy * CHUNK - 1, K0 = msg.cz * CHUNK - 1;
        // fill unknown padding voxels deterministically
        for (let z = 0; z < PAD; z++) for (let y = 0; y < PAD; y++) for (let x = 0; x < PAD; x++) {
          const i = x + y * PAD + z * PAD2;
          if (vox[i] === B.UNKNOWN) vox[i] = g.voxelAt(msg.face, I0 + x, J0 + y, K0 + z);
        }
        // natural surface tops on the padded column grid
        const topExt = new Int16Array(PAD * PAD);
        for (let y = 0; y < PAD; y++) for (let x = 0; x < PAD; x++) {
          topExt[x + y * PAD] = g.surfaceTop(msg.face, I0 + x, J0 + y);
        }
        const res = meshChunk({ face: msg.face, cx: msg.cx, cy: msg.cy, cz: msg.cz, N: g.p.N, baseRadius: g.p.baseRadius, vox, topExt });
        const transfers: Transferable[] = [];
        for (const m of [res.opaque, res.translucent]) {
          if (!m) continue;
          transfers.push(m.position.buffer, m.normal.buffer, m.tangent.buffer, m.uv.buffer, m.data.buffer, m.index.buffer);
        }
        reply({ type: 'mesh', id: msg.id, result: res }, transfers);
        break;
      }
      case 'tile': {
        const g = gen(msg.bodyId);
        const t = generateTile(g, msg.face, msg.x0, msg.y0, msg.size);
        reply({ type: 'tile', id: msg.id, tile: t }, [t.position.buffer, t.normal.buffer, t.color.buffer]);
        break;
      }
      case 'bake': {
        const g = gen(msg.bodyId);
        const b = bakePlanet(g, msg.width, msg.height);
        reply({ type: 'bake', id: msg.id, bake: b }, [b.data.buffer]);
        break;
      }
      case 'textures': {
        const t = generateTextures(msg.size);
        reply({ type: 'textures', id: msg.id, set: t }, [t.albedo.buffer, t.material.buffer]);
        break;
      }
      case 'columns': {
        const g = gen(msg.bodyId);
        const cs = g.getColumns(msg.face, msg.cx, msg.cy);
        reply({ type: 'columns', id: msg.id, minTop: cs.minTop, maxTop: cs.maxTop });
        break;
      }
    }
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: String((err as Error)?.stack ?? err) });
  }
};

function reply(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}
