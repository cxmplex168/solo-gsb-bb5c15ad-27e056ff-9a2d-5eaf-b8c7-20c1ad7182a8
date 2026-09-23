import type { AudioBufferLike, Peaks } from '../types';

const PEAKS_RATE = 200; // peaks per second

/**
 * Payload posted to the peaks worker: only a COPY of the (at most two)
 * channel arrays actually needed for the waveform — never the AudioBuffer
 * itself, which stays on the main thread for playback and QC analysis.
 */
export interface PeaksRequest {
  rate: number;
  duration: number;
  length: number;
  sampleRate: number;
  channels: Float32Array[];
}

export interface PeaksResponse {
  ok: true;
  peaks: Peaks;
}

export interface PeaksErrorResponse {
  ok: false;
  message: string;
}

export type PeaksWorkerMessage = PeaksResponse | PeaksErrorResponse;

/**
 * Compute min/max peak pairs at a fixed rate from raw channel PCM.
 * ~200 peaks/sec keeps rendering cheap at any zoom level.
 *
 * Pure over plain arrays so the exact same implementation runs on the main
 * thread (worker fallback / node tests) and inside the Web Worker.
 */
export function computePeaksFromChannels(
  channels: ArrayLike<number>[],
  opts: { rate: number; duration: number; length: number; sampleRate: number },
): Peaks {
  const { rate, duration, length, sampleRate } = opts;
  const count = Math.max(1, Math.ceil(duration * rate));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const samplesPerPeak = sampleRate / rate;

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * samplesPerPeak);
    const end = Math.min(length, Math.ceil((i + 1) * samplesPerPeak));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      // stride to keep per-peak work bounded on very long files
      const step = Math.max(1, Math.floor((end - start) / 256));
      for (let s = start; s < end; s += step) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, rate, duration };
}

/**
 * Compute min/max peak pairs at a fixed rate from decoded audio.
 * Kept as a synchronous helper (node tests and the no-worker fallback);
 * the UI hot path goes through the Web Worker instead.
 */
export function computePeaks(buffer: AudioBufferLike): Peaks {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c));
  }
  return computePeaksFromChannels(channels, {
    rate: PEAKS_RATE,
    duration: buffer.duration,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
}

export { PEAKS_RATE };
