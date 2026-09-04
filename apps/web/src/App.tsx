import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { RecordPage } from './pages/RecordPage.tsx';
import { WatchPage } from './pages/WatchPage.tsx';
import { PublicWatchPage } from './pages/PublicWatchPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';
import { Logo, RecordIcon } from './components/icons.tsx';
import { SourceLink } from './components/SourceLink.tsx';

export function App() {
  const { user, loading } = useSession();

  return (
    <Routes>
      {/* Outside the sign-in gate: a share link has to work for someone with no
          account, which is the whole point of it. */}
      <Route path="/s/:token" element={<PublicWatchPage />} />
      <Route path="*" element={loading ? <Loading /> : user ? <SignedIn /> : <LoginPage />} />
    </Routes>
  );
}

function Loading() {
  return (
    <main className="centered">
      <span className="spinner" style={{ color: 'var(--muted)', width: 20, height: 20 }} />
    </main>
  );
}

/** First letters of a name, for the corner of the bar. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

function SignedIn() {
  const { user, signOut } = useSession();
  if (!user) return null;

  return (
    <>
      <nav className="nav">
        <Link className="brand" to="/">
          <Logo />
          openloom
        </Link>
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Library
        </NavLink>
        {user.role === 'admin' && (
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            Settings
          </NavLink>
        )}

        <span className="spacer" />

        <SourceLink className="nav-link source-link" />
        <span className="avatar" title={user.name}>
          {initials(user.name)}
        </span>
        <button className="ghost" onClick={() => void signOut()}>
          Sign out
        </button>
        {/* The one thing this application is for, so it is the one filled button
            in the bar and it is in the same place on every page. */}
        <Link to="/record" className="nav-record">
          <RecordIcon size={16} />
          Record
        </Link>
      </nav>

      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/record" element={<RecordPage />} />
        <Route path="/watch/:id" element={<WatchPage />} />
        <Route
          path="/settings"
          element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
