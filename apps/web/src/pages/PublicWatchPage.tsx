import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError, api, type SharedRecording } from '../lib/api.ts';
import { formatDate } from '../lib/format.ts';

type State =
  | { status: 'loading' }
  | { status: 'ready'; shared: SharedRecording }
  | { status: 'password' }
  | { status: 'gone'; message: string };

/**
 * Identifies one viewing, so a player reporting progress every few seconds counts
 * as one view rather than twenty. Kept in sessionStorage so a refresh continues the
 * same viewing rather than starting a new one.
 */
function viewingKey(token: string): string {
  const storageKey = `openloom.view.${token}`;
  let key: string | null = null;
  try {
    key = sessionStorage.getItem(storageKey);
  } catch {
    // Private browsing can refuse storage entirely; a fresh key per load is a fine
    // fallback and only over-counts in an unusual case.
  }
  if (!key) {
    key = crypto.randomUUID();
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {
      // Nothing to do; the key still works for this page load.
    }
  }
  return key;
}

export function PublicWatchPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState({ status: 'ready', shared: await api.getShared(token) });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) {
        setState({ status: 'password' });
      } else if (caught instanceof ApiError && caught.status === 401) {
        setState({ status: 'gone', message: 'Sign in to watch this recording.' });
      } else {
        setState({
          status: 'gone',
          message:
            caught instanceof ApiError ? caught.message : 'That link is not available.',
        });
      }
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Progress is reported on a timer and once more as the page goes away, so a
  // viewer who closes the tab still counts for what they watched.
  useEffect(() => {
    if (state.status !== 'ready' || !token) return;
    const key = viewingKey(token);

    const report = () => {
      const element = video.current;
      if (!element || element.currentTime === 0) return;
      void api
        .reportView(token, {
          sessionKey: key,
          watchedMs: Math.round(element.currentTime * 1000),
          maxPositionMs: Math.round(element.currentTime * 1000),
          completed: element.duration > 0 && element.currentTime / element.duration > 0.9,
        })
        .catch(() => {
          // Analytics must never interrupt playback.
        });
    };

    const timer = setInterval(report, 15_000);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', report);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', report);
      report();
    };
  }, [state.status, token]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setUnlockError(null);
    try {
      await api.unlockShare(token, password);
      setState({ status: 'loading' });
      await load();
    } catch (caught) {
      setUnlockError(caught instanceof ApiError ? caught.message : 'Could not unlock.');
    }
  }

  if (state.status === 'loading') {
    return <main className="page"><p className="muted">Loading…</p></main>;
  }

  if (state.status === 'gone') {
    return (
      <main className="centered">
        <div className="card">
          <p className="title">Not available</p>
          {/* Deliberately vague: revoked, expired and never-existed all look the
              same, so this page cannot be used to find out which. */}
          <p className="muted small">{state.message}</p>
        </div>
      </main>
    );
  }

  if (state.status === 'password') {
    return (
      <main className="centered">
        <form className="card form" onSubmit={unlock}>
          <h1>Password required</h1>
          <p className="muted small">This recording is protected.</p>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </label>
          {unlockError && <p className="error">{unlockError}</p>}
          <button type="submit">Watch</button>
        </form>
      </main>
    );
  }

  const { recording, share, playback } = state.shared;

  return (
    <main className="page">
      <h1>{recording.title}</h1>
      <p className="muted small">
        {recording.ownerName} · {formatDate(recording.createdAt)}
      </p>

      {playback ? (
        <video ref={video} className="player" src={playback.url} controls playsInline preload="metadata" />
      ) : (
        <p className="muted">This recording is still being prepared.</p>
      )}

      {recording.description && <p>{recording.description}</p>}

      {share.allowDownload && playback && (
        <p>
          <a href={playback.url} download>
            Download
          </a>
        </p>
      )}
    </main>
  );
}
