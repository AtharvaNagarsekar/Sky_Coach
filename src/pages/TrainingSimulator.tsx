import { useState, useRef, useEffect, useCallback } from 'react';
import Header from '../components/Header';
import {
  SITUATIONS,
  buildSessionContext, getATCResponse, validateReadback, aggregateStats,
} from '../services/simulatorEngine';
import type { ConversationMessage, ReadbackValidation, SessionStats } from '../services/simulatorEngine';
import { transcribeForSimulator } from '../services/transcriptionService';
import { speakATC, cancelTTS, initTTS } from '../services/ttsService';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { v4 as uuid } from 'uuid';
import { updateQValue, selectRLScenario, getRLRecommendations } from '../services/rlEngine';
import type { ScenarioType } from '../services/rlEngine';

// ─── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({ onStart }: { onStart: (situation: string, callsign: string, custom: string, isChain: boolean) => void }) {
  const [situation, setSituation] = useState('taxi_out');
  const [callsign, setCallsign] = useState('N1234A');
  const [custom, setCustom] = useState('');
  const [isChain, setIsChain] = useState(false);

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

          {/* Mode Toggle */}
          <div className="glass-panel" style={{ padding: 16, background: 'rgba(20,30,40,0.4)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={isChain} onChange={e => setIsChain(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--cyan-primary)' }} />
              <div>
                <div style={{ fontWeight: 600, color: isChain ? 'var(--cyan-primary)' : 'var(--text-primary)' }}>🔗 Chain Session (Full Flight)</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Continuous conversation from taxi to parking</div>
              </div>
            </label>
          </div>

          <button
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onStart(situation, callsign || 'N1234A', custom, isChain)}
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

      <div style={{ padding: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 8, marginBottom: 16 }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>🧠 RL Engine Weakness Tracking</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Primary Weakness:</span>
          <span className="badge" style={{ background: 'rgba(255,179,71,0.15)', color: 'var(--amber)', border: '1px solid rgba(255,179,71,0.3)' }}>
            {stats.weakestCategory.toUpperCase()}
          </span>
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

  // Chain Session + Text Fallback state
  const [isChainSession, setIsChainSession] = useState(false);
  const [chainHistory, setChainHistory] = useState<Array<{ role: 'pilot' | 'atc' | 'situation'; text: string }>>([]);
  const [scenarioTraffic, setScenarioTraffic] = useState<ScenarioType>('Normal Traffic');
  const [fallbackText, setFallbackText] = useState('');
  const [rawTranscription, setRawTranscription] = useState('');
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const chatRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
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
  }, [isChainSession, chainHistory, scenarioTraffic, callsign]);

  const handleStart = async (sit: string, cs: string, customTopic: string, chain: boolean) => {
    setSituation(sit);
    setCallsign(cs);
    setMessages([]);
    setFallbackText('');
    setIsChainSession(chain);

    // Choose RL Scenario Type if doing a full chain
    const chosenTraffic = chain ? selectRLScenario({ weakestCategory: 'None' }) : 'Normal Traffic';
    setScenarioTraffic(chosenTraffic);

    const sysCtx = buildSessionContext(sit as any, cs, customTopic);
    const sysMsg = { role: 'system' as const, content: `${sysCtx}\n\nYou are the ATC controller. Provide realistic ATC radio communications for this training scenario. Include EXPECTED_READBACK after each transmission.` };
    const history = [sysMsg];
    setSessionHistory(history);
    setPhase('session');

    const cfg = SITUATIONS[sit];

    if (chain) {
      const introMsg = `Initial Briefing: ${cfg ? cfg.context : customTopic}. Traffic density: ${chosenTraffic}.`;
      setChainHistory([{ role: 'situation', text: introMsg }]);
      const prompt: ConversationMessage = { id: uuid(), role: 'atc', text: `[Chain Session Started: ${chosenTraffic}. The flight is now active.]`, timestamp: new Date() };
      appendMessage(prompt);

      // ATC generates first instruction in chain mode
      setIsATCTalking(true);
      setError(null);
      import('../services/simulatorEngine').then(async m => {
        try {
          const resp = await m.generateNextExchange(
            'Austin-Bergstrom International Airport (KAUS)', cs, 'Medium',
            [{ role: 'situation', text: introMsg }], chosenTraffic
          );
          setCurrentExpected(resp.expected_readback);
          const msg: ConversationMessage = { id: uuid(), role: 'atc', text: resp.atc_transmission, timestamp: new Date() };
          appendMessage(msg);
          setChainHistory(prev => [...prev, { role: 'atc', text: resp.atc_transmission }]);
          speakATC(resp.atc_transmission, () => setIsATCTalking(false));
        } catch (e) {
          setError('Failed to generate chain instruction.');
          setIsATCTalking(false);
        }
      });
      return;
    }

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

      // Simplified High-Gain Pipeline (No aggressive filters)
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      const gain = ctx.createGain();
      gain.gain.value = 5.0; // High boost for clarity
      const dest = ctx.createMediaStreamDestination();
      
      source.connect(gain);
      gain.connect(dest);

      const rec = new MediaRecorder(dest.stream, { 
        mimeType: 'audio/webm' 
      });
      rec.ondataavailable = e => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.start(); 
      recorderRef.current = rec;
      
      setIsRecording(true);
      setError(null);
      setFallbackText('');
      setRawTranscription('');
    } catch (e) {
      console.error('Mic start error:', e);
      alert('Microphone access required.');
      setIsRecording(false);
    }
  };

  const stopRecordingAndProcess = async () => {
    if (!recorderRef.current || !isRecording) return;
    setIsRecording(false);
    setIsProcessing(true);
    setProcessingStatus('⏳ Finalising audio...');

    try {
      recorderRef.current.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    } catch (e) { }

    // Wait for recorder to flush all chunks
    await new Promise(res => setTimeout(res, 600));
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    console.log(`[Simulator] Audio Captured: ${Math.round(blob.size / 1024)} KB`);

    if (blob.size < 500) {
      setError(`Audio too quiet/short (${blob.size} bytes). Please speak louder and wait 1 sec before releasing.`);
      setIsProcessing(false);
      setProcessingStatus('');
      return;
    }

    try {
      setProcessingStatus('🎙️ Transcribing...');
      const { transcribeForSimulator } = await import('../services/transcriptionService');
      const { correctedText, rawText } = await transcribeForSimulator(
        blob,
        currentExpected,
        callsign
      );

      if (!rawText.trim()) {
        setError('No speech detected. Try speaking louder.');
      } else {
        setProcessingStatus('✅ Done');
        setFallbackText(correctedText || rawText);
        setRawTranscription(rawText);
      }
    } catch (e: any) {
      console.error('Transcription error:', e);
      setError(`Transcription failed: ${e?.message}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setProcessingStatus(''), 2000);
    }
  };

  const submitFallbackText = async () => {
    if (!fallbackText.trim()) return;
    setIsProcessing(true);

    const pilotText = fallbackText;
    setFallbackText('');

    try {
      const pilotMsg: ConversationMessage = { id: uuid(), role: 'pilot', text: pilotText, timestamp: new Date() };

      // Validate readback
      const lastATCMsg = [...messages].reverse().find(m => m.role === 'atc' && !m.text.startsWith('[Session'));
      let validation: ReadbackValidation | undefined;
      if (lastATCMsg && currentExpected) {
        validation = await validateReadback(lastATCMsg.text, pilotText, currentExpected, callsign);
        pilotMsg.validation = validation;
      }

      appendMessage(pilotMsg);

      if (isChainSession) {
        const newHistory = [...chainHistory, { role: 'pilot' as const, text: pilotText }];
        setChainHistory(newHistory);
        setIsProcessing(false);

        // Let RL engine track progress
        if (validation) {
          updateQValue({ weakestCategory: 'None' }, scenarioTraffic, validation.score / 100, { weakestCategory: 'None' });
        }

        import('../services/simulatorEngine').then(async m => {
          setIsATCTalking(true);
          try {
            const resp = await m.generateNextExchange(
              'Austin-Bergstrom International Airport (KAUS)', callsign, 'Medium',
              newHistory, scenarioTraffic
            );
            setCurrentExpected(resp.expected_readback);

            if (resp.session_complete) {
              const msg: ConversationMessage = { id: uuid(), role: 'atc', text: '⛳ SESSION COMPLETE — Aircraft at gate. Well done!', timestamp: new Date() };
              appendMessage(msg);
              speakATC(msg.text, () => { setIsATCTalking(false); handleEndSession(); });
            } else {
              const msg: ConversationMessage = { id: uuid(), role: 'atc', text: resp.atc_transmission, timestamp: new Date() };
              appendMessage(msg);
              setChainHistory(prev => [...prev, { role: 'atc', text: resp.atc_transmission }]);
              speakATC(resp.atc_transmission, () => setIsATCTalking(false));
            }
          } catch (e) {
            setError('Failed to generate chain instruction.');
            setIsATCTalking(false);
          }
        });

      } else {
        // Single session block
        const newHistory = [...sessionHistory, { role: 'user' as const, content: pilotText }];
        setSessionHistory(newHistory);
        setIsProcessing(false);
        await addATCMessage(newHistory);
      }
    } catch (e) {
      setError('Evaluation failed. Please try again.');
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
          {/* RL Insights */}
          {stats && (
            <div className="glass-panel" style={{ padding: '20px', marginTop: 10, borderLeft: '3px solid var(--purple)' }}>
              <h3 style={{ marginBottom: 12, color: 'var(--purple)' }}>🤖 RL Engine Recommendation</h3>
              {getRLRecommendations({ weakestCategory: stats.weakestCategory }).map((rec, i) => (
                <div key={i} style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                  {rec.replace(/\*\*(.*?)\*\*/g, '▪ $1 ▪')}
                </div>
              ))}
            </div>
          )}

          <div className="glass-panel" style={{ padding: '20px' }}>
            <h3 style={{ marginBottom: 16 }}>Full Conversation Log</h3>
            {messages.map(msg => (
              msg.text.includes('[Chain Session Started') || msg.text.startsWith('[Session') ? null :
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

          {/* PTT Control exactly matching UI */}
          <div className="glass-panel" style={{ padding: '20px', marginTop: 16, flexShrink: 0, border: '1px solid rgba(255,255,255,0.08)' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#fff' }}>🎙 YOUR READBACK</h3>
              {(isRecording || processingStatus) && (
                <span style={{ fontSize: '0.78rem', fontFamily: 'Share Tech Mono', color: isRecording ? 'var(--red)' : 'var(--cyan-primary)', letterSpacing: '0.04em' }}>
                  {isRecording ? '● REC' : processingStatus}
                </span>
              )}
            </div>
            <button
              className={`btn ${isRecording ? 'btn-danger' : 'btn-primary'} btn-lg`}
              style={{ width: '100%', justifyContent: 'center', fontFamily: 'Share Tech Mono', letterSpacing: '0.03em', fontSize: '0.95rem', padding: '16px', borderRadius: 8 }}
              onClick={isRecording ? stopRecordingAndProcess : startRecording}
              disabled={isATCTalking || isProcessing}
            >
              {isRecording ? '▪ Click to Submit Voice' : '🎙️ VOICE READBACK — Whisper + Mistral Aviation Correction'}
            </button>

            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 500 }}>
                Or type / edit your readback:
              </div>
              <textarea
                className="input-field"
                style={{ width: '100%', fontFamily: 'Share Tech Mono', fontSize: '0.9rem', minHeight: 75, padding: 12, resize: 'vertical' }}
                placeholder="Speak above — transcript auto-fills here. Or type manually."
                value={fallbackText}
                onChange={e => setFallbackText(e.target.value)}
                disabled={isATCTalking || isProcessing || isRecording}
              />
              {rawTranscription && (
                <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)', fontStyle: 'italic', display: 'flex', gap: 6 }}>
                  <span style={{ color: 'var(--cyan-primary)', fontWeight: 600 }}>RAW WHISPER:</span>
                  <span>{rawTranscription}</span>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginTop: 16 }}>
              <button
                className="btn btn-primary"
                onClick={submitFallbackText}
                disabled={!fallbackText.trim() || isATCTalking || isProcessing || isRecording}
                style={{ background: 'linear-gradient(135deg, #1e8c45, #14612f)', color: '#fff', fontWeight: 600, border: 'none', padding: '12px', fontSize: '1rem', letterSpacing: '0.05em' }}
              >
                ✅ SUBMIT & EVALUATE
              </button>

              <button
                className="btn btn-ghost"
                disabled={isATCTalking || isProcessing || isRecording || !currentExpected}
                style={{ background: 'rgba(255,255,255,0.05)', color: '#a8d8ea', fontWeight: 600, border: '1px solid rgba(168,216,234,0.3)' }}
                onClick={() => setFallbackText(currentExpected)}
              >
                🔁 SHOW ANSWER
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
