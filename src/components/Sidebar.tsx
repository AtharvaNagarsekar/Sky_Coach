import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  {
    to: '/live-atc',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12h2m18 0h-2M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/>
        <circle cx="12" cy="12" r="4"/>
        <circle cx="12" cy="12" r="8" strokeDasharray="3 2"/>
      </svg>
    ),
    label: 'Live ATC',
    sublabel: 'Transcription',
  },
  {
    to: '/voice-analyzer',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
        <path d="M5 8v2M9 6v3M15 6v3M19 8v2"/>
      </svg>
    ),
    label: 'Voice Analyzer',
    sublabel: 'Stress & Clarity',
  },
  {
    to: '/simulator',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
      </svg>
    ),
    label: 'ATC Simulator',
    sublabel: 'Training',
  },
];

export default function Sidebar() {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' }) + ' UTC'
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside style={{
      width: 'var(--sidebar-width)', flexShrink: 0,
      background: 'rgba(5,10,20,0.85)', backdropFilter: 'blur(20px)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      padding: '0',
      position: 'relative', zIndex: 10,
    }}>
      {/* Logo */}
      <div style={{ padding: '22px 20px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'linear-gradient(135deg, var(--cyan-primary), var(--cyan-dim))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 16px rgba(0,212,255,0.4)',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#050a14" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: '1.22rem', color: 'var(--text-primary)', letterSpacing: '0.08em' }}>
              SKY<span style={{ color: 'var(--cyan-primary)' }}>COACH</span>
            </div>
          </div>
        </div>
        <div style={{
          fontFamily: 'Share Tech Mono', fontSize: '0.7rem',
          color: 'var(--cyan-primary)', letterSpacing: '0.1em',
          background: 'var(--cyan-glow)', padding: '3px 8px', borderRadius: 4,
          display: 'inline-block', marginTop: 4,
        }}>
          {time || '00:00:00 UTC'}
        </div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.12em', textTransform: 'uppercase', padding: '0 8px', marginBottom: 8 }}>
          Modules
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 12px', borderRadius: 'var(--radius-sm)',
              textDecoration: 'none', transition: 'all 0.2s ease',
              background: isActive ? 'rgba(0,212,255,0.1)' : 'transparent',
              border: isActive ? '1px solid rgba(0,212,255,0.25)' : '1px solid transparent',
              color: isActive ? 'var(--cyan-primary)' : 'var(--text-secondary)',
              boxShadow: isActive ? '0 0 16px rgba(0,212,255,0.08)' : 'none',
            })}
          >
            {({ isActive }) => (
              <>
                <div style={{ opacity: isActive ? 1 : 0.6, transition: 'opacity 0.2s', flexShrink: 0 }}>
                  {item.icon}
                </div>
                <div>
                  <div style={{ fontFamily: 'Rajdhani', fontWeight: 600, fontSize: '0.95rem', letterSpacing: '0.04em', lineHeight: 1.2 }}>
                    {item.label}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: isActive ? 'var(--cyan-dim)' : 'var(--text-muted)', marginTop: 1 }}>
                    {item.sublabel}
                  </div>
                </div>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom info */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        <div style={{ marginBottom: 2 }}>KAUS · Austin–Bergstrom Intl</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div className="status-dot live" />
          <span style={{ color: 'var(--green)' }}>APP / DEP Frequency</span>
        </div>
      </div>
    </aside>
  );
}
