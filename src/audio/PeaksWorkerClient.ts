import {
  computePeaks,
  computePeaksFromChannels,
  PEAKS_RATE,
  type PeaksRequest,
  type PeaksResponse,
  type PeaksWorkerMessage,
} from './peaks';
import type { AudioBufferLike, Peaks } from '../types';

/**
 * Client for the off-thread waveform peaks worker.
 *
 * Guarantees:
 *  - Only the LATEST computePeaks() call resolves: when the user switches
 *    audio while a previous file is still being processed, the in-flight
 *    worker is terminated (cancelling its work) and its promise rejected
 *    with an AbortError, so a slow old file can never overwrite the new
 *    waveform.
 *  - Only copies of the channels needed for the waveform are sent; the
 *    caller's AudioBuffer is untouched and stays usable for playback/QC.
 *  - If workers are unavailable (old browser / worker script fails to
 *    spawn or post), computation transparently falls back to the main
 *    thread.
 */

const SUPERSEDED = 'peaks-request-superseded';

interface Pending {
  resolve: (peaks: Peaks) => void;
  reject: (err: Error) => void;
}

export class PeaksWorkerClient {
  protected worker: Worker | null = null;
  private pending: Pending | null = null;
  private busy = false;

  /**
   * Construct the actual worker. Overridable seam for tests; returns null
   * when Worker is unavailable so callers fall back to the main thread.
   */
  protected createWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    return new Worker(new URL('./peaks.worker.ts', import.meta.url), {
      type: 'module',
    });
  }

  private spawn(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const w = this.createWorker();
      if (!w) return null;
      this.worker = w;
      this.worker.onmessage = (ev: MessageEvent<PeaksWorkerMessage>) => {
        this.handleMessage(ev.data);
      };
      this.worker.onerror = (ev: ErrorEvent) => {
        this.fail(new Error(ev.message || '波形峰值 Worker 运行失败。'));
      };
    } catch {
      this.terminate();
      return null;
    }
    return this.worker;
  }

  private handleMessage(msg: PeaksWorkerMessage): void {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    this.busy = false;
    if (msg.ok) {
      const response: PeaksResponse = msg;
      job.resolve(response.peaks);
    } else {
      job.reject(new Error(msg.message || '波形峰值计算失败。'));
    }
  }

  /** Reject the current job and drop the worker (its last result failed). */
  private fail(err: Error): void {
    const job = this.pending;
    this.pending = null;
    this.busy = false;
    this.terminate();
    job?.reject(err);
  }

  /**
   * Cancel any in-flight request. Its promise rejects with an AbortError so
   * awaiting callers unwind cleanly; a fresh worker is spawned on the next
   * call, guaranteeing a stale job can never produce UI state.
   */
  cancel(): void {
    const job = this.pending;
    this.pending = null;
    this.busy = false;
    this.terminate();
    if (job) {
      const err = new Error('已被新的音频载入任务取代。');
      err.name = 'AbortError';
      (err as Error & { code?: string }).code = SUPERSEDED;
      job.reject(err);
    }
  }

  private terminate(): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Compute waveform peaks off the main thread. Resolves only for the most
   * recent call; superseded calls reject with an AbortError.
   */
  computePeaks(buffer: AudioBufferLike): Promise<Peaks> {
    // A newer selection always wins: kill the previous run outright
    // (there is no portable way to interrupt a running message otherwise).
    if (this.busy || this.pending) this.cancel();

    const worker = this.spawn();
    if (!worker) {
      // No worker support at all — fall back to the main thread.
      return Promise.resolve(computePeaks(buffer));
    }

    return new Promise<Peaks>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.busy = true;

      // Send only a COPY of the up-to-two channels the waveform needs.
      // slice() detaches the copy from the AudioBuffer's backing store, so
      // transferring it cannot affect playback / QC data on this thread.
      const channelCount = Math.min(2, buffer.numberOfChannels);
      const channels: Float32Array[] = [];
      const transfer: Transferable[] = [];
      for (let c = 0; c < channelCount; c++) {
        const copy = buffer.getChannelData(c).slice();
        channels.push(copy);
        transfer.push(copy.buffer);
      }

      const request: PeaksRequest = {
        rate: PEAKS_RATE,
        duration: buffer.duration,
        length: buffer.length,
        sampleRate: buffer.sampleRate,
        channels,
      };

      try {
        worker.postMessage(request, transfer);
      } catch {
        // post failure: drop the worker and compute on the main thread
        // rather than surfacing an unrecoverable error.
        this.pending = null;
        this.busy = false;
        this.terminate();
        try {
          resolve(
            computePeaksFromChannels(channels, {
              rate: PEAKS_RATE,
              duration: buffer.duration,
              length: buffer.length,
              sampleRate: buffer.sampleRate,
            }),
          );
        } catch (fallbackErr) {
          reject(
            fallbackErr instanceof Error
              ? fallbackErr
              : new Error('波形峰值计算失败。'),
          );
        }
      }
    });
  }

  dispose(): void {
    this.cancel();
  }
}
