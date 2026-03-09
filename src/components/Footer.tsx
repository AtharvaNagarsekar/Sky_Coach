

export default function Footer() {
  return (
    <footer className="footer">
      <span>Built by <strong style={{ color: 'var(--text-secondary)' }}>Atharva Nagarsekar</strong> · </span>
      <a href="mailto:nagarsekaratharva@gmail.com">nagarsekaratharva@gmail.com</a>
      <span style={{ marginLeft: 12, color: 'var(--border-bright)' }}>·</span>
      <span style={{ marginLeft: 12 }}>SkyCoach Aviation Platform · {new Date().getFullYear()}</span>
    </footer>
  );
}
