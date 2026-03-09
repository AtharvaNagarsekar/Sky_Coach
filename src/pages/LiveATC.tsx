import { useRef, useEffect, useState, useCallback } from 'react';
import Header from '../components/Header';
import { ATCStreamCapture } from '../services/atcStream';
import type { StreamStatus } from '../services/atcStream';
import { transcribeAudio } from '../services/transcriptionService';
import { formatATCTranscription } from '../services/formattingService';
import type { ATCEntry } from '../services/formattingService';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// ─── Utility ──────────────────────────────────────────────────────────────────
function confidenceClass(conf: number): string {
  if (conf >= 75) return 'conf-high';
  if (conf >= 45) return 'conf-medium';
  return 'conf-low';
}
function flagSeverityColor(severity: string) {
  if (severity === 'high') return 'var(--red)';
  if (severity === 'medium') return 'var(--yellow)';
  return 'var(--amber)';
}
function speakerColor(speaker: string) {
  if (['TOWER', 'APPROACH', 'DEPARTURE', 'GROUND'].includes(speaker)) return 'var(--cyan-primary)';
  if (speaker === 'PILOT') return 'var(--amber)';
  return 'var(--text-muted)';
}
function speakerBadgeClass(speaker: string) {
  if (['TOWER', 'APPROACH', 'DEPARTURE', 'GROUND'].includes(speaker)) return 'badge badge-cyan';
  if (speaker === 'PILOT') return 'badge badge-amber';
  return 'badge badge-muted';
}
function typeBadgeClass(type: string) {
  if (type === 'clearance') return 'badge badge-purple';
  if (type === 'readback') return 'badge badge-cyan';
  if (type === 'request') return 'badge badge-amber';
  if (type === 'correction') return 'badge badge-red';
  return 'badge badge-muted';
}
function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' }) + 'Z';
}

