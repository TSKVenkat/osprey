import { useEffect, useState } from 'react';
import { ApiError, api, type SessionUser, type StorageRow } from '../lib/api.ts';
import { formatRelative } from '../lib/format.ts';
import { CheckIcon, TrashIcon } from '../components/icons.tsx';

/**
 * Each backend needs different settings, and which of them are secret differs too.
 * Kept as data rather than four near-identical forms: the split between what is
 * shown back and what only ever goes in is the thing worth being explicit about.
 *
 * `required` drives the check that happens before anything is sent. The server
 * checks the same things, and has to; doing it here as well is what turns "The
 * request body is not valid" into a marked box beside the field that is empty.
 */
const BACKENDS = {
  local: {
    label: 'Local disk',
    note: 'Files on this machine. Fine for one server; nothing else can read them.',
    config: [
      {
        name: 'root',
        label: 'Directory',
        placeholder: './data/storage',
        hint: 'Must be writable by the server process.',
        required: true,
      },
    ],
    secret: [],
  },
  s3: {
    label: 'S3 or compatible',
    note: 'AWS S3, MinIO, R2, B2. The only backend a browser uploads to directly.',
    config: [
      { name: 'bucket', label: 'Bucket', placeholder: 'openloom', required: true },
      { name: 'region', label: 'Region', placeholder: 'us-east-1', required: false },
      {
        name: 'endpoint',
        label: 'Endpoint',
        placeholder: 'http://minio:9000',
        hint: 'Leave blank for AWS. For MinIO in Docker this is the container address.',
        required: false,
      },
      {
        name: 'publicEndpoint',
        label: 'Endpoint browsers use',
        placeholder: 'http://localhost:9000',
        hint: 'Only if browsers reach it at a different address than this server does.',
        required: false,
      },
    ],
    secret: [
      { name: 'accessKeyId', label: 'Access key id', required: true },
      { name: 'secretAccessKey', label: 'Secret access key', required: true },
    ],
  },
  cloudinary: {
    label: 'Cloudinary',
    note: 'Handles transcoding and adaptive streaming itself. Uploads are staged here first.',
    config: [
      {
        name: 'cloudName',
        label: 'Cloud name',
        placeholder: 'your-cloud',
        hint: 'From the Cloudinary dashboard. Not your account email.',
        required: true,
      },
      { name: 'folder', label: 'Folder', placeholder: 'openloom', required: false },
    ],
    secret: [
      { name: 'apiKey', label: 'API key', required: true },
      { name: 'apiSecret', label: 'API secret', required: true },
    ],
  },
  imagekit: {
    label: 'ImageKit',
    note: 'Adaptive streaming from a URL parameter. Uploads are staged here first.',
    config: [
      {
        name: 'urlEndpoint',
        label: 'URL endpoint',
        placeholder: 'https://ik.imagekit.io/your-id',
        required: true,
      },
      { name: 'publicKey', label: 'Public key', placeholder: 'public_…', required: true },
      { name: 'folder', label: 'Folder', placeholder: 'openloom', required: false },
    ],
    secret: [{ name: 'privateKey', label: 'Private key', required: true }],
  },
} as const;

type BackendKind = keyof typeof BACKENDS;
type Field = { name: string; label: string; required: boolean; hint?: string; placeholder?: string };

export function AdminPage() {
  const [tab, setTab] = useState<'storage' | 'people'>('storage');
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [storage, setStorage] = useState<StorageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function refresh() {
    setUsers((await api.listUsers()).users);
    setStorage((await api.listStorage()).storage);
  }

  useEffect(() => {
    void refresh().catch((caught: unknown) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not load settings.'),
    );
  }, []);

  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null);
    setSaved(null);
    try {
      await action();
      await refresh();
      // Said out loud, because the previous version gave no sign that anything had
      // happened beyond a new row appearing among several similar ones.
      if (done) setSaved(done);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
      throw caught;
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <div style={{ flex: 1 }}>
          <h1>Settings</h1>
          <p className="page-sub">Where recordings are kept, and who can make them.</p>
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'storage'}
          className={tab === 'storage' ? 'on' : ''}
          onClick={() => setTab('storage')}
        >
          Storage
        </button>
        <button
          role="tab"
          aria-selected={tab === 'people'}
          className={tab === 'people' ? 'on' : ''}
          onClick={() => setTab('people')}
        >
          People
        </button>
      </div>

      {error && <p className="banner bad">{error}</p>}
      {saved && (
        <p className="banner good">
          <CheckIcon size={16} />
          {saved}
        </p>
      )}

      {tab === 'storage' ? (
        <StorageSettings storage={storage} run={run} />
      ) : (
        <PeopleSettings users={users} run={run} />
      )}
    </main>
  );
}

