import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Logo } from '../components/icons.tsx';
import { SourceLink } from '../components/SourceLink.tsx';

export function LoginPage() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card card-lg form sign-in" onSubmit={submit}>
        <div className="sign-in-head">
          <Logo size={40} />
          <h1>bilby</h1>
          <p className="muted small">Record your screen. Share a link.</p>
        </div>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            placeholder="you@example.com"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="banner bad">{error}</p>}

        <button type="submit" className="big" disabled={busy}>
          {busy && <span className="spinner" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="centre small muted" style={{ margin: 0 }}>
          <SourceLink />
        </p>
      </form>
    </main>
  );
}
