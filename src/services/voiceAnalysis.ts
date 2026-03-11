// Voice Analysis Service
// Real-time voice parameter extraction using Web Audio API

import {
  computeRMS, estimatePitch, computeZCR, computeSpectralCentroid, hasVoiceActivity
} from './audioProcessor';

export interface SpeakerSegment {
  id: string;
  label: 'PILOT' | 'ATC' | 'SPEAKER_A' | 'SPEAKER_B';
  startTime: number; // seconds
  endTime: number;
  color: string;
}

export interface VoiceMetrics {
  // Energy & Volume
  rms: number;              // 0-1 raw RMS
  volumeDb: number;         // dBFS

  // Pitch
  pitchHz: number;          // Fundamental frequency Hz
  pitchVariance: number;    // 0-1 (how much pitch varies = emotion indicator)

  // Rate indicators
  zcr: number;              // Zero crossing rate
  spectralCentroid: number; // Frequency centroid

  // Derived Scores (0-100)
  stressScore: number;      // High = stressed
  confidenceScore: number;  // High = confident
  clarityScore: number;     // High = clear speech
  energyLevel: number;      // High = loud/energetic
  pitchStability: number;   // High = monotone, Low = expressive
  fatigueScore: number;     // NEW: High = tired

  // Advanced Tech Metrics
  hnr: number;              // Harmonic-to-Noise Ratio (0-40 dB)
  speechRate: number;       // Est. Words Per Minute
  shimmer: number;          // Amplitude instability
  jitter: number;           // Frequency instability (micro-tremor)
  spectralSlope: number;    // Brilliance/Mumble ratio
  hesitation: number;       // Filler sound indicator

  // Flags
  isHighStress: boolean;
  isHighFatigue: boolean;
  isConfused: boolean;
  isQuiet: boolean;
  hasVoice: boolean;

  timestamp: number;
}

export interface VoiceAnalysisResult {
  metrics: VoiceMetrics;
  history: VoiceMetrics[];
  speakerSegments: SpeakerSegment[];
  overallScores: {
    avgStress: number;
    avgConfidence: number;
    avgClarity: number;
    avgFatigue: number;
    peakStress: number;
    speakingRatio: number;
  };
}

// Heuristic metric computation from audio buffer
export function computeVoiceMetrics(
  buffer: Float32Array,
  sampleRate: number,
  _previousPitch: number,
  pitchHistory: number[],
  timestamp: number,
  rawRms: number // Capture actual raw volume for energy
): VoiceMetrics {
  const rms = computeRMS(buffer);
  const volumeDb = rawRms > 0 ? 20 * Math.log10(rawRms) : -100;
  const pitchHz = estimatePitch(buffer, sampleRate);
  const zcr = computeZCR(buffer);
  const centroid = computeSpectralCentroid(buffer);
  
  // High-sensitivity Voice Activity Detection
  const hasVoice = hasVoiceActivity(buffer, 0.005) || rawRms > 0.002;

  // HNR Estimation (Harmonic-to-Noise Ratio)
  const hnr = estimateHNR(buffer);
  const shimmer = computeShimmer(buffer);

  // Pitch Correction: Restrict to human vocal range (80Hz - 450Hz)
  // At 16kHz, this is lags 35 to 200
  let vocalPitch = pitchHz;
  if (vocalPitch < 70 || vocalPitch > 500) vocalPitch = 0; 

  const avgPitch = pitchHistory.length > 0
    ? pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length
    : vocalPitch;
  const pitchVariance = avgPitch > 0 ? Math.min(1, Math.abs(vocalPitch - avgPitch) / avgPitch) : 0;

  // Stress Score: balanced logic to prevent "Instant 100"
  const normalizedRms = Math.min(1, rawRms * 35); 
  const stressScore = hasVoice
    ? Math.round(Math.min(100, (normalizedRms * 30) + (zcr * 80) + (pitchVariance * 50)))
    : 0;

  // Confidence Score: stable pitch + good volume - stress
  const pitchNorm = pitchHz > 0 ? Math.min(1, pitchHz / 350) : 0;
  const confidenceScore = hasVoice
    ? Math.round(Math.min(100, Math.max(0,
      80 - (stressScore * 0.4) + (pitchNorm * 20) + (normalizedRms * 10) - (pitchVariance * 20)
    )))
    : 0;

  // Clarity: spectral centroid (brightness) and low ZCR variance
  const centroidNorm = Math.min(1, centroid / (buffer.length * 0.4));
  const clarityScore = hasVoice
    ? Math.round(Math.min(100, (centroidNorm * 75) + (Math.max(0, 25 - zcr * 80))))
    : 0;

  // NEW: Fatigue Detection (Vocal Sag + HNR + Monotone)
  const hnrNorm = Math.max(0, Math.min(1, (hnr - 5) / 15)); // 5-20dB range
  const fatigueScore = hasVoice
    ? Math.round(Math.min(100, ( (1 - pitchVariance) * 30 ) + ( (1 - centroidNorm) * 30 ) + ( (1 - hnrNorm) * 40 )))
    : 0;

  const energyLevel = Math.round(Math.min(100, (rawRms / 0.15) * 100)); 
  const pitchStability = Math.round(Math.max(0, 100 - pitchVariance * 100));
  
  const jitter = Math.round(pitchVariance * 100);

  return {
    rms,
    volumeDb,
    pitchHz,
    pitchVariance,
    zcr,
    spectralCentroid: centroid,
    stressScore: Math.max(0, stressScore),
    confidenceScore: Math.max(0, confidenceScore),
    clarityScore: Math.max(0, clarityScore),
    energyLevel,
    pitchStability,
    fatigueScore,
    hnr,
    speechRate: 0, // Updated in component state
    shimmer,
    jitter,
    spectralSlope: Math.round(centroidNorm * 100),
    hesitation: Math.round(Math.min(100, (zcr * 50) + (pitchVariance * 50))), // Placeholder, updated in RAF
    isHighStress: stressScore > 75,
    isHighFatigue: fatigueScore > 75,
    isConfused: pitchVariance > 0.4 && stressScore > 55,
    isQuiet: rms < 0.015 && hasVoice,
    hasVoice,
    timestamp,
  };
}

