import { useState, useRef, useEffect } from 'react';
import Header from '../components/Header';

export default function LiveAudioStream() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [volume, setVolume] = useState(1.0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlaying = () => {
      setStatus('live');
      setIsPlaying(true);
    };
    
    const handleWaiting = () => {
      setStatus('connecting');
    };

    const handleError = () => {
      setStatus('error');
      setIsPlaying(false);
    };

    const handlePause = () => {
      setStatus('idle');
      setIsPlaying(false);
    };

    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('error', handleError);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('pause', handlePause);
      audio.pause();
    };
  }, []);

  const togglePlay = () => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      audioRef.current.pause();
      // To truly stop a live stream and not buffer behind, it's best to reload it on next play.
      // But pausing is enough for a quick stop.
    } else {
      setStatus('connecting');
      // Forcing standard timestamp buffer clearing to catch up to "live"
      audioRef.current.load();
      audioRef.current.play().catch(e => {
        console.error("Playback failed:", e);
        setStatus('error');
      });
    }
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    if (audioRef.current) {
      audioRef.current.volume = v;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>
      <Header
        title="Live Audio Stream"
        subtitle="Direct connection · KAUS Austin–Bergstrom · 119.0 MHz"
        statusLabel={status === 'live' ? 'LIVE' : status === 'connecting' ? 'CONNECTING...' : status === 'error' ? 'ERROR' : 'OFFLINE'}
        statusActive={status === 'live'}
      >
        <button 
          className={`btn ${isPlaying ? 'btn-danger' : 'btn-primary'}`} 
          onClick={togglePlay}
        >
          {isPlaying ? '■ Stop' : '▶ Listen Live'}
        </button>
      </Header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div className="glass-panel" style={{ padding: '40px', maxWidth: 500, width: '100%', textAlign: 'center' }}>
          
          <div style={{ marginBottom: 30 }}>
            {isPlaying ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, height: 60 }}>
                {/* Simple CSS animation bars for visual feedback */}
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} style={{
                    width: 8,
                    height: 20 + Math.random() * 30,
                    background: 'var(--cyan-primary)',
                    borderRadius: 4,
                    animation: `pulse ${0.5 + Math.random() * 0.5}s infinite alternate`
                  }} />
                ))}
              </div>
            ) : (
               <div style={{ fontSize: '4rem', opacity: 0.2, marginBottom: 10 }}>📻</div>
            )}
            
            <h3 style={{ margin: '10px 0 5px 0' }}>KAUS Approach/Departure</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>
              Live stream directly from d.liveatc.net
            </p>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: 12 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 15, textAlign: 'left' }}>
              Volume Control
            </div>
            <input
              type="range" min={0} max={1} step={0.01} value={volume}
              onChange={e => handleVolumeChange(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--cyan-primary)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 8 }}>
              <span>Mute</span>
              <span style={{ color: 'var(--cyan-primary)' }}>{Math.round(volume * 100)}%</span>
              <span>Max</span>
            </div>
          </div>
          
          {status === 'error' && (
            <div className="alert-banner danger" style={{ marginTop: 20 }}>
              ⚠ Failed to connect to stream. Please try again.
            </div>
          )}
          
          <style>{`
            @keyframes pulse {
              0% { transform: scaleY(0.7); opacity: 0.6; }
              100% { transform: scaleY(1.3); opacity: 1; }
            }
          `}</style>

          <audio 
            ref={audioRef} 
            src="https://d.liveatc.net/kaus3_app_dep" 
            // @ts-expect-error referrerPolicy is not yet defined in React's audio tag types
            referrerPolicy="no-referrer"
            preload="none"
          />
        </div>
      </div>
    </div>
  );
}