// ─── Stats Item ───────────────────────────────────────────────────────────────
function StatBox({ label, value, unit = '', color = 'var(--cyan-primary)' }: { label: string; value: string | number; unit?: string; color?: string }) {
  return (
    <div className="glass-card" style={{ textAlign: 'center', padding: '16px 12px' }}>
      <div style={{ fontFamily: 'Share Tech Mono', fontSize: '1.6rem', fontWeight: 700, color }}>{value}<span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 3 }}>{unit}</span></div>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function LiveATC() {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [entries, setEntries] = useState<ATCEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [confidenceHistory, setConfidenceHistory] = useState<{ t: string; v: number }[]>([]);
  const [stats, setStats] = useState({ total: 0, flags: 0, avgConf: 0, towerCount: 0, pilotCount: 0 });
  const [filterSpeaker, setFilterSpeaker] = useState<string>('ALL');
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<ATCStreamCapture | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const processingQueue = useRef<Array<{ blob: Blob; ts: Date }>>([]);
  const processingRef = useRef(false);

  // Auto-scroll
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [entries]);

  // Update stats whenever entries change
  useEffect(() => {
    if (entries.length === 0) return;
    const flagCount = entries.reduce((s, e) => s + e.flags.length, 0);
    const avgConf = Math.round(entries.reduce((s, e) => s + e.confidence, 0) / entries.length);
    const towerCount = entries.filter(e => ['TOWER', 'APPROACH', 'DEPARTURE', 'GROUND'].includes(e.speaker)).length;
    const pilotCount = entries.filter(e => e.speaker === 'PILOT').length;
    setStats({ total: entries.length, flags: flagCount, avgConf, towerCount, pilotCount });
  }, [entries]);

  const processQueue = useCallback(async () => {
    if (processingRef.current || processingQueue.current.length === 0) return;
    processingRef.current = true;
    setIsProcessing(true);

    while (processingQueue.current.length > 0) {
      const item = processingQueue.current.shift()!;
      setQueueLen(processingQueue.current.length);
      try {
        const result = await transcribeAudio(item.blob);
        if (!result.text.trim() || result.text.trim().length < 3) continue;

        const formatted = await formatATCTranscription(result.text, result.confidence);
        if (formatted.length > 0) {
          setEntries(prev => [...prev.slice(-200), ...formatted]); // Keep last 200
          setConfidenceHistory(prev => [
            ...prev.slice(-30),
            { t: formatTime(item.ts), v: Math.round(formatted[0].confidence) },
          ]);
        }
      } catch (err) {
        console.error('Processing error:', err);
      }
    }

    processingRef.current = false;
    setIsProcessing(false);
  }, []);

  const handleChunk = useCallback((chunk: { blob: Blob; timestamp: Date }) => {
    processingQueue.current.push({ blob: chunk.blob, ts: chunk.timestamp });
    setQueueLen(processingQueue.current.length);
    processQueue();
  }, [processQueue]);

  const handleStart = async () => {
    setError(null);
    setEntries([]);
    captureRef.current = new ATCStreamCapture(
      8000, // 8-second chunks
      handleChunk,
      (s) => {
        setStatus(s);
        if (s === 'error') setError('Failed to connect to LiveATC stream. The stream may be offline or CORS proxy unavailable.');
      }
    );
    await captureRef.current.start();
  };

  const handleStop = () => {
    captureRef.current?.stop();
    captureRef.current = null;
  };

  const handlePauseResume = () => {
    if (status === 'live') captureRef.current?.pause();
    else if (status === 'paused') captureRef.current?.resume();
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    captureRef.current?.setVolume(v);
  };

  const filteredEntries = filterSpeaker === 'ALL'
    ? entries
    : entries.filter(e => e.speaker === filterSpeaker || (['TOWER','APPROACH','DEPARTURE','GROUND'].includes(e.speaker) && filterSpeaker === 'ATC'));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>
      <Header
        title="Live ATC Transcription"
        subtitle="KAUS Austin–Bergstrom · Approach / Departure · 119.0 MHz"
        statusLabel={status === 'live' ? 'LIVE' : status === 'connecting' ? 'CONNECTING...' : status === 'paused' ? 'PAUSED' : 'OFFLINE'}
        statusActive={status === 'live'}
      >
        <select
          className="input-field"
          style={{ width: 'auto', fontSize: '0.8rem', padding: '6px 10px' }}
          value={filterSpeaker}
          onChange={e => setFilterSpeaker(e.target.value)}
        >
          <option value="ALL">All Speakers</option>
          <option value="ATC">ATC Only</option>
          <option value="PILOT">Pilots Only</option>
        </select>
        {status === 'idle' || status === 'error' ? (
          <button className="btn btn-primary" onClick={handleStart}>
            <span>▶</span> Connect
          </button>
        ) : (
          <>
            <button className="btn btn-ghost btn-sm" onClick={handlePauseResume}>
              {status === 'paused' ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleStop}>■ Stop</button>
          </>
        )}
      </Header>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 0, padding: '20px 0 0 0' }}>
        {/* Error */}
        {error && (
          <div className="alert-banner danger" style={{ margin: '0 0 16px' }}>
            <span>⚠</span> {error}
          </div>
        )}

        {/* Stats Row */}
        <div className="grid-4" style={{ marginBottom: 20, flexShrink: 0 }}>
          <StatBox label="Transmissions" value={stats.total} color="var(--cyan-primary)" />
          <StatBox label="Avg Confidence" value={stats.avgConf} unit="%" color={stats.avgConf >= 70 ? 'var(--green)' : stats.avgConf >= 45 ? 'var(--yellow)' : 'var(--red)'} />
          <StatBox label="Flags" value={stats.flags} color={stats.flags > 0 ? 'var(--red)' : 'var(--green)'} />
          <StatBox label="ATC / Pilot" value={`${stats.towerCount}/${stats.pilotCount}`} color="var(--text-secondary)" />
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, overflow: 'hidden', minHeight: 0 }}>
          {/* Transcript Feed */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
              <h3 style={{ margin: 0 }}>Radio Transcript</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {isProcessing && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: 'var(--cyan-primary)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round">
                        <animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="1s" repeatCount="indefinite" />
                      </path>
                    </svg>
                    Processing {queueLen > 0 ? `(${queueLen} queued)` : ''}
                  </div>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEntries([])}
                  disabled={entries.length === 0}
                >Clear</button>
              </div>
            </div>

            {/* Feed */}
            <div ref={feedRef} className="scrollable-feed" style={{ flex: 1 }}>
              {filteredEntries.length === 0 && (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                  {status === 'idle' || status === 'error'
                    ? <div><div style={{ fontSize: '2.5rem', marginBottom: 12, opacity: 0.4 }}>📡</div><div>Connect to begin live ATC transcription</div></div>
                    : <div><div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🎙</div><div style={{ color: 'var(--cyan-primary)' }}>Listening to frequency...</div><div style={{ fontSize: '0.8rem', marginTop: 6 }}>Transcriptions will appear here</div></div>
                  }
                </div>
              )}
              {filteredEntries.map((entry) => (
                <TranscriptEntry key={entry.id} entry={entry} />
              ))}
            </div>
          </div>

          {/* Right Panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
            {/* Volume */}
            <div className="glass-panel" style={{ padding: '16px', flexShrink: 0 }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Monitor Volume</div>
              <input
                type="range" min={0} max={3} step={0.1} value={volume}
                onChange={e => handleVolumeChange(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--cyan-primary)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                <span>Off</span><span style={{ color: 'var(--cyan-primary)' }}>{Math.round(volume * 100)}%</span><span>Max</span>
              </div>
            </div>

            {/* Legend */}
            <div className="glass-panel" style={{ padding: '16px', flexShrink: 0 }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Legend</div>
              {[
                { color: 'var(--cyan-primary)', label: 'ATC (Tower / Approach / Departure / Ground)' },
                { color: 'var(--amber)', label: 'Pilot' },
                { color: 'var(--red)', label: 'False Readback / Flag' },
                { color: 'var(--purple)', label: 'Clearance' },
              ].map(({ color, label }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{label}</span>
                </div>
              ))}
            </div>

            {/* Confidence Trend */}
            {confidenceHistory.length > 1 && (
              <div className="glass-panel" style={{ padding: '16px', flex: 1 }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Confidence Trend</div>
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={confidenceHistory}>
                    <defs>
                      <linearGradient id="cgr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--cyan-primary)" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="var(--cyan-primary)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip contentStyle={{ background: 'var(--bg-panel-solid)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.75rem' }} />
                    <Area type="monotone" dataKey="v" stroke="var(--cyan-primary)" fill="url(#cgr)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Recent Flags */}
            {entries.some(e => e.flags.length > 0) && (
              <div className="glass-panel" style={{ padding: '16px', maxHeight: 200, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>🚩 Recent Flags</div>
                <div className="scrollable-feed" style={{ flex: 1 }}>
                  {entries.filter(e => e.flags.length > 0).slice(-5).reverse().map(e =>
                    e.flags.map((f, fi) => (
                      <div key={`${e.id}-${fi}`} style={{
                        padding: '8px 10px', marginBottom: 8,
                        background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)',
                        borderRadius: 8, fontSize: '0.75rem',
                      }}>
                        <div style={{ color: flagSeverityColor(f.severity), fontWeight: 600, marginBottom: 2 }}>
                          {f.type.replace(/_/g, ' ')} · {f.confidence}%
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>{f.description}</div>
                        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>— {e.callsign}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Transcript Entry Row ─────────────────────────────────────────────────────
function TranscriptEntry({ entry }: { entry: ATCEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isATC = ['TOWER', 'APPROACH', 'DEPARTURE', 'GROUND'].includes(entry.speaker);

  return (
    <div
      className="fade-in"
      onClick={() => setExpanded(x => !x)}
      style={{
        padding: '10px 14px', marginBottom: 8, borderRadius: 10, cursor: 'pointer',
        background: isATC ? 'rgba(0,212,255,0.05)' : 'rgba(255,179,71,0.05)',
        border: `1px solid ${isATC ? 'rgba(0,212,255,0.15)' : 'rgba(255,179,71,0.15)'}`,
        transition: 'all 0.15s ease',
        borderLeft: entry.flags.length > 0 ? '3px solid var(--red)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className={speakerBadgeClass(entry.speaker)} style={{ fontSize: '0.65rem' }}>
          {entry.speaker}
        </span>
        <span style={{ fontFamily: 'Share Tech Mono', fontSize: '0.82rem', color: speakerColor(entry.speaker), fontWeight: 700 }}>
          {entry.callsign}
        </span>
        {entry.facility && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{entry.facility}</span>
        )}
        <span className={typeBadgeClass(entry.type)} style={{ fontSize: '0.62rem' }}>
          {entry.type}
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'Share Tech Mono', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          {formatTime(entry.timestamp)}
        </span>
        <span className={`conf-pill ${confidenceClass(entry.confidence)}`}>{entry.confidence}%</span>
      </div>

      <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', lineHeight: 1.5, fontFamily: 'Share Tech Mono' }}>
        {entry.message}
      </div>

      {entry.flags.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {entry.flags.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px',
              background: 'rgba(255,68,68,0.12)', border: '1px solid rgba(255,68,68,0.3)',
              borderRadius: 6, fontSize: '0.7rem',
            }}>
              <span style={{ color: flagSeverityColor(f.severity) }}>🚩</span>
              <span style={{ color: 'var(--text-secondary)' }}>{f.type.replace(/_/g, ' ')}</span>
              <span className={`conf-pill ${confidenceClass(f.confidence)}`} style={{ fontSize: '0.62rem' }}>{f.confidence}%</span>
            </div>
          ))}
        </div>
      )}

      {expanded && entry.flags.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,68,68,0.05)', borderRadius: 6 }}>
          {entry.flags.map((f, i) => (
            <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
              <span style={{ color: flagSeverityColor(f.severity), fontWeight: 600 }}>{f.type}: </span>
              {f.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
