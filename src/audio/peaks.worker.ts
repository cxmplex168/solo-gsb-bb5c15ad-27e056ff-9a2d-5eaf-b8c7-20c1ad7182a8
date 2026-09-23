import {
  computePeaksFromChannels,
  PEAKS_RATE,
  type PeaksRequest,
  type PeaksWorkerMessage,
} from './peaks';

/**
 * Waveform peak computation runs here, off the main thread, so decoding a
 * long podcast never freezes the UI. The main thread transfers a COPY of the
 * required channel data (up to two channels); the original AudioBuffer is
 * never posted and stays available for playback / silence / loudness QC.
 *
 * The returned min/max Float32Arrays are transferred back (zero-copy).
 */

interface WorkerScope {
  onmessage: ((ev: MessageEvent<PeaksRequest>) => void) | null;
  postMessage(message: PeaksWorkerMessage, transfer: Transferable[]): void;
}

const worker = self as unknown as WorkerScope;

worker.onmessage = (ev: MessageEvent<PeaksRequest>) => {
  const req = ev.data;
  try {
    const peaks = computePeaksFromChannels(req.channels, {
      rate: req.rate || PEAKS_RATE,
      duration: req.duration,
      length: req.length,
      sampleRate: req.sampleRate,
    });
    worker.postMessage({ ok: true, peaks }, [peaks.min.buffer, peaks.max.buffer]);
  } catch (err) {
    worker.postMessage(
      {
        ok: false,
        message: err instanceof Error ? err.message : '波形峰值计算失败。',
      },
      [],
    );
  }
};
