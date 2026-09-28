import { Link } from 'react-router-dom';
import { Sea } from '../components/Sea';

export default function NotFound() {
  return (
    <div className="nf">
      <Sea activity={0.05} horizon={0.55} />
      <div className="code">404</div>
      <h1 style={{ fontSize: 28, letterSpacing: '-.02em' }}>This page drifted out to sea.</h1>
      <p className="muted">The link may be broken, or the page may have moved with the tide.</p>
      <div className="cta" style={{ marginTop: 10 }}>
        <Link to="/" className="btn btn-foam">Back to shore</Link>
        <Link to="/chat" className="btn btn-ghost">Open chat</Link>
      </div>
    </div>
  );
}
