import { useState, useRef, useEffect, useCallback } from 'react';
import Header from '../components/Header';
import {
  SITUATIONS,
  buildSessionContext, getATCResponse, validateReadback, aggregateStats,
} from '../services/simulatorEngine';
import type { ConversationMessage, ReadbackValidation, SessionStats } from '../services/simulatorEngine';
import { transcribeAudio } from '../services/transcriptionService';
import { speakATC, cancelTTS, initTTS } from '../services/ttsService';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { v4 as uuid } from 'uuid';

// ─── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({ onStart }: { onStart: (situation: string, callsign: string, custom: string) => void }) {
  const [situation, setSituation] = useState('taxi_out');
  const [callsign, setCallsign] = useState('N1234A');
  const [custom, setCustom] = useState('');

  // Group situations
  const groups: Record<string, string[]> = {};
  Object.entries(SITUATIONS).forEach(([key, cfg]) => {
    if (!groups[cfg.group]) groups[cfg.group] = [];
    groups[cfg.group].push(key);
  });

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '30px 0' }}>
      <div className="glass-panel" style={{ padding: 32 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: '3rem', marginBottom: 12 }}>✈️</div>
          <h2 style={{ color: 'var(--cyan-primary)', marginBottom: 8 }}>ATC Radio Simulator</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Configure your training session. Speak as the pilot using your microphone.</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {/* Callsign */}
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Your Aircraft Callsign
            </label>
            <input
              className="input-field"
              value={callsign}
              onChange={e => setCallsign(e.target.value.toUpperCase())}
              placeholder="N1234A"
              style={{ fontFamily: 'Share Tech Mono', letterSpacing: '0.1em', fontSize: '1rem' }}
            />
          </div>

          {/* Situation */}
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Training Scenario
            </label>
            <select className="input-field" value={situation} onChange={e => setSituation(e.target.value)} style={{ fontSize: '0.9rem' }}>
              {Object.entries(groups).map(([group, keys]) => (
                <optgroup key={group} label={`── ${group}`}>
                  {keys.map(k => (
                    <option key={k} value={k}>{SITUATIONS[k].label}</option>
                  ))}
                </optgroup>
              ))}
              <optgroup label="── Custom">
                <option value="custom">Custom Topic</option>
              </optgroup>
            </select>
          </div>

          {/* Custom topic */}
          {situation === 'custom' && (
            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                Custom Scenario Description
              </label>
              <textarea
                className="input-field"
                value={custom}
                onChange={e => setCustom(e.target.value)}
                placeholder="Describe specific scenario, e.g. 'VFR flight to KSAT, requesting flight following'"
                style={{ minHeight: 80, resize: 'vertical', lineHeight: 1.5 }}
              />
            </div>
          )}

          {/* Info about who speaks first */}
          <div className="alert-banner info">
            <span>ℹ️</span>
            <span style={{ fontSize: '0.82rem' }}>
              {situation !== 'custom' && SITUATIONS[situation]
                ? (SITUATIONS[situation].atcSpeaksFirst
                    ? 'ATC will speak first in this scenario.'
                    : 'You (pilot) speak first in this scenario.')
                : 'You (pilot) speak first.'}
            </span>
          </div>

          <button
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onStart(situation, callsign || 'N1234A', custom)}
            disabled={situation === 'custom' && !custom.trim()}
          >
            ▶ Start Training Session
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Readback Validator Panel ──────────────────────────────────────────────────
function ValidationPanel({ validation }: { validation: ReadbackValidation; expected?: string }) {
  const scoreColor = validation.score >= 80 ? 'var(--green)' : validation.score >= 50 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div style={{ marginTop: 10, padding: '14px 16px', background: 'rgba(5,10,20,0.7)', border: `1px solid ${scoreColor}40`, borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: '1.1rem' }}>{validation.isCorrect ? '✅' : '❌'}</span>
        <span style={{ fontFamily: 'Rajdhani', fontWeight: 600, color: scoreColor }}>
          Readback Score: {validation.score}/100
        </span>
        {validation.isCorrect && <span className="badge badge-green">CORRECT</span>}
      </div>

      {validation.errors.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {validation.errors.map((err, i) => (
            <div key={i} style={{ marginBottom: 6, padding: '6px 10px', background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)', borderRadius: 6 }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--red)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                ❌ {err.category}: {err.item}
              </div>
              <div style={{ fontSize: '0.78rem', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>You said: <span style={{ color: 'var(--red)', fontFamily: 'Share Tech Mono' }}>"{err.given}"</span></span>
                <span style={{ color: 'var(--text-muted)' }}>Expected: <span style={{ color: 'var(--green)', fontFamily: 'Share Tech Mono' }}>"{err.expected}"</span></span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: '8px 12px', background: 'rgba(57,255,20,0.06)', border: '1px solid rgba(57,255,20,0.2)', borderRadius: 6, marginBottom: 8 }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--green)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>✓ Correct Readback</div>
        <div style={{ fontFamily: 'Share Tech Mono', fontSize: '0.82rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>{validation.correctReadback}</div>
      </div>

      {validation.feedback && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>💬 {validation.feedback}</div>
      )}
    </div>
  );
}

// ─── Weakness Tracker ─────────────────────────────────────────────────────────
function WeaknessTracker({ stats }: { stats: SessionStats }) {
  const categoryColors: Record<string, string> = {
    callsign: 'var(--cyan-primary)', altitude: 'var(--amber)', heading: 'var(--purple)',
    frequency: 'var(--green)', squawk: 'var(--red)', speed: 'var(--yellow)',
    runway: 'var(--cyan-dim)', phraseology: 'var(--amber)', other: 'var(--text-muted)',
  };
  const chartData = Object.entries(stats.errorsByCategory).map(([cat, count]) => ({ cat, count }));
  const accuracy = stats.totalExchanges ? Math.round((stats.correctReadbacks / stats.totalExchanges) * 100) : 0;

  return (
    <div className="glass-panel" style={{ padding: '20px' }}>
      <h3 style={{ marginBottom: 16 }}>📊 Session Performance</h3>
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="glass-card" style={{ textAlign: 'center', padding: '12px' }}>
          <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1.4rem', color: accuracy >= 80 ? 'var(--green)' : 'var(--red)' }}>{accuracy}%</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Accuracy</div>
        </div>
        <div className="glass-card" style={{ textAlign: 'center', padding: '12px' }}>
          <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1.4rem', color: 'var(--cyan-primary)' }}>{stats.totalExchanges}</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Exchanges</div>
        </div>
        <div className="glass-card" style={{ textAlign: 'center', padding: '12px' }}>
          <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1.4rem', color: 'var(--green)' }}>{stats.correctReadbacks}</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Correct</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Errors by Category</div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} layout="vertical">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="cat" width={80} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--bg-panel-solid)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.75rem' }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {chartData.map((entry) => (
                  <Cell key={entry.cat} fill={categoryColors[entry.cat] || 'var(--text-muted)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}

      {stats.commonMistakes.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Areas to Improve</div>
          {stats.commonMistakes.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: 'rgba(255,179,71,0.06)', border: '1px solid var(--border-amber)', borderRadius: 6 }}>
              <span style={{ color: 'var(--amber)', fontSize: '0.8rem' }}>⚡</span>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{m}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Simulator ────────────────────────────────────────────────────────────
export default function TrainingSimulator() {
  const [phase, setPhase] = useState<'setup' | 'session' | 'debrief'>('setup');
  const [situation, setSituation] = useState('');
  const [callsign, setCallsign] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isATCTalking, setIsATCTalking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentExpected, setCurrentExpected] = useState('');
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [sessionHistory, setSessionHistory] = useState<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => { initTTS(); }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const appendMessage = (msg: ConversationMessage) => setMessages(prev => [...prev, msg]);

  const addATCMessage = useCallback(async (history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
    setIsATCTalking(true);
    setError(null);
    try {
      const { atcText, expectedReadback } = await getATCResponse(history);
      setCurrentExpected(expectedReadback);
      const msg: ConversationMessage = { id: uuid(), role: 'atc', text: atcText, timestamp: new Date() };
      appendMessage(msg);
      setSessionHistory(prev => [...prev, { role: 'assistant', content: atcText }]);
      // TTS
      speakATC(atcText, () => setIsATCTalking(false));
    } catch (e) {
      setError('Failed to get ATC response. Check your connection.');
      setIsATCTalking(false);
    }
  }, []);

  const handleStart = async (sit: string, cs: string, customTopic: string) => {
    setSituation(sit);
    setCallsign(cs);
    setMessages([]);

    const sysCtx = buildSessionContext(sit as any, cs, customTopic);
    const sysMsg = { role: 'system' as const, content: `${sysCtx}\n\nYou are the ATC controller. Provide realistic ATC radio communications for this training scenario. Include EXPECTED_READBACK after each transmission.` };
    const history = [sysMsg];
    setSessionHistory(history);
    setPhase('session');

    const cfg = SITUATIONS[sit];
    const atcFirst = cfg ? cfg.atcSpeaksFirst : false;

    if (atcFirst) {
      await addATCMessage(history);
    } else {
      // Show prompt for pilot to speak first
      const prompt: ConversationMessage = { id: uuid(), role: 'atc', text: `[Session started. You are ${cs}. Initiate contact with ATC for: ${cfg ? cfg.label : customTopic}]`, timestamp: new Date() };
      appendMessage(prompt);
    }
  };

  const startRecording = async () => {
    if (isATCTalking || isProcessing) return;
    try {
      cancelTTS();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
      rec.ondataavailable = e => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.start(100);
      recorderRef.current = rec;
      setIsRecording(true);
    } catch {
      alert('Microphone access required for the simulator.');
    }
  };

  const stopRecordingAndProcess = async () => {
    if (!recorderRef.current || !isRecording) return;
    setIsRecording(false);
    setIsProcessing(true);
    setError(null);

    recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());

    await new Promise(res => setTimeout(res, 200));
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

    try {
      const result = await transcribeAudio(blob, '', [], true); // true = isSimulator
      if (!result.text.trim()) { setIsProcessing(false); return; }

      const pilotMsg: ConversationMessage = { id: uuid(), role: 'pilot', text: result.text, timestamp: new Date() };

      // Validate readback
      const lastATCMsg = [...messages].reverse().find(m => m.role === 'atc' && !m.text.startsWith('[Session'));
      let validation: ReadbackValidation | undefined;
      if (lastATCMsg && currentExpected) {
        validation = await validateReadback(lastATCMsg.text, result.text, currentExpected, callsign);
        pilotMsg.validation = validation;
      }

      appendMessage(pilotMsg);

      // Update session history
      const newHistory = [...sessionHistory, { role: 'user' as const, content: result.text }];
      setSessionHistory(newHistory);
      setIsProcessing(false);

      // Get next ATC response
      await addATCMessage(newHistory);
    } catch (e) {
      setError('Transcription failed. Please try again.');
      setIsProcessing(false);
    }
  };

  const handleEndSession = () => {
    cancelTTS();
    const s = aggregateStats(messages);
    setStats(s);
    setPhase('debrief');
  };

  if (phase === 'setup') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Header title="ATC Training Simulator" subtitle="Interactive radio communication training" />
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 0 0' }}>
          <SetupScreen onStart={handleStart} />
        </div>
      </div>
    );
  }

  if (phase === 'debrief' && stats) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Header title="Session Debrief" subtitle={`${callsign} · ${SITUATIONS[situation]?.label || situation}`}>
          <button className="btn btn-primary" onClick={() => { setPhase('setup'); setMessages([]); setStats(null); }}>New Session</button>
        </Header>
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 0 0', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <WeaknessTracker stats={stats} />
          <div className="glass-panel" style={{ padding: '20px' }}>
            <h3 style={{ marginBottom: 16 }}>Full Conversation Log</h3>
            {messages.map(msg => (
              msg.text.startsWith('[Session') ? null :
              <div key={msg.id} className={`chat-bubble-wrap ${msg.role}`}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 3 }}>
                  {msg.role === 'atc' ? '🎙 ATC' : `✈️ ${callsign}`} · {msg.timestamp.toLocaleTimeString()}
                </div>
                <div className={`chat-bubble ${msg.role}`}>
                  <div style={{ fontFamily: 'Share Tech Mono', fontSize: '0.84rem' }}>{msg.text}</div>
                  {msg.validation && <ValidationPanel validation={msg.validation} expected={''} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Header
        title={`ATC Training · ${SITUATIONS[situation]?.label || situation}`}
        subtitle={`Callsign: ${callsign} · KAUS`}
        statusLabel={isATCTalking ? 'ATC TRANSMITTING' : isRecording ? 'PILOT TRANSMITTING' : isProcessing ? 'PROCESSING' : 'STANDBY'}
        statusActive={isATCTalking || isRecording}
      >
        <button className="btn btn-ghost btn-sm" onClick={handleEndSession}>End Session</button>
      </Header>

      <div style={{ flex: 1, overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 300px', gap: 0, padding: '20px 0 0', minHeight: 0 }}>
        {/* Chat */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: 20 }}>
          {error && <div className="alert-banner danger" style={{ marginBottom: 12, flexShrink: 0 }}><span>⚠</span> {error}</div>}

          {/* Conversation */}
          <div ref={chatRef} className="glass-panel scrollable-feed" style={{ flex: 1, padding: '16px', minHeight: 0 }}>
            {messages.map(msg => {
              if (msg.text.startsWith('[Session')) {
                return (
                  <div key={msg.id} style={{ textAlign: 'center', padding: '12px', marginBottom: 12, background: 'rgba(0,212,255,0.05)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.82rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    {msg.text.replace('[Session started. ', '').replace(']', '')}
                  </div>
                );
              }
              return (
                <div key={msg.id} className={`chat-bubble-wrap ${msg.role} fade-in`}>
                  <div className="chat-meta">
                    {msg.role === 'atc' ? '🎙 ATC · KAUS' : `✈️ ${callsign}`} · {msg.timestamp.toLocaleTimeString()}
                    {msg.validation && (
                      <span className={`conf-pill ${msg.validation.score >= 80 ? 'conf-high' : msg.validation.score >= 50 ? 'conf-medium' : 'conf-low'}`} style={{ marginLeft: 8 }}>
                        {msg.validation.score}/100
                      </span>
                    )}
                  </div>
                  <div className={`chat-bubble ${msg.role}`}>
                    <div style={{ fontFamily: 'Share Tech Mono', fontSize: '0.84rem', lineHeight: 1.6 }}>{msg.text}</div>
                    {msg.validation && <ValidationPanel validation={msg.validation} expected={''} />}
                  </div>
                </div>
              );
            })}

            {(isATCTalking || isProcessing) && (
              <div className="chat-bubble-wrap atc fade-in">
                <div className="chat-meta">🎙 ATC · KAUS</div>
                <div className="chat-bubble atc" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px' }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cyan-primary)', animation: `pulse-green 1.2s ease-in-out ${i * 0.2}s infinite` }} />
                  ))}
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{isProcessing ? 'Processing...' : 'Transmitting...'}</span>
                </div>
              </div>
            )}
          </div>

          {/* PTT Control */}
          <div className="glass-panel" style={{ padding: '16px', marginTop: 16, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  {isRecording ? '● Recording your response...' : isATCTalking ? '🎙 ATC is transmitting...' : isProcessing ? '⚙ Processing...' : 'Press to transmit your response'}
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
                  {isRecording && <div style={{ height: '100%', background: 'var(--red)', borderRadius: 2, animation: 'glow-cyan 0.6s ease infinite', width: '100%' }} />}
                </div>
              </div>
              <button
                className={`btn ${isRecording ? 'btn-danger' : 'btn-primary'} btn-lg`}
                style={{ minWidth: 140, justifyContent: 'center' }}
                onMouseDown={!isRecording && !isATCTalking && !isProcessing ? startRecording : undefined}
                onMouseUp={isRecording ? stopRecordingAndProcess : undefined}
                onTouchStart={!isRecording && !isATCTalking && !isProcessing ? startRecording : undefined}
                onTouchEnd={isRecording ? stopRecordingAndProcess : undefined}
                disabled={isATCTalking || isProcessing}
              >
                {isRecording ? '▪ Release to Send' : '🎙 Hold to Talk'}
              </button>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto', paddingBottom: 4 }}>
          {/* ATIS / Context */}
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--cyan-primary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10, fontFamily: 'Share Tech Mono' }}>
              📻 ATIS — INFO NOVEMBER
            </div>
            {[
              ['Airport', 'KAUS · Austin–Bergstrom'],
              ['Runways', '18L/36R active'],
              ['Wind', '180° @ 8kts'],
              ['Vis', '10SM · Few @ 4,000'],
              ['Altimeter', '29.92 in Hg'],
              ['Temp/DP', '22°C / 15°C'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'Share Tech Mono' }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Frequencies */}
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Frequencies</div>
            {[
              ['ATIS', '128.625'],
              ['Clearance', '135.475'],
              ['Ground', '121.9'],
              ['Tower', '119.0'],
              ['Departure', '124.0'],
              ['Approach', '119.4'],
            ].map(([f, freq]) => (
              <div key={f} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{f}</span>
                <span style={{ fontFamily: 'Share Tech Mono', color: 'var(--cyan-primary)' }}>{freq}</span>
              </div>
            ))}
          </div>

          {/* Quick Stats */}
          {messages.filter(m => m.role === 'pilot' && m.validation).length > 0 && (
            <div className="glass-panel" style={{ padding: '16px' }}>
              <WeaknessTracker stats={aggregateStats(messages)} />
            </div>
          )}

          {/* Tips */}
          <div className="glass-panel" style={{ padding: '16px' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>💡 Tips</div>
            {[
              'Always start with your callsign',
              'Read back ALL clearance items',
              'Numbers digit-by-digit',
              'Acknowledge with callsign last',
              '"Wilco" = will comply + understand',
            ].map((tip, i) => (
              <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                · {tip}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
