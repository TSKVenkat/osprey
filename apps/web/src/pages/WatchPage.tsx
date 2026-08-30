import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, type RecordingDetail } from '../lib/api.ts';
import { formatBytes, formatDate } from '../lib/format.ts';
import { SharePanel } from './SharePanel.tsx';

export function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (!id) return;
    api
      .getRecording(id)
      .then((result) => {
        setDetail(result);
        setTitle(result.recording.title);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load that recording.'),
      );
  }, [id]);

  async function rename() {
    if (!id) return;
    const updated = await api.renameRecording(id, title);
    setDetail((current) =>
      current ? { ...current, recording: { ...current.recording, title: updated.recording.title } } : current,
    );
    setRenaming(false);
  }

  if (error) {
    return (
      <main className="page">
        <p className="error">{error}</p>
        <Link to="/">Back to recordings</Link>
      </main>
    );
  }

  if (!detail) return <main className="page"><p className="muted">Loading…</p></main>;

  const { recording, playback } = detail;

  return (
    <main className="page">
      <header className="page-header">
        {renaming ? (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <button type="submit">Save</button>
          </form>
        ) : (
          <h1 onDoubleClick={() => setRenaming(true)}>{recording.title}</h1>
        )}
        <button className="quiet" onClick={() => setRenaming((current) => !current)}>
          {renaming ? 'Cancel' : 'Rename'}
        </button>
      </header>

      {playback ? (
        // Plain video element and a URL that supports byte ranges. No player library
        // is needed until there is an adaptive stream to play.
        <video className="player" src={playback.url} controls playsInline preload="metadata" />
      ) : (
        <p className="muted">
          This recording has no playable file yet. If it was just made, give it a moment.
        </p>
      )}

      <p className="muted small">
        {recording.ownerName} · {formatDate(recording.createdAt)} · {formatBytes(recording.bytes)}
        {recording.state !== 'ready' && ` · ${recording.state}`}
      </p>

      <SharePanel recordingId={recording.id} />

      <p style={{ marginTop: '1.25rem' }}>
        <Link to="/">Back to recordings</Link>
      </p>
    </main>
  );
}
