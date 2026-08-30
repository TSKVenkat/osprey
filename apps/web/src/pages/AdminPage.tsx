import { useEffect, useState } from 'react';
import { ApiError, api, type SessionUser } from '../lib/api.ts';

interface StorageRow {
  id: string;
  kind: string;
  label: string;
  isDefault: boolean;
  status: string;
}

/**
 * Each backend needs different settings, and which of them are secret differs too.
 * Kept as data rather than four near-identical forms: the split between what is
 * shown back and what only ever goes in is the thing worth being explicit about.
 */
const BACKENDS = {
  local: {
    label: 'Local disk',
    note: 'Files on this machine. Fine for one server; nothing else can read them.',
    config: [{ name: 'root', label: 'Directory', placeholder: './data/storage' }],
    secret: [],
  },
  s3: {
    label: 'S3 or compatible',
    note: 'AWS S3, MinIO, R2, B2. The only backend a browser uploads to directly.',
    config: [
      { name: 'bucket', label: 'Bucket', placeholder: 'openloom' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
      { name: 'endpoint', label: 'Endpoint (leave blank for AWS)', placeholder: '' },
    ],
    secret: [
      { name: 'accessKeyId', label: 'Access key id' },
      { name: 'secretAccessKey', label: 'Secret access key' },
    ],
  },
  cloudinary: {
    label: 'Cloudinary',
    note: 'Handles transcoding and adaptive streaming itself. Uploads are staged here first.',
    config: [
      { name: 'cloudName', label: 'Cloud name', placeholder: 'your-cloud' },
      { name: 'folder', label: 'Folder (optional)', placeholder: 'openloom' },
    ],
    secret: [
      { name: 'apiKey', label: 'API key' },
      { name: 'apiSecret', label: 'API secret' },
    ],
  },
  imagekit: {
    label: 'ImageKit',
    note: 'Adaptive streaming from a URL parameter. Uploads are staged here first.',
    config: [
      { name: 'urlEndpoint', label: 'URL endpoint', placeholder: 'https://ik.imagekit.io/your-id' },
      { name: 'publicKey', label: 'Public key', placeholder: '' },
      { name: 'folder', label: 'Folder (optional)', placeholder: 'openloom' },
    ],
    secret: [{ name: 'privateKey', label: 'Private key' }],
  },
} as const;

type BackendKind = keyof typeof BACKENDS;

function StorageForm({
  onSave,
}: {
  onSave: (input: { kind: string; label: string; config: unknown; secret: unknown }) => void;
}) {
  const [kind, setKind] = useState<BackendKind>('local');
  const [label, setLabel] = useState('Local disk');
  const [values, setValues] = useState<Record<string, string>>({ root: './data/storage' });

  const backend = BACKENDS[kind];

  function pick(fields: readonly { name: string }[]) {
    const picked: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name]?.trim();
      if (value) picked[field.name] = value;
    }
    return picked;
  }

  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          kind,
          label,
          config: pick(backend.config),
          secret: pick(backend.secret),
        });
      }}
    >
      <h3>Add storage</h3>

      <label>
        Backend
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as BackendKind;
            setKind(next);
            setLabel(BACKENDS[next].label);
            setValues(next === 'local' ? { root: './data/storage' } : {});
          }}
        >
          {Object.entries(BACKENDS).map(([value, backendOption]) => (
            <option key={value} value={value}>
              {backendOption.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{backend.note}</p>

      <label>
        Name
        <input value={label} onChange={(e) => setLabel(e.target.value)} required />
      </label>

      {backend.config.map((field) => (
        <label key={field.name}>
          {field.label}
          <input
            value={values[field.name] ?? ''}
            placeholder={'placeholder' in field ? field.placeholder : ''}
            onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))}
          />
        </label>
      ))}

      {backend.secret.map((field) => (
        <label key={field.name}>
          {field.label}
          <input
            type="password"
            value={values[field.name] ?? ''}
            autoComplete="new-password"
            onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))}
          />
        </label>
      ))}

      {/* Saving writes a test file, reads it back and deletes it, so a backend that
          cannot be written to is rejected here rather than mid-recording. */}
      <button type="submit">Test and save</button>
    </form>
  );
}

export function AdminPage() {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [storage, setStorage] = useState<StorageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newUser, setNewUser] = useState({ email: '', name: '', password: '', role: 'user' as const });

  async function refresh() {
    setUsers((await api.listUsers()).users);
    setStorage((await api.listStorage()).storage);
  }

  useEffect(() => {
    void refresh().catch((caught: unknown) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not load settings.'),
    );
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <main className="page">
      <h1>Settings</h1>
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Storage</h2>
        <ul className="list">
          {storage.map((row) => (
            <li key={row.id} className="card row">
              <div>
                <span className="title">{row.label}</span>
                <p className="muted small">
                  {row.kind} · {row.status}
                  {row.isDefault && ' · default'}
                </p>
              </div>
              {!row.isDefault && (
                <button className="quiet" onClick={() => void run(() => api.makeStorageDefault(row.id))}>
                  Make default
                </button>
              )}
            </li>
          ))}
        </ul>

        <StorageForm onSave={(input) => run(() => api.createStorage(input))} />
      </section>

      <section>
        <h2>People</h2>
        <ul className="list">
          {users.map((user) => (
            <li key={user.id} className="card row">
              <div>
                <span className="title">{user.name}</span>
                <p className="muted small">
                  {user.email} · {user.role}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.createUser(newUser);
              setNewUser({ email: '', name: '', password: '', role: 'user' });
            });
          }}
        >
          <h3>Invite someone</h3>
          <label>
            Name
            <input
              value={newUser.name}
              onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              required
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              minLength={10}
              required
            />
          </label>
          <button type="submit">Create account</button>
        </form>
      </section>
    </main>
  );
}
