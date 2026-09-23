import { PeaksWorkerClient } from '../src/audio/PeaksWorkerClient';
import { computePeaksFromChannels, PEAKS_RATE } from '../src/audio/peaks';
import type { AudioBufferLike } from '../src/types';
import type {
  PeaksRequest,
  PeaksResponse,
  PeaksWorkerMessage,
} from '../src/audio/peaks';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}

function fakeBuffer(channels: Float32Array[], sampleRate = 8000): AudioBufferLike {
  return {
    duration: channels[0].length / sampleRate,
    length: channels[0].length,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (c) => channels[c],
  };
}

function expectedPeaks(req: PeaksRequest) {
  return computePeaksFromChannels(req.channels, {
    rate: req.rate,
    duration: req.duration,
    length: req.length,
    sampleRate: req.sampleRate,
  });
}

/** Controllable Worker stand-in: records posts/terminations, replies on demand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: { data: PeaksWorkerMessage }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  terminated = false;
  lastRequest: PeaksRequest | null = null;
  transfer: Transferable[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(req: PeaksRequest, transfer: Transferable[]) {
    this.lastRequest = req;
    this.transfer = transfer;
  }
  terminate() {
    this.terminated = true;
  }
  /** simulate the real worker replying with correctly computed peaks */
  reply() {
    const peaks = expectedPeaks(this.lastRequest!);
    const msg: PeaksResponse = { ok: true, peaks };
    this.onmessage!({ data: msg });
  }
  fail(message: string) {
    this.onerror!({ message });
  }
}

class TestClient extends PeaksWorkerClient {
  createWorker() {
    return new FakeWorker() as unknown as Worker;
  }
  currentWorker(): FakeWorker | null {
    return (this as unknown as { worker: FakeWorker | null }).worker;
  }
}

async function main() {
  // ---- 1. happy path: worker returns peaks ----
  FakeWorker.instances = [];
  const client = new TestClient();
  const ch = new Float32Array(8000).fill(0.5);
  const buffer = fakeBuffer([ch]);
  const p1 = client.computePeaks(buffer);
  const w1 = FakeWorker.instances[0];
  assert(FakeWorker.instances.length === 1, 'one worker spawned');
  assert(w1.lastRequest !== null, 'request posted');
  assert(w1.lastRequest!.channels.length === 1, 'only needed channels posted');
  // copies, not the originals: transfer list holds distinct ArrayBuffers
  assert(w1.transfer.length === 1, 'copies are transferred');
  assert(
    w1.transfer[0] !== ch.buffer,
    'transferred buffer is a COPY, not the AudioBuffer store',
  );
  assert(
    ch.length === 8000 && ch[0] === 0.5,
    'original channel data left intact for playback/QC',
  );
  w1.reply();
  const peaks1 = await p1;
  assert(peaks1.min.length === 200 && peaks1.max[0] === 0.5, 'worker peaks resolve correctly');

  // ---- 2. rapid switch: older job superseded (AbortError), worker killed ----
  const buf2 = fakeBuffer([new Float32Array(8000)]);
  const p2first = client.computePeaks(buf2);
  // idle worker is reused; capture whichever worker the pending job is on
  const wBusy = client.currentWorker()!;
  assert(wBusy === w1, 'an idle completed worker is reused');
  assert(wBusy.lastRequest!.length === 8000, 'second load posted to worker');
  // third load arrives before the second answers
  const buf3 = fakeBuffer([new Float32Array(8000)]);
  const p3 = client.computePeaks(buf3);
  const w3 = client.currentWorker()!;
  assert(wBusy.terminated, 'in-flight worker of the older load is terminated');
  assert(w3 !== wBusy, 'fresh worker spawned for the newest load');
  assert(wBusy.onmessage === null, 'dead worker can no longer deliver a stale result');
  let aborted = false;
  await p2first.catch((e: Error) => {
    aborted = e.name === 'AbortError';
  });
  assert(aborted, 'superseded load rejects with AbortError (never updates waveform)');
  w3.reply();
  const peaks3 = await p3;
  assert(peaks3.rate === PEAKS_RATE, 'newest load resolves and publishes peaks');

  // ---- 3. worker runtime error rejects (UI shows recoverable prompt) ----
  const p4 = client.computePeaks(buf3);
  const w4 = client.currentWorker()!;
  let errMsg = '';
  const p4caught = p4.catch((e: Error) => {
    errMsg = e.message;
  });
  w4.fail('boom');
  await p4caught;
  assert(errMsg === 'boom', 'worker error rejects so the UI can offer retry');
  assert(w4.terminated, 'failed worker is dropped');
  // retry spawns a new worker and succeeds against the same retained buffer
  const p5 = client.computePeaks(buf3);
  const w5 = client.currentWorker()!;
  assert(w5 !== w4, 'retry uses a fresh worker');
  w5.reply();
  await p5;
  assert(true, 'retry after worker failure succeeds');

  // ---- 4. no Worker support: main-thread fallback resolves ----
  class NoWorkerClient extends PeaksWorkerClient {
    createWorker() {
      return null;
    }
  }
  const fallback = new NoWorkerClient();
  const pf = await fallback.computePeaks(buffer);
  assert(pf.max[0] === 0.5 && pf.min.length === 200, 'main-thread fallback when no worker');

  client.dispose();
  fallback.dispose();

  if (failures > 0) {
    console.error(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('ALL PASS');
}

void main();
