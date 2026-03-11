import { useRef, useState, useEffect, useCallback } from 'react';
import Header from '../components/Header';
import { computeVoiceMetrics, computeOverallScores } from '../services/voiceAnalysis';
import type { VoiceMetrics } from '../services/voiceAnalysis';
import { preprocessAudio, computeRMS } from '../services/audioProcessor';
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
  const scoreColor = value > 75 ? color : value > 40 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="gauge-wrap" style={{ position: 'relative' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth={12} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={scoreColor} strokeWidth={8}
          strokeDasharray={circ} strokeDashoffset={fill}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1)', filter: `drop-shadow(0 0 4px ${scoreColor}80)` }}
        />
        <text x={size / 2} y={size / 2 + 6} textAnchor="middle"
          fill={scoreColor} fontSize={size < 100 ? 16 : 22} fontWeight={800}
          fontFamily="Share Tech Mono" transform={`rotate(90, ${size / 2}, ${size / 2})`}>
          {value}
        </text>
      </svg>
      <div style={{ 
        position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)', 
        fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.1em',
        background: 'rgba(0,0,0,0.6)', padding: '2px 8px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)'
      }}>
        {label}
      </div>
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
  const [isPlayingFile, setIsPlayingFile] = useState(false);
  const [analysisTime, setAnalysisTime] = useState(0);
  const [logs, setLogs] = useState<{ id: number, msg: string, type: 'info' | 'warn' | 'crit' }[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const pitchHistory = useRef<number[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fftCanvasRef = useRef<HTMLCanvasElement>(null);
  const syllablesRef = useRef<{ts: number}[]>([]); 
  const [speechRate, setSpeechRate] = useState(0);
  
  const pauseTracker = useRef({ voice: 0, silence: 0, lastChange: Date.now() });

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

    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#00d4ff');
    grad.addColorStop(0.5, '#b983ff');
    grad.addColorStop(1, '#ffb347');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;

    ctx.beginPath();
    const sliceW = W / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const x = i * sliceW;
      const y = ((buf[i] + 1) / 2) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, []);

  // NEW: Frequency Spectrum Visualizer
  const drawSpectrum = useCallback((analyser: AnalyserNode) => {
    const canvas = fftCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    
    const barWidth = (W / freqData.length) * 2.5;
    let x = 0;
    for (let i = 0; i < freqData.length; i++) {
      const barH = (freqData[i] / 255) * H;
      const hue = (i / freqData.length) * 360;
      ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.8)`;
      ctx.fillRect(x, H - barH, barWidth, barH);
      x += barWidth + 1;
    }
  }, []);

  // RAF loop
  const rafLoop = useCallback(() => {
    if (!analyserRef.current) return;
    const now = Date.now();
    const analyser = analyserRef.current;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    const processed = preprocessAudio(buf);
    const rawRms = computeRMS(buf); 

    // Standard high-fidelity Energy mapping (no auto-flattening)
    const normalizedEnergy = Math.min(100, (rawRms / 0.1) * 100);

    const m = computeVoiceMetrics(
      processed, 
      analyser.context.sampleRate, 
      pitchHistory.current[pitchHistory.current.length - 1] || 0, 
      pitchHistory.current, 
      now,
      rawRms
    );
    // Override with calibrated energy
    m.energyLevel = Math.round(normalizedEnergy);

    // Temporal Hesitation Logic
    const dur = now - pauseTracker.current.lastChange;
    pauseTracker.current.lastChange = now;
    if (m.hasVoice) {
      pauseTracker.current.voice = Math.min(2000, pauseTracker.current.voice + dur);
      pauseTracker.current.silence = Math.max(0, pauseTracker.current.silence - dur/2);
    } else {
      pauseTracker.current.silence = Math.min(2000, pauseTracker.current.silence + dur);
      pauseTracker.current.voice = Math.max(0, pauseTracker.current.voice - dur/4);
    }
    const hesitationRatio = (pauseTracker.current.silence / Math.max(1, pauseTracker.current.voice + pauseTracker.current.silence));
    m.hesitation = Math.round(hesitationRatio * 100);

    if (m.pitchHz > 50 && m.pitchHz < 500) {
      pitchHistory.current = [...pitchHistory.current.slice(-50), m.pitchHz];
    }

    // WPM Logic: High-speed Syllable Flux Detection
    // Detect onset of speech energy (syllable boundary)
    if (m.hasVoice && m.energyLevel > 15) {
      const lastPeak = syllablesRef.current[syllablesRef.current.length - 1]?.ts || 0;
      if (now - lastPeak > 100) { // Reduced from 150ms for aviation rapid-fire
        syllablesRef.current.push({ ts: now });
      }
    }
    syllablesRef.current = syllablesRef.current.filter(s => now - s.ts < 8000); // 8s window
    const currentWpm = Math.round((syllablesRef.current.length / 8) * 60 / 1.3); // 1.3 syllables/word avg in tech English
    setSpeechRate(prev => Math.round(prev * 0.8 + currentWpm * 0.2));
    m.speechRate = currentWpm; // Use real-time value for metrics

    // Dynamic logging for professional feel
    if (m.hasVoice && Math.random() < 0.05) {
      setLogs(prev => [{ id: Date.now(), msg: `SYNC: Vocal Activity Detected [${Math.round(m.pitchHz)}Hz]`, type: 'info' }, ...prev.slice(0, 15)]);
    }
    if (currentWpm > 180) {
      setLogs(prev => [{ id: Date.now(), msg: `WARNING: High WPM Threshold Breach [${currentWpm}]`, type: 'warn' }, ...prev.slice(0, 15)]);
    }

    setMetrics(m);
    setHistory(prev => [...prev.slice(-2000), m]);

    // Radio-Aware Sustained Alert Logic (30s Rolling Average)
    const voicedHistory = history.filter(h => h.hasVoice).slice(-600); 
    if (voicedHistory.length > 100) { 
      const avgStress = voicedHistory.reduce((s, h) => s + h.stressScore, 0) / voicedHistory.length;
      const avgFatigue = voicedHistory.reduce((s, h) => s + h.fatigueScore, 0) / voicedHistory.length;
      
      if (avgStress > 75) {
        setAlerts(prev => prev.includes('SUSTAINED STRESS (30S AVG)') ? prev : [...prev.slice(-2), 'SUSTAINED STRESS (30S AVG)']);
      }
      if (avgFatigue > 70) {
        setAlerts(prev => prev.includes('SUSTAINED FATIGUE (30S AVG)') ? prev : [...prev.slice(-2), 'SUSTAINED FATIGUE (30S AVG)']);
      }
    }

    drawWaveform(analyser);
    drawSpectrum(analyser);
    animFrameRef.current = requestAnimationFrame(rafLoop);
  }, [drawWaveform, drawSpectrum, speechRate, history]);

  const startLive = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: false, 
          autoGainControl: false, // Prevents browser from flattening radio dynamics
          sampleRate: 16000 
        }, 
        video: false 
      });
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
      alert('Microphone access denied.');
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

  const chartData = history.filter((_, i) => i % 5 === 0).slice(-60).map((m, i) => ({
    t: i,
    stress: m.stressScore,
    conf: m.confidenceScore,
    clarity: m.clarityScore,
    energy: m.energyLevel,
    fatigue: m.fatigueScore,
  }));

  const radarData = metrics ? [
    { subject: 'Confidence', A: metrics.confidenceScore },
    { subject: 'Clarity', A: metrics.clarityScore },
    { subject: 'Stability', A: metrics.pitchStability },
    { subject: 'Energy', A: metrics.energyLevel },
    { subject: 'Fatigue', A: metrics.fatigueScore },
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
        {alerts.map((a, i) => (
          <div key={i} className="alert-banner danger fade-in">
            <span style={{ fontSize: '1.1rem' }}>⚠️</span>
            <span style={{ fontWeight: 600 }}>{a}</span>
          </div>
        ))}

        <div className="glass-panel" style={{ padding: '20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div className="tab-bar" style={{ minWidth: 260 }}>
              <button className={`tab-btn${mode === 'live' ? ' active' : ''}`} onClick={() => { if (!isActive) setMode('live'); }}>🎙 Live Mic</button>
              <button className={`tab-btn${mode === 'upload' ? ' active' : ''}`} onClick={() => { if (!isActive) setMode('upload'); }}>📁 Upload File</button>
            </div>
            {mode === 'live' && (isRecording ? <button className="btn btn-danger" onClick={stopLive}>■ Stop Recording</button> : <button className="btn btn-primary" onClick={startLive}>▶ Start Recording</button>)}
            {mode === 'upload' && !isPlayingFile && (
              <label className="btn btn-amber" style={{ cursor: 'pointer' }}>📁 Load Audio File<input type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleFileUpload} /></label>
            )}
          </div>
        </div>

        <div className="grid-2" style={{ gap: 20 }}>
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>Temporal Waveform</div>
            <canvas ref={canvasRef} width={600} height={80} style={{ width: '100%', height: 80, borderRadius: 8, background: 'rgba(5,10,20,0.4)' }} />
          </div>
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>Frequency Spectrum (FFT)</div>
            <canvas ref={fftCanvasRef} width={600} height={80} style={{ width: '100%', height: 80, borderRadius: 8, background: 'rgba(5,10,20,0.4)' }} />
          </div>
        </div>

        {metrics && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
            {[
              { label: 'STRESS',     value: metrics.stressScore,     color: 'var(--red)' },
              { label: 'CONFIDENCE', value: metrics.confidenceScore,  color: 'var(--cyan-primary)' },
              { label: 'CLARITY',    value: metrics.clarityScore,     color: 'var(--green)' },
              { label: 'ENERGY',     value: metrics.energyLevel,      color: 'var(--amber)' },
              { label: 'FATIGUE',    value: metrics.fatigueScore,     color: '#ff7e33' },
            ].map(g => (
              <div key={g.label} className="glass-card" style={{ display: 'flex', justifyContent: 'center', padding: '20px 12px' }}>
                <CircularGauge value={g.value} label={g.label} color={g.color} />
              </div>
            ))}
          </div>
        )}

        <div className="grid-2">
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>Timeline — Stress / Confidence / Clarity</div>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} hide />
                  <Tooltip contentStyle={{ background: 'var(--bg-panel-solid)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.75rem' }} />
                  <Line type="monotone" dataKey="stress"  stroke="var(--red)"          strokeWidth={2} dot={false} name="Stress" />
                  <Line type="monotone" dataKey="conf"    stroke="var(--cyan-primary)" strokeWidth={2} dot={false} name="Confidence" />
                  <Line type="monotone" dataKey="clarity" stroke="var(--green)"        strokeWidth={2} dot={false} name="Clarity" />
                  <Line type="monotone" dataKey="fatigue" stroke="#ff7e33"             strokeWidth={1} dot={false} name="Fatigue" />
                </LineChart>
              </ResponsiveContainer>
            ) : <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>No Data</div>}
          </div>

          <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8, alignSelf: 'flex-start' }}>Voice Profile</div>
            {radarData.length > 0 && (
              <ResponsiveContainer width="100%" height={200}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="rgba(255,255,255,0.08)" />
                  <PolarAngleAxis dataKey="subject" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Radar name="Voice" dataKey="A" stroke="var(--cyan-primary)" fill="var(--cyan-primary)" fillOpacity={0.15} strokeWidth={2} />
                </RadarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {metrics && (
          <div className="glass-panel" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <div style={{ width: 4, height: 16, background: 'var(--cyan-primary)', borderRadius: 2 }} />
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>SUB-SCORE CONTRIBUTORS</div>
            </div>
            <div className="grid-3" style={{ gap: 40 }}>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase' }}>Fatigue Contributors</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <SubBar label="Vocal Sag" value={Math.round((1 - metrics.spectralSlope/100) * 100)} color="#ff7e33" />
                  <SubBar label="Energy Decay" value={Math.max(0, 50 - metrics.energyLevel)} color="#ff7e33" />
                  <SubBar label="Speech Rate Lag" value={speechRate < 100 && metrics.hasVoice ? 60 : 0} color="#ff7e33" />
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase' }}>Stress Contributors</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <SubBar label="Micro-Jitter" value={metrics.jitter} color="var(--red)" />
                  <SubBar label="Vocal Tension" value={Math.round(metrics.zcr * 200)} color="var(--red)" />
                  <SubBar label="Rapid Speech" value={Math.min(100, Math.round(Math.max(0, (metrics.speechRate - 130) * 1.5)))} color="var(--red)" />
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase' }}>Cognitive State</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <SubBar label="Hesitation" value={metrics.hesitation} color="var(--cyan-primary)" />
                  <SubBar label="Speech Rate (WPM)" value={Math.min(100, (speechRate / 200) * 100)} color="var(--cyan-primary)" />
                  <SubBar label="Clarity Index" value={metrics.clarityScore} color="var(--cyan-primary)" />
                </div>
              </div>
            </div>
          </div>
        )}

        {history.length > 20 && (
          <div className="glass-panel" style={{ padding: '20px', flexShrink: 0 }}>
            <h3 style={{ marginTop: 0 }}>Session Report</h3>
            <div className="grid-5" style={{ marginBottom: 16 }}>
              <StatCard label="Avg Stress" value={overall.avgStress} unit="%" warn={70} />
              <StatCard label="Avg Confidence" value={overall.avgConfidence} unit="%" good={60} />
              <StatCard label="Avg Clarity" value={overall.avgClarity} unit="%" good={60} />
              <StatCard label="Avg Fatigue" value={overall.avgFatigue} unit="%" warn={60} />
              <StatCard label="Avg Hesitation" value={overall.avgHesitation} unit="%" warn={50} />
            </div>
          </div>
        )}

        {metrics && (
          <div className="grid-2">
            <div className="glass-panel" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 14 }}>Technical Metrics</div>
              {[
                { label: 'Fundamental Pitch', value: `${Math.round(metrics.pitchHz)} Hz`, color: 'var(--purple)' },
                { label: 'Speech Rate (Est)', value: `${Math.round(speechRate)} WPM`, color: 'var(--yellow)' },
                { label: 'Pitch Stability', value: `${metrics.pitchStability}%`, color: 'var(--green)' },
                { label: 'HF Brilliance', value: `${metrics.spectralSlope}%`, color: 'var(--green)' },
                { label: 'Voice Active', value: metrics.hasVoice ? 'YES' : 'NO', color: metrics.hasVoice ? 'var(--green)' : 'var(--text-muted)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{row.label}</span>
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: '0.82rem', color: row.color }}>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="glass-panel" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 14 }}>Diagnostic Stream</div>
              <div style={{ 
                height: 140, overflow: 'hidden', padding: '10px', 
                background: 'rgba(0,0,0,0.3)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)',
                display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'Share Tech Mono', fontSize: '0.7rem'
              }}>
                {logs.map(log => (
                  <div key={log.id} style={{ color: log.type === 'warn' ? 'var(--amber)' : log.type === 'crit' ? 'var(--red)' : 'var(--cyan-primary)' }}>
                    [{new Date(log.id).toLocaleTimeString([], { hour12: false })}] {log.msg}
                  </div>
                ))}
                {logs.length === 0 && <div style={{ color: 'var(--text-muted)' }}>IDLE - NO TELEMETRY STREAM...</div>}
              </div>
            </div>
            <div className="glass-panel" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 14 }}>Vocal Power Projection</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <VUMeter value={metrics.stressScore} label="Pressure" />
                <VUMeter value={metrics.confidenceScore} label="Firmness" />
                <VUMeter value={metrics.energyLevel} label="Projection" />
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
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

function SubBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'Share Tech Mono' }}>{value}%</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, value)}%`, background: color, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}
