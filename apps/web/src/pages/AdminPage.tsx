import { useEffect, useState } from 'react';
import { ApiError, api, type SessionUser } from '../lib/api.ts';

interface StorageRow {
  id: string;
  kind: string;
  label: string;
  isDefault: boolean;
  status: string;
}

export function AdminPage() {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [storage, setStorage] = useState<StorageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newUser, setNewUser] = useState({ email: '', name: '', password: '', role: 'user' as const });
  const [newStorage, setNewStorage] = useState({ label: 'Local disk', root: './data/storage' });

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

        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api.createStorage({
                kind: 'local',
                label: newStorage.label,
                config: { root: newStorage.root },
              }),
            );
          }}
        >
          <h3>Add local disk</h3>
          <label>
            Label
            <input
              value={newStorage.label}
              onChange={(e) => setNewStorage({ ...newStorage, label: e.target.value })}
            />
          </label>
          <label>
            Directory
            <input
              value={newStorage.root}
              onChange={(e) => setNewStorage({ ...newStorage, root: e.target.value })}
            />
          </label>
          {/* Saving writes a test file, reads it back and deletes it, so a directory
              that cannot be written to is rejected here rather than mid-recording. */}
          <button type="submit">Test and save</button>
        </form>
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
