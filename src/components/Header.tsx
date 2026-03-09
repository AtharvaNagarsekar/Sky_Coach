import React from 'react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  statusLabel?: string;
  statusActive?: boolean;
  children?: React.ReactNode;
}

export default function Header({ title, subtitle, statusLabel, statusActive, children }: HeaderProps) {
  return (
    <header style={{
      height: 'var(--header-height)', flexShrink: 0,
      padding: '0 28px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between',
      background: 'rgba(5,10,20,0.6)', backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', color: 'var(--text-primary)', margin: 0, letterSpacing: '0.06em' }}>{title}</h2>
          {subtitle && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div>}
        </div>
        {statusLabel && (
          <div className="flex-row" style={{ gap: 6 }}>
            <div className={`status-dot ${statusActive ? 'live' : 'idle'}`} />
            <span style={{ fontSize: '0.75rem', color: statusActive ? 'var(--green)' : 'var(--text-muted)', fontFamily: 'Share Tech Mono' }}>
              {statusLabel}
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {children}
      </div>
    </header>
  );
}
