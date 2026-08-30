import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { RecordPage } from './pages/RecordPage.tsx';
import { WatchPage } from './pages/WatchPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';

export function App() {
  const { user, loading, signOut } = useSession();

  if (loading) return <main className="centered"><p className="muted">Loading…</p></main>;
  if (!user) return <LoginPage />;

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
