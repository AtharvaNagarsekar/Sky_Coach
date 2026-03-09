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

  // Flags
  isHighStress: boolean;
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
  timestamp: number
): VoiceMetrics {
  const rms = computeRMS(buffer);
  const volumeDb = rms > 0 ? 20 * Math.log10(rms) : -100;
  const pitchHz = estimatePitch(buffer, sampleRate);
  const zcr = computeZCR(buffer);
  const centroid = computeSpectralCentroid(buffer);
  const hasVoice = hasVoiceActivity(buffer, 0.015);

  // Pitch variance: how much pitch deviates from running average
  const avgPitch = pitchHistory.length > 0
    ? pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length
    : pitchHz;
  const pitchVariance = avgPitch > 0 ? Math.min(1, Math.abs(pitchHz - avgPitch) / avgPitch) : 0;

  // Stress Score: high RMS + high ZCR + high pitch variance → stressed
  const normalizedRms = Math.min(1, rms * 10);
  const stressScore = hasVoice
    ? Math.round(Math.min(100, (normalizedRms * 35) + (zcr * 2000 * 25) + (pitchVariance * 40)))
    : 0;

  // Confidence Score: moderate-to-high pitch + moderate ZCR + good volume
  const pitchNorm = pitchHz > 0 ? Math.min(1, pitchHz / 300) : 0;
  const confidenceScore = hasVoice
    ? Math.round(Math.min(100, Math.max(0,
      80 - (stressScore * 0.3) + (pitchNorm * 20) - (pitchVariance * 30)
    )))
    : 0;

  // Clarity: low ZCR variance, good centroid range
  const centroidNorm = Math.min(1, centroid / (buffer.length * 0.3));
  const clarityScore = hasVoice
    ? Math.round(Math.min(100, (centroidNorm * 60) + (40 - zcr * 1000 * 0.4)))
    : 0;

  const energyLevel = Math.round(Math.min(100, normalizedRms * 100));
  const pitchStability = Math.round(Math.max(0, 100 - pitchVariance * 100));

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
    isHighStress: stressScore > 70,
    isConfused: pitchVariance > 0.4 && stressScore > 50,
    isQuiet: rms < 0.02 && hasVoice,
    hasVoice,
    timestamp,
  };
}

// Heuristic speaker diarization: cluster by pitch range
// Lower pitch = Pilot (typically male, 85-180Hz), Higher = ATC (varies)
export function diarize(pitchHistory: number[]): 'SPEAKER_A' | 'SPEAKER_B' {
  if (pitchHistory.length === 0) return 'SPEAKER_A';
  const avg = pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length;
  return avg < 160 ? 'SPEAKER_A' : 'SPEAKER_B';
}

export function computeOverallScores(history: VoiceMetrics[]) {
  if (history.length === 0) return { avgStress: 0, avgConfidence: 0, avgClarity: 0, peakStress: 0, speakingRatio: 0 };
  const voiced = history.filter(m => m.hasVoice);
  const total = history.length;
  return {
    avgStress: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.stressScore, 0) / voiced.length) : 0,
    avgConfidence: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.confidenceScore, 0) / voiced.length) : 0,
    avgClarity: voiced.length ? Math.round(voiced.reduce((s, m) => s + m.clarityScore, 0) / voiced.length) : 0,
    peakStress: Math.round(Math.max(...history.map(m => m.stressScore))),
    speakingRatio: Math.round((voiced.length / total) * 100),
  };
}