type Run = (action: () => Promise<unknown>, done?: string) => Promise<void>;

function StorageSettings({ storage, run }: { storage: StorageRow[]; run: Run }) {
  const hasDefault = storage.some((row) => row.isDefault);

  return (
    <>
      {!hasDefault && storage.length > 0 && (
        <p className="banner warn">
          Nothing is set to receive new recordings. Choose one below.
        </p>
      )}

      <ul className="list stagger">
        {storage.map((row) => (
          <StorageCard key={row.id} row={row} run={run} />
        ))}
      </ul>

      <StorageForm hasDefault={hasDefault} run={run} />
    </>
  );
}

function StorageCard({ row, run }: { row: StorageRow; run: Run }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testStorage(row.id));
    } catch {
      setResult({ ok: false, reason: 'The test could not be run.' });
    } finally {
      setTesting(false);
    }
  }

  const failing = result ? !result.ok : row.status === 'failing';

  return (
    <li className={`card${row.isDefault ? ' is-default' : ''}`}>
      <div className="setting-row">
        <span className="setting-icon">{BACKENDS[row.kind as BackendKind]?.label.slice(0, 2) ?? '?'}</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="title">{row.label}</span>
          {row.isDefault && <span className="badge">Recordings go here</span>}
          <p className="muted small" style={{ margin: 0 }}>
            {BACKENDS[row.kind as BackendKind]?.label ?? row.kind}
            {row.lastTestedAt && ` · checked ${formatRelative(row.lastTestedAt)}`}
          </p>
        </div>

        <span className={`pill ${failing ? 'bad' : 'ok'}`}>
          <span className="pill-dot" />
          {failing ? 'Not working' : 'Working'}
        </span>

        <div className="actions" style={{ marginTop: 0 }}>
          <button className="quiet" onClick={() => void test()} disabled={testing}>
            {testing && <span className="spinner" />}
            {testing ? 'Testing…' : 'Test'}
          </button>
          {!row.isDefault && (
            <>
              <button
                className="quiet"
                onClick={() =>
                  void run(
                    () => api.makeStorageDefault(row.id),
                    `New recordings will go to ${row.label}.`,
                  ).catch(() => {})
                }
              >
                Use this
              </button>
              <button
                className="danger"
                aria-label={`Remove ${row.label}`}
                onClick={() => {
                  if (!confirm(`Remove “${row.label}”?`)) return;
                  void run(() => api.deleteStorage(row.id), `Removed ${row.label}.`).catch(() => {});
                }}
              >
                <TrashIcon size={15} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* The reason a backend is not usable, in the provider's own words. Without
          it "Not working" leaves an administrator guessing between a typo in a key,
          a bucket that does not exist, and a firewall. */}
      {result && !result.ok && result.reason && (
        <p className="banner bad" style={{ marginTop: '0.7rem' }}>
          {result.reason}
        </p>
      )}
      {result?.ok && (
        <p className="banner good" style={{ marginTop: '0.7rem' }}>
          <CheckIcon size={16} />
          Wrote a file, read it back and deleted it.
        </p>
      )}
    </li>
  );
}

