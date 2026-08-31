import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type ShareLink } from '../lib/api.ts';
import { CheckIcon, LinkIcon } from '../components/icons.tsx';

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
  const [creating, setCreating] = useState(false);
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
    setCreating(true);
    try {
      await api.createShare(recordingId, {
        visibility,
        password: visibility === 'password' ? password : undefined,
      });
      setPassword('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create a link.');
    } finally {
      setCreating(false);
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
    <section className="card card-lg share">
      <div className="share-head">
        <h2 style={{ margin: 0 }}>Sharing</h2>
        {views && (
          <span className="muted small nums">
            {views.views} {views.views === 1 ? 'view' : 'views'} · {views.completions} watched to
            the end
          </span>
        )}
      </div>

      {shares.length > 0 && (
        <ul className="list">
          {shares.map((share) => (
            <li key={share.id} className="share-row">
              <span className="share-icon">
                <LinkIcon size={16} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* A link created before tokens were kept recoverable still works;
                    we just cannot show it again. */}
                <span className="mono">
                  {urlFor(share) ?? 'Link created earlier — cannot be shown again'}
                </span>
                <p className="muted small" style={{ margin: 0 }}>
                  {DESCRIPTIONS[share.visibility]}
                </p>
              </div>
              <div className="actions" style={{ marginTop: 0 }}>
                {urlFor(share) && (
                  <button className="quiet" onClick={() => void copy(share)}>
                    {copied === share.id ? <CheckIcon size={14} /> : null}
                    {copied === share.id ? 'Copied' : 'Copy'}
                  </button>
                )}
                <button
                  className="danger"
                  onClick={() => void api.revokeShare(share.id).then(refresh)}
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="share-form">
        <label>
          Who can watch
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as Visibility)}
          >
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
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Given to whoever should watch"
            />
          </label>
        )}

        <button
          onClick={() => void create()}
          disabled={creating || (visibility === 'password' && !password)}
        >
          {creating && <span className="spinner" />}
          Create link
        </button>
      </div>

      {error && <p className="banner bad">{error}</p>}
    </section>
  );
}
