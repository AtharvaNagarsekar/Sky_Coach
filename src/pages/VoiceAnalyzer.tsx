import { useRef, useState, useEffect, useCallback } from 'react';
import Header from '../components/Header';
import { computeVoiceMetrics, computeOverallScores } from '../services/voiceAnalysis';
import type { VoiceMetrics } from '../services/voiceAnalysis';
import { preprocessAudio } from '../services/audioProcessor';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
} from 'recharts';

// ─── Circular Gauge ───────────────────────────────────────────────────────────
function CircularGauge({ value, max = 100, label, color, size = 110 }: {
  value: number; max?: number; label: string; color: string; size?: number;
}) {
  const r = (size / 2) - 12;
  const circ = 2 * Math.PI * r;
  const fill = circ * (1 - value / max);
  const scoreColor = value > 70 ? color : value > 40 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="gauge-wrap">
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={10} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={scoreColor} strokeWidth={10}
          strokeDasharray={circ} strokeDashoffset={fill}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease', filter: `drop-shadow(0 0 6px ${scoreColor})` }}
        />
        <text x={size / 2} y={size / 2 + 6} textAnchor="middle"
          fill={scoreColor} fontSize={size < 100 ? 16 : 20} fontWeight={700}
          fontFamily="Share Tech Mono" transform={`rotate(90, ${size / 2}, ${size / 2})`}>
          {value}
        </text>
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
}

