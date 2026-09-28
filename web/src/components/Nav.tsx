import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { LogoMark } from './Logo';
import { useAuth } from '../lib/auth';

export const NAV_LINKS = [
  { to: '/chat', label: 'Chat' },
  { to: '/earn', label: 'Earn' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/network', label: 'Network' },
  { to: '/staking', label: 'Staking' },
  { to: '/docs', label: 'Docs' },
];

export function AccountButton({ compact = false }: { compact?: boolean }) {
  const { me, signedIn, openSignIn, loading } = useAuth();
  if (loading) return <span className="btn btn-ghost btn-sm" style={{ opacity: 0.4 }}>…</span>;
  if (!signedIn) {
    return (
      <button className={`btn ${compact ? 'btn-ghost' : 'btn-foam'} btn-sm`} onClick={() => openSignIn()}>
        Sign in
      </button>
    );
  }
  return (
    <Link to="/settings#account" className="acct-chip" title="Account settings">
      <span className="avatar" />
      <span className="name mono">{me!.user.name ?? 'Account'}</span>
    </Link>
  );
}

export function Nav({ full = false }: { full?: boolean }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname, loc.hash]);

  return (
    <>
      <nav className={`nav${full ? ' full' : ''}`}>
        <div className="wrap">
          <Link className="brand" to="/" aria-label="Tide home">
            <LogoMark />
            tide
          </Link>
          <div className="nav-links">
            {NAV_LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')}>{l.label}</NavLink>
            ))}
          </div>
          <div className="nav-actions">
            {loc.pathname === '/' && <Link to="/chat" className="btn btn-foam btn-sm hide-sm">Launch app →</Link>}
            <AccountButton compact={loc.pathname === '/'} />
            <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open}>
              <span />
            </button>
          </div>
        </div>
      </nav>
      {open && (
        <div className="mobile-menu">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')}>{l.label}</NavLink>
          ))}
          <NavLink to="/settings">Settings</NavLink>
        </div>
      )}
    </>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="fgrid">
          <div>
            <Link className="brand" to="/"><LogoMark />tide</Link>
            <p style={{ marginTop: 14, maxWidth: 260 }}>An open protocol for decentralized AI.</p>
          </div>
          <div><h5>PRODUCT</h5><ul><li><Link to="/docs">API</Link></li><li><Link to="/chat">Chat</Link></li><li><Link to="/pricing">Pricing</Link></li><li><Link to="/earn">Earn</Link></li></ul></div>
          <div><h5>NETWORK</h5><ul><li><Link to="/network">Live stats</Link></li><li><Link to="/earn">Run a node</Link></li><li><Link to="/docs#nodes">Node docs</Link></li></ul></div>
          <div><h5>$TIDE</h5><ul><li><Link to="/staking">Staking</Link></li><li><Link to="/#token">Tokenomics</Link></li><li><Link to="/network#treasury">Treasury</Link></li><li><Link to="/settings#account">Referrals</Link></li></ul></div>
          <div><h5>RESOURCES</h5><ul><li><Link to="/docs">Docs</Link></li><li><Link to="/pricing#faq">FAQ</Link></li><li><Link to="/settings#keys">API keys</Link></li></ul></div>
        </div>
        <div className="fine"><span>© 2026 Tide</span><span className="mono">≈ all systems flowing</span></div>
      </div>
    </footer>
  );
}
