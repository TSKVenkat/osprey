import type { Part } from './coalescer.ts';

export interface StoredManifest {
  recordingId: string;
  uploadSessionId: string;
  mimeType: string;
  partSize: number;
  startedAt: number;
  state: 'recording' | 'uploading' | 'done';
  parts: { partNumber: number; bytes: number; uploaded: boolean }[];
}

/**
 * Where parts live between being recorded and being acknowledged by the server.
 *
 * This exists because a tab can die at any moment, and a forty-minute recording
 * held only in memory dies with it. The ordering rule is the whole point: bytes are
 * written here first, and released only once the server has confirmed them.
 */
export interface PartStore {
  put(recordingId: string, part: Part): Promise<void>;
  get(recordingId: string, partNumber: number): Promise<Blob | null>;
  release(recordingId: string, partNumber: number): Promise<void>;
  list(recordingId: string): Promise<number[]>;

  /**
   * The bytes recorded since the last whole part. Rewritten as the recording goes,
   * so a crash loses at most one chunk rather than up to a whole part.
   */
  putTail(recordingId: string, blob: Blob): Promise<void>;
  getTail(recordingId: string): Promise<Blob | null>;
  clearTail(recordingId: string): Promise<void>;

  saveManifest(manifest: StoredManifest): Promise<void>;
  loadManifests(): Promise<StoredManifest[]>;
  deleteRecording(recordingId: string): Promise<void>;
}

/**
 * In-memory store. Used in tests, and as the fallback when a browser has no OPFS —
 * which loses the crash-recovery guarantee, so callers are told rather than being
 * quietly downgraded.
 */
export class MemoryPartStore implements PartStore {
  private readonly parts = new Map<string, Map<number, Blob>>();
  private readonly tails = new Map<string, Blob>();
  private readonly manifests = new Map<string, StoredManifest>();

  async put(recordingId: string, part: Part): Promise<void> {
    let forRecording = this.parts.get(recordingId);
    if (!forRecording) {
      forRecording = new Map();
      this.parts.set(recordingId, forRecording);
    }
    forRecording.set(part.partNumber, part.blob);
  }

  async get(recordingId: string, partNumber: number): Promise<Blob | null> {
    return this.parts.get(recordingId)?.get(partNumber) ?? null;
  }

  async release(recordingId: string, partNumber: number): Promise<void> {
    this.parts.get(recordingId)?.delete(partNumber);
  }

  async list(recordingId: string): Promise<number[]> {
    return [...(this.parts.get(recordingId)?.keys() ?? [])].sort((a, b) => a - b);
  }

  async putTail(recordingId: string, blob: Blob): Promise<void> {
    this.tails.set(recordingId, blob);
  }

  async getTail(recordingId: string): Promise<Blob | null> {
    return this.tails.get(recordingId) ?? null;
  }

  async clearTail(recordingId: string): Promise<void> {
    this.tails.delete(recordingId);
  }

  async saveManifest(manifest: StoredManifest): Promise<void> {
    this.manifests.set(manifest.recordingId, manifest);
  }

  async loadManifests(): Promise<StoredManifest[]> {
    return [...this.manifests.values()];
  }

  async deleteRecording(recordingId: string): Promise<void> {
    this.parts.delete(recordingId);
    this.tails.delete(recordingId);
    this.manifests.delete(recordingId);
  }
}

/**
 * Parts as files in the origin private file system, with manifests alongside them.
 *
 * OPFS rather than IndexedDB for the bytes: it stores blobs without serialising
 * them, and a file per part means a part can be dropped the moment it is confirmed
 * without rewriting anything else.
 */
export class OpfsPartStore implements PartStore {
  private root: FileSystemDirectoryHandle | null = null;

  static isAvailable(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  }

  private async directory(recordingId: string): Promise<FileSystemDirectoryHandle> {
    this.root ??= await navigator.storage.getDirectory();
    const recordings = await this.root.getDirectoryHandle('recordings', { create: true });
    return recordings.getDirectoryHandle(recordingId, { create: true });
  }

  private static fileName(partNumber: number): string {
    // Zero-padded so a directory listing is already in part order.
    return `part-${String(partNumber).padStart(6, '0')}.bin`;
  }

  async put(recordingId: string, part: Part): Promise<void> {
    const directory = await this.directory(recordingId);
    const handle = await directory.getFileHandle(OpfsPartStore.fileName(part.partNumber), {
      create: true,
    });
    const writable = await handle.createWritable();
    await part.blob.stream().pipeTo(writable);
  }

  async get(recordingId: string, partNumber: number): Promise<Blob | null> {
    const directory = await this.directory(recordingId);
    try {
      const handle = await directory.getFileHandle(OpfsPartStore.fileName(partNumber));
      return await handle.getFile();
    } catch {
      return null;
    }
  }

  async release(recordingId: string, partNumber: number): Promise<void> {
    const directory = await this.directory(recordingId);
    await directory.removeEntry(OpfsPartStore.fileName(partNumber)).catch(() => undefined);
  }

  async list(recordingId: string): Promise<number[]> {
    const directory = await this.directory(recordingId);
    const numbers: number[] = [];
    // keys() is in every browser that has OPFS but is missing from lib.dom.
    const iterable = directory as unknown as { keys(): AsyncIterable<string> };
    for await (const name of iterable.keys()) {
      const match = /^part-(\d+)\.bin$/.exec(name);
      if (match) numbers.push(Number(match[1]));
    }
    return numbers.sort((a, b) => a - b);
  }

  async putTail(recordingId: string, blob: Blob): Promise<void> {
    const directory = await this.directory(recordingId);
    const handle = await directory.getFileHandle('tail.bin', { create: true });
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
  }

  async getTail(recordingId: string): Promise<Blob | null> {
    const directory = await this.directory(recordingId);
    try {
      const file = await (await directory.getFileHandle('tail.bin')).getFile();
      return file.size > 0 ? file : null;
    } catch {
      return null;
    }
  }

  async clearTail(recordingId: string): Promise<void> {
    const directory = await this.directory(recordingId);
    await directory.removeEntry('tail.bin').catch(() => undefined);
  }

  /** Manifests are small and JSON-shaped, so they sit in localStorage where they can
   *  be read synchronously while the page is starting up. */
  async saveManifest(manifest: StoredManifest): Promise<void> {
    localStorage.setItem(`osprey.manifest.${manifest.recordingId}`, JSON.stringify(manifest));
  }

  async loadManifests(): Promise<StoredManifest[]> {
    const found: StoredManifest[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('osprey.manifest.')) continue;
      try {
        found.push(JSON.parse(localStorage.getItem(key)!) as StoredManifest);
      } catch {
        // A manifest we cannot read is a manifest we cannot recover from; drop it
        // rather than blocking startup on it.
        localStorage.removeItem(key);
      }
    }
    return found;
  }

  async deleteRecording(recordingId: string): Promise<void> {
    this.root ??= await navigator.storage.getDirectory();
    const recordings = await this.root.getDirectoryHandle('recordings', { create: true });
    await recordings.removeEntry(recordingId, { recursive: true }).catch(() => undefined);
    localStorage.removeItem(`osprey.manifest.${recordingId}`);
  }
}
