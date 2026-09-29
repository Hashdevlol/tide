import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="nf">
      <div className="eyebrow">Error · page not found</div>
      <div className="code">404</div>
      <h1 className="display" style={{ fontSize: 'clamp(32px, 5vw, 64px)' }}>Went out with the tide.</h1>
      <p className="muted" style={{ maxWidth: 440 }}>The link is broken or the page moved. Nothing was charged.</p>
      <div className="cta" style={{ marginTop: 10, justifyContent: 'center' }}>
        <Link to="/" className="btn btn-ink">Back home</Link>
        <Link to="/chat" className="btn btn-ghost">Open chat</Link>
      </div>
    </div>
  );
}
