import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type ShareLink } from '../lib/api.ts';

type Visibility = 'link' | 'password' | 'authenticated';

const DESCRIPTIONS: Record<Visibility, string> = {
  link: 'Anyone with the link can watch.',
  password: 'Anyone with the link and the password can watch.',
  authenticated: 'Anyone with an account on this instance can watch.',
};

export function SharePanel({ recordingId }: { recordingId: string }) {
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [views, setViews] = useState<{ views: number; completions: number } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('link');
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [linkList, viewCounts] = await Promise.all([
      api.listShares(recordingId),
      api.getViews(recordingId),
    ]);
    setShares(linkList.shares);
    setViews(viewCounts);
  }, [recordingId]);

  useEffect(() => {
    void refresh().catch(() => setError('Could not load sharing settings.'));
  }, [refresh]);

  function urlFor(share: ShareLink): string | null {
    return share.token ? `${window.location.origin}/s/${share.token}` : null;
  }

  async function create() {
    setError(null);
    try {
      await api.createShare(recordingId, {
        visibility,
        password: visibility === 'password' ? password : undefined,
      });
      setPassword('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create a link.');
    }
  }

  async function copy(share: ShareLink) {
    const url = urlFor(share);
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(share.id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <section className="card" style={{ marginTop: '1.25rem' }}>
      <h2 style={{ marginTop: 0 }}>Sharing</h2>

      {views && (
        <p className="muted small">
          {views.views} {views.views === 1 ? 'view' : 'views'} · {views.completions} watched to the
          end
        </p>
      )}

      <ul className="list">
        {shares.map((share) => (
          <li key={share.id} className="row">
            <div>
              {/* A link created before tokens were kept recoverable still works; we
                  just cannot show it again. */}
              <span className="mono small">{urlFor(share) ?? 'Link created earlier — cannot be shown again'}</span>
              <p className="muted small">{DESCRIPTIONS[share.visibility]}</p>
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              {urlFor(share) && (
                <button className="quiet" onClick={() => void copy(share)}>
                  {copied === share.id ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                className="quiet danger"
                onClick={() => void api.revokeShare(share.id).then(refresh)}
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="form">
        <label>
          Who can watch
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
            <option value="link">Anyone with the link</option>
            <option value="password">Anyone with the link and a password</option>
            <option value="authenticated">Anyone signed in here</option>
          </select>
        </label>

        {visibility === 'password' && (
          <label>
            Password
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Given to whoever should watch"
            />
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <button onClick={() => void create()} disabled={visibility === 'password' && !password}>
          Create link
        </button>
      </div>
    </section>
  );
}