// ─── Technical Voice Metrics ──────────────────────────────────────────────────

export function estimateHNR(buffer: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i];
  if (sumSq < 0.0001) return 0;
  
  // Normalized Autocorrelation peak in human pitch range
  let maxAc = 0;
  const startLag = 35; // ~450Hz
  const endLag = 220;  // ~70Hz
  for (let lag = startLag; lag < endLag; lag++) {
    let s = 0;
    for (let i = 0; i < buffer.length - lag; i++) s += buffer[i] * buffer[i + lag];
    if (s > maxAc) maxAc = s;
  }
  
  const acNorm = maxAc / sumSq;
  // HNR formula: 10 * log10( R / (1-R) )
  // We use a softer floor for R to ensure we get a value on clean mics
  const R = Math.max(0.01, Math.min(0.99, acNorm));
  const hnr = 10 * Math.log10(R / (1 - R));
  return Math.max(0, Math.min(30, hnr + 15)); // Offset to match dB ranges (0-30dB)
}

export function computeShimmer(buffer: Float32Array): number {
  // Measures period-to-period amplitude variability
  let peaks: number[] = [];
  for (let i = 1; i < buffer.length - 1; i++) {
    if (buffer[i] > buffer[i-1] && buffer[i] > buffer[i+1] && buffer[i] > 0.02) {
      peaks.push(buffer[i]);
    }
  }
  if (peaks.length < 2) return 0;
  let totalDiff = 0;
  for (let i = 0; i < peaks.length - 1; i++) {
    totalDiff += Math.abs(peaks[i] - peaks[i+1]);
  }
  return (totalDiff / (peaks.length - 1)) * 100;
}

// Heuristic speaker diarization: cluster by pitch range
export function diarize(pitchHistory: number[]): 'SPEAKER_A' | 'SPEAKER_B' {
  if (pitchHistory.length === 0) return 'SPEAKER_A';
  const avg = pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length;
  return avg < 160 ? 'SPEAKER_A' : 'SPEAKER_B';
}

export function computeOverallScores(history: VoiceMetrics[]) {
  if (history.length === 0) return { avgStress: 0, avgConfidence: 0, avgClarity: 0, avgFatigue: 0, avgHesitation: 0, peakStress: 0, speakingRatio: 0 };
  const voiced = history.filter(m => m.hasVoice);
  const total = history.length;
  return {
    avgStress: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.stressScore, 0) / voiced.length) : 0,
    avgConfidence: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.confidenceScore, 0) / voiced.length) : 0,
    avgClarity: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.clarityScore, 0) / voiced.length) : 0,
    avgFatigue: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.fatigueScore, 0) / voiced.length) : 0,
    avgHesitation: history.length ? Math.round(history.reduce((s, m) => s + m.hesitation, 0) / history.length) : 0,
    peakStress: Math.round(Math.max(...history.map(m => m.stressScore))),
    speakingRatio: Math.round((voiced.length / total) * 100),
  };
}
