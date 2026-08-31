import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RecordingSummary } from '../lib/api.ts';
import { formatBytes, formatClock, formatRelative } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import { FilmIcon, PlayIcon, RecordIcon, TrashIcon } from '../components/icons.tsx';

/**
 * How often to look again while something is still being processed.
 *
 * A recording appears in the library the moment its upload finishes and becomes
 * playable a few seconds later. Without this the card sits on "Processing" until
 * the page is reloaded by hand, which reads as a stuck upload.
 */
const PROCESSING_POLL_MS = 4000;

/**
 * How long a recording can sit mid-upload before it has plainly stopped.
 *
 * Uploading overlaps with recording, and processing takes seconds, so anything
 * still in either state after this is not in progress — the tab was closed, or the
 * storage backend rejected it. The sweeper tidies these up on its own schedule;
 * until then, saying "Uploading" about something from this morning is a lie.
 */
const STALLED_AFTER_MS = 15 * 60 * 1000;

/** The states that are going somewhere on their own, so are worth watching. */
function isSettling(recording: { state: string; createdAt: string }): boolean {
  if (recording.state !== 'uploading' && recording.state !== 'processing') return false;
  return Date.now() - new Date(recording.createdAt).getTime() < STALLED_AFTER_MS;
}

export function LibraryPage() {
  const { user } = useSession();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (options: { cursor?: string; all: boolean; append: boolean }) => {
      if (options.append) setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await api.listRecordings({ cursor: options.cursor, all: options.all });
        setRecordings((current) =>
          options.append ? [...current, ...page.recordings] : page.recordings,
        );
        setCursor(page.nextCursor);
        setError(null);
      } catch {
        setError('Could not load your recordings.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load({ all: showAll, append: false });
  }, [load, showAll]);

  // Refreshes only the first page, and only while something on it is still
  // settling. Nothing polls a library of finished recordings.
  const settling = recordings.some(isSettling);
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(
      () => void load({ all: showAll, append: false }),
      PROCESSING_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [settling, showAll, load]);

  async function remove(recording: RecordingSummary) {
    if (!confirm(`Delete “${recording.title}”? This cannot be undone.`)) return;
    // Removed from the list first: the request has already been confirmed, and
    // waiting on the round trip makes a decided action feel unresponsive.
    setRecordings((current) => current.filter((r) => r.id !== recording.id));
    try {
      await api.deleteRecording(recording.id);
    } catch {
      setError('That recording could not be deleted.');
      void load({ all: showAll, append: false });
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recordings;
    return recordings.filter(
      (recording) =>
        recording.title.toLowerCase().includes(needle) ||
        recording.ownerName.toLowerCase().includes(needle),
    );
  }, [recordings, query]);

  return (
    <main className="page wide">
      <header className="page-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>Recordings</h1>
          <p className="page-sub">
            {loading
              ? 'Loading…'
              : recordings.length === 0
                ? 'Nothing here yet.'
                : `${recordings.length}${cursor ? '+' : ''} recording${recordings.length === 1 ? '' : 's'}`}
          </p>
        </div>

        {recordings.length > 0 && (
          <input
            type="search"
            className="search"
            placeholder="Search"
            aria-label="Search recordings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}

        {user?.role === 'admin' && (
          <label className="inline">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />
            Everyone&rsquo;s recordings
          </label>
        )}
      </header>

      {error && <p className="banner bad">{error}</p>}

      {loading && recordings.length === 0 && <SkeletonGrid />}

      {!loading && recordings.length === 0 && (
        <div className="empty">
          <span className="empty-mark">
            <FilmIcon size={26} />
          </span>
          <h2>No recordings yet</h2>
          <p className="muted">Record your screen and you will get a link to share.</p>
          <Link to="/record" className="nav-record" style={{ marginTop: '0.5rem' }}>
            <RecordIcon size={16} />
            Record something
          </Link>
        </div>
      )}

      {visible.length === 0 && recordings.length > 0 && (
        <p className="muted" style={{ padding: '2rem 0' }}>
          Nothing matches “{query}”.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="grid stagger">
          {visible.map((recording) => (
            <Tile
              key={recording.id}
              recording={recording}
              showOwner={showAll}
              onDelete={() => void remove(recording)}
            />
          ))}
        </ul>
      )}

      {cursor && !query && (
        <div className="actions centre" style={{ marginTop: '1.5rem' }}>
          <button
            className="quiet"
            disabled={loadingMore}
            onClick={() => void load({ cursor, all: showAll, append: true })}
          >
            {loadingMore && <span className="spinner" />}
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </main>
  );
}

function Tile({
  recording,
  showOwner,
  onDelete,
}: {
  recording: RecordingSummary;
  showOwner: boolean;
  onDelete: () => void;
}) {
  const watchable = recording.state === 'ready';

  return (
    <li className="tile">
      <Link className="thumb" to={`/watch/${recording.id}`} tabIndex={-1} aria-hidden="true">
        {recording.posterUrl ? (
          <img src={recording.posterUrl} alt="" loading="lazy" />
        ) : (
          <span className="thumb-empty">
            <FilmIcon size={30} />
          </span>
        )}
        <span className="thumb-play">
          <span>
            <PlayIcon size={18} />
          </span>
        </span>
        {watchable && recording.durationMs ? (
          <span className="thumb-time">{formatClock(recording.durationMs)}</span>
        ) : null}
      </Link>

      <div className="tile-actions">
        <button className="quiet" onClick={onDelete} aria-label={`Delete ${recording.title}`}>
          <TrashIcon size={14} />
        </button>
      </div>

      <div className="tile-body">
        <Link className="tile-title" to={`/watch/${recording.id}`}>
          {recording.title}
        </Link>
        <p className="tile-meta">
          <StatePill recording={recording} />
          <span>{formatRelative(recording.createdAt)}</span>
          {recording.bytes ? (
            <>
              <span className="meta-sep">·</span>
              <span className="nums">{formatBytes(recording.bytes)}</span>
            </>
          ) : null}
          {showOwner && (
            <>
              <span className="meta-sep">·</span>
              <span>{recording.ownerName}</span>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

/**
 * What is happening to a recording, in words rather than a database value.
 *
 * "ready" is left unsaid: every card would carry it, and a label every row shares
 * carries no information.
 */
function StatePill({ recording }: { recording: RecordingSummary }) {
  const { state } = recording;
  if (state === 'ready') return null;

  if (state === 'failed' || (!isSettling(recording) && state !== 'ready')) {
    return (
      <span className="pill bad">
        <span className="pill-dot" />
        {state === 'failed' ? 'Failed' : 'Interrupted'}
      </span>
    );
  }

  return (
    <span className="pill busy">
      <span className="pill-dot" />
      {state === 'uploading' ? 'Uploading' : 'Processing'}
    </span>
  );
}

/** The shape of what is coming, so the page does not jump when it arrives. */
function SkeletonGrid() {
  return (
    <ul className="grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="tile">
          <div className="skeleton skeleton-thumb" />
          <div className="tile-body">
            <div className="skeleton skeleton-line" style={{ width: '75%' }} />
            <div className="skeleton skeleton-line" style={{ width: '45%' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