function StorageForm({ hasDefault, run }: { hasDefault: boolean; run: Run }) {
  const [kind, setKind] = useState<BackendKind>('local');
  const [label, setLabel] = useState('Local disk');
  const [values, setValues] = useState<Record<string, string>>({ root: './data/storage' });
  // Adding storage almost always means wanting to use it. The exception is adding
  // a second one to move to later, so it is a choice rather than an assumption.
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);

  const backend = BACKENDS[kind];
  const fields: Field[] = [...backend.config, ...backend.secret];

  function pick(subset: readonly { name: string }[]) {
    const picked: Record<string, string> = {};
    for (const field of subset) {
      const value = values[field.name]?.trim();
      if (value) picked[field.name] = value;
    }
    return picked;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    // Checked before anything is sent, because a round trip that ends in a generic
    // "not valid" for an empty box is a slower way of saying the same thing.
    const empty = fields.filter((field) => field.required && !values[field.name]?.trim());
    setMissing(empty.map((field) => field.name));
    if (empty.length > 0) return;

    setSaving(true);
    void run(
      () =>
        api.createStorage({
          kind,
          label,
          config: pick(backend.config),
          secret: pick(backend.secret),
          makeDefault: makeDefault || !hasDefault,
        }),
      makeDefault || !hasDefault
        ? `Saved. New recordings will go to ${label}.`
        : `Saved ${label}. Recordings still go to the current default.`,
    )
      .catch(() => {})
      .finally(() => setSaving(false));
  }

  function input(field: Field, secret: boolean) {
    const wrong = missing.includes(field.name);
    return (
      <label key={field.name}>
        {field.label}
        {!field.required && <span className="field-hint"> — optional</span>}
        <input
          type={secret ? 'password' : 'text'}
          className={wrong ? 'wrong' : ''}
          value={values[field.name] ?? ''}
          placeholder={field.placeholder ?? ''}
          autoComplete={secret ? 'new-password' : 'off'}
          aria-invalid={wrong || undefined}
          onChange={(event) => {
            setValues((current) => ({ ...current, [field.name]: event.target.value }));
            setMissing((current) => current.filter((name) => name !== field.name));
          }}
        />
        {wrong ? (
          <span className="field-hint error">{field.label} is needed.</span>
        ) : field.hint ? (
          <span className="field-hint">{field.hint}</span>
        ) : null}
      </label>
    );
  }

  return (
    <form className="card card-lg form storage-form" onSubmit={submit}>
      <h3>Add storage</h3>

      <label>
        Backend
        <select
          value={kind}
          onChange={(event) => {
            const next = event.target.value as BackendKind;
            setKind(next);
            setLabel(BACKENDS[next].label);
            setValues(next === 'local' ? { root: './data/storage' } : {});
            setMissing([]);
          }}
        >
          {Object.entries(BACKENDS).map(([value, option]) => (
            <option key={value} value={value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="field-hint">{backend.note}</span>
      </label>

      <label>
        Name
        <input value={label} onChange={(event) => setLabel(event.target.value)} required />
      </label>

      {backend.config.map((field) => input(field, false))}
      {backend.secret.map((field) => input(field, true))}

      <label className="inline">
        <input
          type="checkbox"
          checked={makeDefault || !hasDefault}
          disabled={!hasDefault}
          onChange={(event) => setMakeDefault(event.target.checked)}
        />
        Use this for new recordings
      </label>
      {!hasDefault && (
        <p className="field-hint">Nothing is storing recordings yet, so this will be used.</p>
      )}

      {/* Saving writes a test file, reads it back and deletes it, so a backend that
          cannot be written to is rejected here rather than mid-recording. That takes
          a moment, and a second click while it runs used to save a second copy. */}
      <button type="submit" disabled={saving}>
        {saving && <span className="spinner" />}
        {saving ? 'Testing the connection…' : 'Test and save'}
      </button>
    </form>
  );
}

function PeopleSettings({ users, run }: { users: SessionUser[]; run: Run }) {
  const [draft, setDraft] = useState({
    email: '',
    name: '',
    password: '',
    role: 'user' as 'admin' | 'user',
  });
  const [saving, setSaving] = useState(false);

  return (
    <>
      <ul className="list stagger">
        {users.map((user) => (
          <li key={user.id} className="card">
            <div className="setting-row">
              <span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="title">{user.name}</span>
                <p className="muted small" style={{ margin: 0 }}>
                  {user.email}
                </p>
              </div>
              {user.role === 'admin' && <span className="pill accent">Admin</span>}
            </div>
          </li>
        ))}
      </ul>

      <form
        className="card card-lg form"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void run(() => api.createUser(draft), `${draft.name} can sign in now.`)
            .then(() => setDraft({ email: '', name: '', password: '', role: 'user' }))
            .catch(() => {})
            .finally(() => setSaving(false));
        }}
      >
        <h3>Add someone</h3>
        <label>
          Name
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={draft.password}
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
            minLength={10}
            required
          />
          <span className="field-hint">At least 10 characters. They can change it later.</span>
        </label>
        <label>
          Role
          <select
            value={draft.role}
            onChange={(event) =>
              setDraft({ ...draft, role: event.target.value as 'admin' | 'user' })
            }
          >
            <option value="user">Can record and share their own recordings</option>
            <option value="admin">Can also change these settings</option>
          </select>
        </label>
        <button type="submit" disabled={saving}>
          {saving && <span className="spinner" />}
          Create account
        </button>
      </form>
    </>
  );
}