// ─── VU Meter ─────────────────────────────────────────────────────────────────
function VUMeter({ value, label }: { value: number; label: string }) {
  const bars = 20;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 40 }}>
        {Array.from({ length: bars }, (_, i) => {
          const threshold = ((i + 1) / bars) * 100;
          const active = value >= threshold;
          const barColor = i < 14 ? 'var(--green)' : i < 17 ? 'var(--yellow)' : 'var(--red)';
          return (
            <div key={i} style={{
              flex: 1, borderRadius: 2,
              height: `${40 + i * 3}%`,
              background: active ? barColor : 'rgba(255,255,255,0.06)',
              transition: 'background 0.1s',
            }} />
          );
        })}
      </div>
      <div style={{ fontFamily: 'Share Tech Mono', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{value}%</div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function VoiceAnalyzer() {
  const [mode, setMode] = useState<'live' | 'upload'>('live');
  const [isRecording, setIsRecording] = useState(false);
  const [metrics, setMetrics] = useState<VoiceMetrics | null>(null);
  const [history, setHistory] = useState<VoiceMetrics[]>([]);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isPlayingFile, setIsPlayingFile] = useState(false);
  const [analysisTime, setAnalysisTime] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const pitchHistory = useRef<number[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const overall = computeOverallScores(history);

  // Draw waveform on canvas
  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(5,10,20,0)';

    // Gradient line
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#00d4ff');
    grad.addColorStop(0.5, '#b983ff');
    grad.addColorStop(1, '#ffb347');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 8;

    ctx.beginPath();
    const sliceW = W / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const x = i * sliceW;
      const y = ((buf[i] + 1) / 2) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, []);

  // RAF loop
  const rafLoop = useCallback(() => {
    if (!analyserRef.current) return;
    const analyser = analyserRef.current;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    const processed = preprocessAudio(buf);
    const m = computeVoiceMetrics(processed, analyser.context.sampleRate, pitchHistory.current[pitchHistory.current.length - 1] || 0, pitchHistory.current, Date.now());

    if (m.pitchHz > 50 && m.pitchHz < 500) {
      pitchHistory.current = [...pitchHistory.current.slice(-50), m.pitchHz];
    }

    setMetrics(m);
    setHistory(prev => [...prev.slice(-300), m]);

    // Alert logic
    if (m.isHighStress) setAlerts(prev => prev.includes('HIGH STRESS DETECTED') ? prev : [...prev.slice(-2), 'HIGH STRESS DETECTED']);
    if (m.isConfused) setAlerts(prev => prev.includes('CONFUSION INDICATORS DETECTED') ? prev : [...prev.slice(-2), 'CONFUSION INDICATORS DETECTED']);

    drawWaveform(analyser);
    animFrameRef.current = requestAnimationFrame(rafLoop);
  }, [drawWaveform]);

  const startLive = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, sampleRate: 16000 }, video: false });
      streamRef.current = stream;
      audioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      const src = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyserRef.current = analyser;
      pitchHistory.current = [];
      setHistory([]);
      setAlerts([]);
      setIsRecording(true);
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => setAnalysisTime(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
      rafLoop();
    } catch {
      alert('Microphone access denied. Please allow microphone permissions.');
    }
  };

  const stopLive = () => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setHistory([]);
    setAlerts([]);
    pitchHistory.current = [];

    const arrayBuf = await file.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    audioCtxRef.current = ctx;

    const decodedBuf = await ctx.decodeAudioData(arrayBuf);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    analyserRef.current = analyser;

    const src = ctx.createBufferSource();
    src.buffer = decodedBuf;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    fileSourceRef.current = src;

    src.start(0);
    setIsPlayingFile(true);
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => setAnalysisTime(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    rafLoop();

    src.onended = () => {
      cancelAnimationFrame(animFrameRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      setIsPlayingFile(false);
    };
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Recharts data
  const chartData = history.filter((_, i) => i % 5 === 0).slice(-60).map((m, i) => ({
    t: i,
    stress: m.stressScore,
    conf: m.confidenceScore,
    clarity: m.clarityScore,
    energy: m.energyLevel,
  }));

  const radarData = metrics ? [
    { subject: 'Confidence', A: metrics.confidenceScore },
    { subject: 'Clarity', A: metrics.clarityScore },
    { subject: 'Stability', A: metrics.pitchStability },
    { subject: 'Energy', A: metrics.energyLevel },
    { subject: 'Calm', A: Math.max(0, 100 - metrics.stressScore) },
  ] : [];

  const isActive = isRecording || isPlayingFile;
  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Header
        title="Pilot Voice Analyzer"
        subtitle="Real-time stress, confidence, clarity & pitch analysis"
        statusLabel={isRecording ? 'LIVE MIC' : isPlayingFile ? 'ANALYZING FILE' : 'READY'}
        statusActive={isActive}
      >
        {isActive && (
          <div style={{ fontFamily: 'Share Tech Mono', fontSize: '0.85rem', color: 'var(--cyan-primary)' }}>
            {fmtTime(analysisTime)}
          </div>
        )}
      </Header>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 0 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Alerts */}
        {alerts.map((a, i) => (
          <div key={i} className="alert-banner danger fade-in">
            <span style={{ fontSize: '1.1rem' }}>⚠️</span>
            <span style={{ fontWeight: 600 }}>{a}</span>
          </div>
        ))}

        {/* Controls */}
        <div className="glass-panel" style={{ padding: '20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div className="tab-bar" style={{ minWidth: 260 }}>
              <button className={`tab-btn${mode === 'live' ? ' active' : ''}`} onClick={() => { if (!isActive) setMode('live'); }}>🎙 Live Mic</button>
              <button className={`tab-btn${mode === 'upload' ? ' active' : ''}`} onClick={() => { if (!isActive) setMode('upload'); }}>📁 Upload File</button>
            </div>

            {mode === 'live' && (
              isRecording
                ? <button className="btn btn-danger" onClick={stopLive}>■ Stop Recording</button>
                : <button className="btn btn-primary" onClick={startLive}>▶ Start Recording</button>
            )}

            {mode === 'upload' && !isPlayingFile && (
              <label className="btn btn-amber" style={{ cursor: 'pointer' }}>
                📁 Load Audio File
                <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleFileUpload} />
              </label>
            )}
            {fileName && <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{fileName}</span>}
          </div>
        </div>

        {/* Waveform */}
        <div className="glass-panel" style={{ padding: '16px', flexShrink: 0 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Waveform</div>
          <canvas ref={canvasRef} width={1200} height={80} style={{ width: '100%', height: 80, borderRadius: 8, background: 'rgba(5,10,20,0.6)' }} />
        </div>

        {/* Live Gauges */}
        {metrics && (
          <div className="grid-4">
            {[
              { label: 'STRESS',     value: metrics.stressScore,     color: 'var(--red)' },
              { label: 'CONFIDENCE', value: metrics.confidenceScore,  color: 'var(--cyan-primary)' },
              { label: 'CLARITY',    value: metrics.clarityScore,     color: 'var(--green)' },
              { label: 'ENERGY',     value: metrics.energyLevel,      color: 'var(--amber)' },
            ].map(g => (
              <div key={g.label} className="glass-card" style={{ display: 'flex', justifyContent: 'center', padding: '20px 12px' }}>
                <CircularGauge value={g.value} label={g.label} color={g.color} />
              </div>
            ))}
          </div>
        )}

        <div className="grid-2">
          {/* Time-series chart */}
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Timeline — Stress / Confidence / Clarity</div>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} hide />
                  <Tooltip contentStyle={{ background: 'var(--bg-panel-solid)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.75rem' }} />
                  <Line type="monotone" dataKey="stress"  stroke="var(--red)"          strokeWidth={2} dot={false} name="Stress" />
                  <Line type="monotone" dataKey="conf"    stroke="var(--cyan-primary)" strokeWidth={2} dot={false} name="Confidence" />
                  <Line type="monotone" dataKey="clarity" stroke="var(--green)"        strokeWidth={2} dot={false} name="Clarity" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {isActive ? 'Collecting data...' : 'Start analysis to see chart'}
              </div>
            )}
          </div>

          {/* Radar */}
          <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, alignSelf: 'flex-start' }}>Voice Profile</div>
            {radarData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="rgba(255,255,255,0.08)" />
                  <PolarAngleAxis dataKey="subject" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Radar name="Voice" dataKey="A" stroke="var(--cyan-primary)" fill="var(--cyan-primary)" fillOpacity={0.15} strokeWidth={2} />
                </RadarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                Radar will appear during analysis
              </div>
            )}
          </div>
        </div>

        {/* Overall Report */}
        {history.length > 20 && (
          <div className="glass-panel" style={{ padding: '20px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Session Report</h3>
              {!isActive && (
                <span className="badge badge-green">Analysis Complete</span>
              )}
            </div>
            <div className="grid-4" style={{ marginBottom: 16 }}>
              <StatCard label="Avg Stress" value={overall.avgStress} unit="%" warn={70} />
              <StatCard label="Avg Confidence" value={overall.avgConfidence} unit="%" good={60} />
              <StatCard label="Avg Clarity" value={overall.avgClarity} unit="%" good={60} />
              <StatCard label="Peak Stress" value={overall.peakStress} unit="%" warn={60} />
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {overall.avgStress > 70 && <Tip icon="⚠️" text="High average stress detected. Practice slow, deliberate read-backs." />}
              {overall.avgConfidence < 50 && <Tip icon="📢" text="Low confidence indicators. Speak with authority and project your voice." />}
              {overall.avgClarity < 50 && <Tip icon="🎙" text="Clarity needs improvement. Enunciate each number and callsign clearly." />}
              {overall.avgStress < 40 && overall.avgConfidence > 60 && <Tip icon="✅" text="Excellent composure. Stress and confidence levels within optimal range." color="var(--green)" />}
            </div>
          </div>
        )}

        {/* Pitch & Raw Data */}
        {metrics && (
          <div className="grid-2">
            <div className="glass-panel" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>Raw Measurements</div>
              {[
                { label: 'Fundamental Pitch', value: `${Math.round(metrics.pitchHz)} Hz`, color: 'var(--purple)' },
                { label: 'Volume (dBFS)', value: `${Math.round(metrics.volumeDb)} dB`, color: 'var(--cyan-primary)' },
                { label: 'Zero Crossing Rate', value: metrics.zcr.toFixed(4), color: 'var(--amber)' },
                { label: 'Pitch Stability', value: `${metrics.pitchStability}%`, color: 'var(--green)' },
                { label: 'Voice Active', value: metrics.hasVoice ? 'YES' : 'NO', color: metrics.hasVoice ? 'var(--green)' : 'var(--text-muted)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{row.label}</span>
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: '0.82rem', color: row.color }}>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="glass-panel" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>VU Meters</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <VUMeter value={metrics.stressScore} label="Stress" />
                <VUMeter value={metrics.confidenceScore} label="Confidence" />
                <VUMeter value={metrics.energyLevel} label="Energy Level" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, unit = '', warn, good }: { label: string; value: number; unit?: string; warn?: number; good?: number }) {
  const color = good ? (value >= good ? 'var(--green)' : 'var(--red)') : warn ? (value >= warn ? 'var(--red)' : 'var(--green)') : 'var(--text-primary)';
  return (
    <div className="glass-card" style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1.5rem', fontWeight: 700, color }}>{value}{unit}</div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
    </div>
  );
}

function Tip({ icon, text, color = 'var(--amber)' }: { icon: string; text: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${color}30`, borderRadius: 8, flex: 1, minWidth: 200 }}>
      <span style={{ fontSize: '1rem', flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{text}</span>
    </div>
  );
}
