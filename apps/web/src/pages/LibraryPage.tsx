import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RecordingSummary } from '../lib/api.ts';
import { formatBytes, formatDate } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

export function LibraryPage() {
  const { user } = useSession();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (options: { cursor?: string; all: boolean; append: boolean }) => {
      setLoading(true);
      const page = await api.listRecordings({ cursor: options.cursor, all: options.all });
      setRecordings((current) => (options.append ? [...current, ...page.recordings] : page.recordings));
      setCursor(page.nextCursor);
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    void load({ all: showAll, append: false });
  }, [load, showAll]);

  async function remove(id: string) {
    if (!confirm('Delete this recording?')) return;
    await api.deleteRecording(id);
    setRecordings((current) => current.filter((r) => r.id !== id));
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Recordings</h1>
        {user?.role === 'admin' && (
          <label className="inline">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Everyone&rsquo;s recordings
          </label>
        )}
      </header>

      {recordings.length === 0 && !loading && (
        <p className="muted">Nothing here yet. Record something.</p>
      )}

      <ul className="list">
        {recordings.map((recording) => (
          <li key={recording.id} className="card row">
            <div>
              <Link className="title" to={`/watch/${recording.id}`}>
                {recording.title}
              </Link>
              <p className="muted small">
                {formatDate(recording.createdAt)} · {formatBytes(recording.bytes)}
                {showAll && ` · ${recording.ownerName}`}
                {recording.state !== 'ready' && ` · ${recording.state}`}
              </p>
            </div>
            <button className="quiet" onClick={() => void remove(recording.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      {cursor && (
        <button
          className="quiet"
          disabled={loading}
          onClick={() => void load({ cursor, all: showAll, append: true })}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
