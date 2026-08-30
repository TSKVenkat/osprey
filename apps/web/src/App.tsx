import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { RecordPage } from './pages/RecordPage.tsx';
import { WatchPage } from './pages/WatchPage.tsx';
import { PublicWatchPage } from './pages/PublicWatchPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';

export function App() {
  const { user, loading } = useSession();

  return (
    <Routes>
      {/* Outside the sign-in gate: a share link has to work for someone with no
          account, which is the whole point of it. */}
      <Route path="/s/:token" element={<PublicWatchPage />} />
      <Route
        path="*"
        element={loading ? <Loading /> : user ? <SignedIn /> : <LoginPage />}
      />
    </Routes>
  );
}

function Loading() {
  return <main className="centered"><p className="muted">Loading…</p></main>;
}

function SignedIn() {
  const { user, signOut } = useSession();
  if (!user) return null;

  return (
    <>
      <nav className="nav">
        <Link className="brand" to="/">openloom</Link>
        <Link to="/record">Record</Link>
        {user.role === 'admin' && <Link to="/settings">Settings</Link>}
        <span className="spacer" />
        <span className="muted small">{user.name}</span>
        <button className="quiet" onClick={() => void signOut()}>Sign out</button>
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
