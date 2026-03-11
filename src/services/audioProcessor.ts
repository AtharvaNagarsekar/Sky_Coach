// Audio Preprocessing Service
// Applies bandpass filter, noise gate, and normalization to audio buffers

const AUDIO_CTX_OPTIONS: AudioContextOptions = { sampleRate: 16000 };

let _audioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext(AUDIO_CTX_OPTIONS);
  }
  return _audioCtx;
}

/**
 * Apply bandpass filter (300–3400Hz) to simulate VHF radio band
 */
export function createBandpassFilter(ctx: AudioContext): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1850;  // Center of 300-3400
  filter.Q.value = 0.7;
  return filter;
}

/**
 * Apply high-pass filter to remove low-frequency rumble
 */
export function createHighpassFilter(ctx: AudioContext): BiquadFilterNode {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  hp.Q.value = 0.7;
  return hp;
}

/**
 * Apply low-pass filter to remove high-frequency noise
 */
export function createLowpassFilter(ctx: AudioContext): BiquadFilterNode {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3400;
  lp.Q.value = 0.7;
  return lp;
}

/**
 * Normalize a Float32Array PCM buffer to target RMS level
 */
export function normalizeBuffer(data: Float32Array, targetRms = 0.1): Float32Array {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length);
  if (rms < 0.0001) return data; // silence, skip
  const gain = targetRms / rms;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.max(-1, Math.min(1, data[i] * gain));
  return out;
}

/**
 * Simple noise gate: zero out samples below threshold
 */
export function noiseGate(data: Float32Array, threshold = 0.015): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.abs(data[i]) > threshold ? data[i] : 0;
  }
  return out;
}

/**
 * Voice Activity Detection (VAD): detect if chunk has speech
 */
export function hasVoiceActivity(data: Float32Array, threshold = 0.02): boolean {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length) > threshold;
}

/**
 * Convert Float32Array PCM to 16-bit PCM WAV Blob
 */
export function float32ToWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeStr(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  function writeUint32(offset: number, val: number) { view.setUint32(offset, val, true); }
  function writeUint16(offset: number, val: number) { view.setUint16(offset, val, true); }

  writeStr(0, 'RIFF');
  writeUint32(4, 36 + samples.length * 2);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  writeUint32(16, 16);
  writeUint16(20, 1); // PCM
  writeUint16(22, 1); // mono
  writeUint32(24, sampleRate);
  writeUint32(28, sampleRate * 2);
  writeUint16(32, 2);
  writeUint16(34, 16);
  writeStr(36, 'data');
  writeUint32(40, samples.length * 2);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Process raw PCM audio: apply noise gate, bandpass, normalize
 */
export function preprocessAudio(raw: Float32Array): Float32Array {
  const gated = noiseGate(raw);
  const normed = normalizeBuffer(gated, 0.1);
  return normed;
}

/**
 * Compute RMS of buffer
 */
export function computeRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

/**
 * Compute pitch estimate using autocorrelation (returns Hz or 0 if not pitched)
 */
export function estimatePitch(buffer: Float32Array, sampleRate = 16000): number {
  const SIZE = buffer.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  const correlations = new Float32Array(MAX_SAMPLES);
  let maxVal = -1;
  let maxIdx = -1;

  for (let i = 0; i < MAX_SAMPLES; i++) {
    let sum = 0;
    for (let j = 0; j < MAX_SAMPLES; j++) {
      sum += buffer[j] * (buffer[j + i] || 0);
    }
    correlations[i] = sum;
    if (i > 20 && sum > maxVal) {
      maxVal = sum;
      maxIdx = i;
    }
  }

  if (maxIdx < 1 || maxVal < 0.01) return 0;
  return sampleRate / maxIdx;
}

/**
 * Compute Zero Crossing Rate
 */
export function computeZCR(buffer: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < buffer.length; i++) {
    if ((buffer[i] >= 0) !== (buffer[i - 1] >= 0)) crossings++;
  }
  return crossings / buffer.length;
}

/**
 * Compute Spectral Centroid (brightness measure)
 */
export function computeSpectralCentroid(buffer: Float32Array): number {
  let weightedSum = 0;
  let totalMagnitude = 0;
  for (let i = 0; i < buffer.length; i++) {
    const mag = Math.abs(buffer[i]);
    weightedSum += i * mag;
    totalMagnitude += mag;
  }
  return totalMagnitude > 0 ? weightedSum / totalMagnitude : 0;
}
