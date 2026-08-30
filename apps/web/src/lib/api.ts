import type { Capabilities, PartTarget, UploadApi } from '@openloom/recorder';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    // Every call carries the session cookie; nothing here uses bearer tokens.
    credentials: 'same-origin',
    ...init,
    headers:
      init.body && !(init.body instanceof Blob)
        ? { 'content-type': 'application/json', ...init.headers }
        : init.headers,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = body.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? 'Something went wrong.',
      error.retryable ?? response.status >= 500,
    );
  }
  return body as T;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

export interface RecordingSummary {
  id: string;
  title: string;
  state: string;
  durationMs: number | null;
  bytes: number | null;
  createdAt: string;
  ownerId: string;
  ownerName: string;
}

export interface RecordingDetail {
  recording: RecordingSummary & { description: string | null; sourceMime: string | null };
  assets: { kind: string; bytes: number; contentType: string }[];
  playback: { url: string; kind: string } | null;
}

export interface StartedUpload {
  recordingId: string;
  uploadSessionId: string;
  partSize: number;
  capabilities: Capabilities;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: true }>('/v1/auth/logout', { method: 'POST' }),

  me: () => request<{ user: SessionUser }>('/v1/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/v1/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  listRecordings: (options: { cursor?: string; all?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.all) query.set('all', '1');
    const suffix = query.size > 0 ? `?${query}` : '';
    return request<{ recordings: RecordingSummary[]; nextCursor: string | null }>(
      `/v1/recordings${suffix}`,
    );
  },

  getRecording: (id: string) => request<RecordingDetail>(`/v1/recordings/${id}`),

  renameRecording: (id: string, title: string) =>
    request<{ recording: RecordingSummary }>(`/v1/recordings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteRecording: (id: string) => request<void>(`/v1/recordings/${id}`, { method: 'DELETE' }),

  startRecording: (input: { title: string; mimeType: string; recordedWith?: unknown }) =>
    request<StartedUpload>('/v1/recordings', { method: 'POST', body: JSON.stringify(input) }),

  completeUpload: (sessionId: string) =>
    request<{ recordingId: string; state: string }>(`/v1/uploads/${sessionId}/complete`, {
      method: 'POST',
    }),

  abortUpload: (sessionId: string) =>
    request<{ ok: true }>(`/v1/uploads/${sessionId}/abort`, { method: 'POST' }),

  getUploadSession: (sessionId: string) =>
    request<{ state: string; partSize: number; parts: { partNumber: number; bytes: number }[] }>(
      `/v1/uploads/${sessionId}`,
    ),

  listUsers: () => request<{ users: SessionUser[] }>('/v1/admin/users'),

  createUser: (input: { email: string; name: string; password: string; role: 'admin' | 'user' }) =>
    request<{ user: SessionUser }>('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listStorage: () =>
    request<{ storage: { id: string; kind: string; label: string; isDefault: boolean; status: string }[] }>(
      '/v1/admin/storage',
    ),

  createStorage: (input: { kind: string; label: string; config: unknown; secret?: unknown }) =>
    request<{ storage: { id: string } }>('/v1/admin/storage', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  makeStorageDefault: (id: string) =>
    request<unknown>(`/v1/admin/storage/${id}/default`, { method: 'POST' }),
};

/** The subset the recorder core needs, adapted to this client. */
export function uploadApiFor(): UploadApi {
  return {
    getPartTarget: (sessionId, partNumber) =>
      request<PartTarget>(`/v1/uploads/${sessionId}/parts/${partNumber}/target`, {
        method: 'POST',
      }),

    putPart: (sessionId, partNumber, blob) =>
      request<{ etag: string }>(`/v1/uploads/${sessionId}/parts/${partNumber}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      }),

    ackPart: (sessionId, partNumber, part) =>
      request<void>(`/v1/uploads/${sessionId}/parts/${partNumber}/ack`, {
        method: 'POST',
        body: JSON.stringify(part),
      }),
  };
}
