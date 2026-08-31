import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, type RecordingDetail } from '../lib/api.ts';
import { formatBytes, formatClock, formatRelative } from '../lib/format.ts';
import { SharePanel } from './SharePanel.tsx';
import { ArrowLeftIcon, TrashIcon } from '../components/icons.tsx';

/** How often to look again while the worker is still finishing the recording. */
const PROCESSING_POLL_MS = 3000;

export function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.getRecording(id);
      setDetail(result);
      // Only while not editing, so a poll cannot overwrite what is being typed.
      setTitle((current) => (current === '' ? result.recording.title : current));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load that recording.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A recording is watchable before it is finished, so this page opens on the
  // original file and quietly swaps in the processed one when it lands.
  const settling =
    detail !== null &&
    (detail.recording.state === 'processing' || detail.recording.state === 'uploading');
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void load(), PROCESSING_POLL_MS);
    return () => clearInterval(timer);
  }, [settling, load]);

  async function rename() {
    if (!id) return;
    const updated = await api.renameRecording(id, title);
    setDetail((current) =>
      current
        ? { ...current, recording: { ...current.recording, title: updated.recording.title } }
        : current,
    );
    setRenaming(false);
  }

  async function remove() {
    if (!id || !detail) return;
    if (!confirm(`Delete “${detail.recording.title}”? This cannot be undone.`)) return;
    await api.deleteRecording(id);
    navigate('/');
  }

  if (error) {
    return (
      <main className="page">
        <p className="banner bad">{error}</p>
        <p>
          <Link to="/">Back to recordings</Link>
        </p>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="page">
        <div className="skeleton" style={{ aspectRatio: '16 / 9' }} />
      </main>
    );
  }

  const { recording, playback, posterUrl } = detail;

  return (
    <main className="page">
      <Link to="/" className="back-link">
        <ArrowLeftIcon size={16} />
        Back to recordings
      </Link>

      {playback ? (
        // Plain video element and a URL that supports byte ranges. No player library
        // is needed until there is an adaptive stream to play.
        <video
          className="player"
          src={playback.url}
          poster={posterUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="player placeholder">
          <span className="spinner" />
          <p className="muted small">Getting this recording ready…</p>
        </div>
      )}

      <header className="watch-head">
        {renaming ? (
          <form
            className="inline"
            style={{ flex: 1 }}
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <input
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Title"
              autoFocus
            />
            <button type="submit">Save</button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setTitle(recording.title);
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h1 onDoubleClick={() => setRenaming(true)}>{recording.title}</h1>
            <button className="quiet" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button className="danger" onClick={() => void remove()} aria-label="Delete recording">
              <TrashIcon size={15} />
            </button>
          </>
        )}
      </header>

      <p className="meta-row">
        <span>{recording.ownerName}</span>
        <span className="meta-sep">·</span>
        <span>{formatRelative(recording.createdAt)}</span>
        {recording.durationMs ? (
          <>
            <span className="meta-sep">·</span>
            <span className="nums">{formatClock(recording.durationMs)}</span>
          </>
        ) : null}
        {recording.bytes ? (
          <>
            <span className="meta-sep">·</span>
            <span className="nums">{formatBytes(recording.bytes)}</span>
          </>
        ) : null}
        {recording.width && recording.height ? (
          <>
            <span className="meta-sep">·</span>
            <span className="nums">
              {recording.width}×{recording.height}
            </span>
          </>
        ) : null}
        {recording.state === 'processing' && (
          <span className="pill busy">
            <span className="pill-dot" />
            Still processing
          </span>
        )}
        {recording.state === 'failed' && (
          <span className="pill bad">
            <span className="pill-dot" />
            Failed
          </span>
        )}
      </p>

      <SharePanel recordingId={recording.id} />
    </main>
  );
}
