import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Nav } from './components/Nav';
import { SignInModal } from './components/SignInModal';
import Home from './pages/Home';

const Chat = lazy(() => import('./pages/Chat'));
const Earn = lazy(() => import('./pages/Earn'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Settings = lazy(() => import('./pages/Settings'));
const Network = lazy(() => import('./pages/Network'));
const Docs = lazy(() => import('./pages/Docs'));
const Staking = lazy(() => import('./pages/Staking'));
const NotFound = lazy(() => import('./pages/NotFound'));

const TITLES: Record<string, string> = {
  '/chat': 'Chat', '/earn': 'Earn', '/pricing': 'Pricing', '/settings': 'Settings', '/network': 'Network', '/docs': 'API docs', '/staking': 'Staking',
};

/** Scroll to top on navigation, or to #anchor when present. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    document.title = TITLES[pathname] ? `${TITLES[pathname]} · Tide` : "Tide — compute that flows where it's needed";
  }, [pathname]);
  useEffect(() => {
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      return () => clearTimeout(t);
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

export function App() {
  const { pathname } = useLocation();
  return (
    <>
      <ScrollManager />
      <Nav full={pathname === '/chat'} />
      <Suspense fallback={<div className="page wrap"><span className="spinner" /></div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/earn" element={<Earn />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/network" element={<Network />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/staking" element={<Staking />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <SignInModal />
    </>
  );
}
