import {
  PEAKS_RATE,
  computePeaks,
  computePeaksFromChannels,
} from '../src/audio/peaks';
import type { AudioBufferLike } from '../src/types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function near(actual: number, expected: number, msg: string, tol = 1e-6) {
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok ${msg}`);
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

// 1 second of stereo signal: left ramps, right constant; amplitude ~0.5
const sr = 8000;
const left = new Float32Array(sr).map((_, i) => -0.5 + i / sr); // -0.5 .. +0.5
const right = new Float32Array(sr).fill(0.25);
const buffer = fakeBuffer([left, right], sr);

const peaks = computePeaks(buffer);
assert(peaks.rate === PEAKS_RATE, 'rate is 200 peaks/s');
near(peaks.duration, 1, 'duration preserved');
assert(peaks.min.length === PEAKS_RATE, 'one min bucket per peak (1s)');
assert(peaks.max.length === PEAKS_RATE, 'one max bucket per peak (1s)');
// first peak covers the start of the ramp (left near -0.5); merged with right
assert(peaks.min[0] < -0.4, 'negative ramp captured in min of first bucket');
assert(peaks.max[0] >= 0.25, 'right channel positive captured in max');
// last peak covers the end (left near +0.5)
assert(peaks.max[PEAKS_RATE - 1] > 0.4, 'positive ramp captured in last bucket');

// channel-data core equals the buffer helper
const core = computePeaksFromChannels([left, right], {
  rate: PEAKS_RATE,
  duration: 1,
  length: sr,
  sampleRate: sr,
});
assert(
  core.min.every((v, i) => v === peaks.min[i]) &&
    core.max.every((v, i) => v === peaks.max[i]),
  'channel core matches buffer helper (same math on/off worker)',
);

// only up to two channels are read, and zero input yields zero peaks
const mono = new Float32Array(400);
const silent = computePeaks(fakeBuffer([mono], 400));
assert(silent.min.length === 200, 'short buffer still yields duration*rate buckets');
assert(silent.min.every((v) => v === 0) && silent.max.every((v) => v === 0),
  'digital silence yields all-zero peaks');

// a duration shorter than one peak interval still produces exactly one
// bucket (0.005s @ 1000Hz -> ceil(1.0) = 1)
const tiny = fakeBuffer([new Float32Array(5).fill(0.5)], 1000);
const tinyPeaks = computePeaks(tiny);
assert(tinyPeaks.min.length === 1 && tinyPeaks.max.length === 1,
  'sub-peak duration yields a single bucket');
assert(tinyPeaks.max[0] === 0.5 && tinyPeaks.min[0] === 0, 'tiny peak value correct');

if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL PASS');
