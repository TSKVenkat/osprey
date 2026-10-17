import { createHmac } from 'node:crypto';
import { open, stat as statFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { StorageError } from './errors.ts';
import { assertSafeKey } from './keys.ts';
import type { ByteRange, ObjectStat, PlaybackTarget } from './types.ts';
import type { Publisher } from './staged.ts';

const API_VERSION = '2023-11-03';
const BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_BLOCKS = 50_000;

export interface AzureBlobOptions {
  accountName: string;
  accountKey: string;
  container: string;
  /** Override for Azure-compatible endpoints and private clouds. */
  endpoint?: string;
}

/**
 * Azure Blob Storage publisher. The connector stages upload parts locally and
 * publishes completed files as a sequence of blocks, so no upload state lives on
 * this instance and files larger than a single request stay bounded in memory.
 */
export class AzureBlobPublisher implements Publisher {
  readonly kind = 'azure' as const;
  readonly delivery = {
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: false,
    adaptiveStreaming: false,
    immediatelyConsistent: true,
    maxObjectBytes: BLOCK_BYTES * MAX_BLOCKS,
  } as const;

  private readonly accountName: string;
  private readonly accountKey: Buffer;
  private readonly container: string;
  private readonly endpoint: string;

  constructor(options: AzureBlobOptions) {
    this.accountName = options.accountName;
    this.accountKey = Buffer.from(options.accountKey, 'base64');
    this.container = options.container;
    this.endpoint = (options.endpoint ?? `https://${options.accountName}.blob.core.windows.net`).replace(/\/+$/, '');
    if (!this.accountName || !this.container || this.accountKey.length === 0) {
      throw new StorageError('PROVIDER_ERROR', 'Azure account name, container, and base64 account key are required.');
    }
  }

  async publish(input: { localPath: string; objectKey: string; contentType: string }): Promise<{ bytes: number }> {
    assertSafeKey(input.objectKey);
    const info = await statFile(input.localPath);
    const count = Math.max(1, Math.ceil(info.size / BLOCK_BYTES));
    if (count > MAX_BLOCKS) {
      throw new StorageError('PROVIDER_ERROR', `Azure Blob Storage supports at most ${MAX_BLOCKS} blocks per object.`);
    }

    const handle = await open(input.localPath, 'r');
    const blockIds: string[] = [];
    try {
      for (let index = 0; index < count; index++) {
        const length = Math.min(BLOCK_BYTES, info.size - index * BLOCK_BYTES);
        const buffer = Buffer.alloc(length);
        if (length > 0) await handle.read(buffer, 0, length, index * BLOCK_BYTES);
        const blockId = Buffer.from(String(index).padStart(8, '0')).toString('base64');
        await this.request(input.objectKey, 'PUT', {
          query: { comp: 'block', blockid: blockId },
          body: buffer,
          headers: { 'Content-Length': String(length) },
        });
        blockIds.push(blockId);
      }
    } finally {
      await handle.close();
    }

    const xml = '<?xml version="1.0" encoding="utf-8"?><BlockList>' +
      blockIds.map((id) => `<Latest>${id}</Latest>`).join('') +
      '</BlockList>';
    await this.request(input.objectKey, 'PUT', {
      query: { comp: 'blocklist' },
      body: Buffer.from(xml),
      headers: {
        'Content-Type': 'application/xml',
        'x-ms-blob-content-type': input.contentType,
      },
    });
    return { bytes: info.size };
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    assertSafeKey(objectKey);
    const response = await this.request(objectKey, 'HEAD', { allowNotFound: true });
    if (response.status === 404) return null;
    return {
      bytes: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async remove(objectKey: string): Promise<void> {
    assertSafeKey(objectKey);
    await this.request(objectKey, 'DELETE', { allowNotFound: true });
  }

  async playbackUrl(objectKey: string, options: { ttlSeconds: number }): Promise<PlaybackTarget> {
    assertSafeKey(objectKey);
    const ttl = Math.max(1, options.ttlSeconds);
    const bucket = Math.floor(Date.now() / 1000 / ttl);
    const expiresAtSeconds = (bucket + 2) * ttl;
    const expires = new Date(expiresAtSeconds * 1000).toISOString();
    const resource = `/blob/${this.accountName}/${this.container}/${objectKey}`;
    const stringToSign = [
      'r', '', expires, resource, '', '', 'https', API_VERSION, 'b', '', '', '', '', '', '', '', '',
    ].join('\n');
    const signature = createHmac('sha256', this.accountKey).update(stringToSign, 'utf8').digest('base64');
    const url = new URL(this.blobUrl(objectKey));
    url.searchParams.set('sp', 'r');
    url.searchParams.set('se', expires);
    url.searchParams.set('spr', 'https');
    url.searchParams.set('sv', API_VERSION);
    url.searchParams.set('sr', 'b');
    url.searchParams.set('sig', signature);
    return { url: url.toString(), kind: 'progressive', expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  async openRead(objectKey: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(objectKey);
    const response = await this.request(objectKey, 'GET', {
      headers: range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {},
      allowNotFound: true,
    });
    if (response.status === 404) throw new StorageError('NOT_FOUND', `No object at ${objectKey}.`);
    if (!response.body) throw new StorageError('PROVIDER_ERROR', 'Azure returned an empty response body.');
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  }

  private blobUrl(objectKey: string): string {
    const encoded = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${this.endpoint}/${encodeURIComponent(this.container)}/${encoded}`;
  }

  private async request(
    objectKey: string,
    method: string,
    options: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Buffer;
      allowNotFound?: boolean;
    } = {},
  ): Promise<Response> {
    const url = new URL(this.blobUrl(objectKey));
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': API_VERSION,
      ...options.headers,
    };
    const body = options.body;
    if (body && !headers['Content-Length']) headers['Content-Length'] = String(body.byteLength);
    headers.Authorization = this.authorization(method, url, headers, body?.byteLength ?? 0);

    const response = await fetch(url, { method, headers, body: body as unknown as BodyInit | undefined });
    if (options.allowNotFound && response.status === 404) return response;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      if (response.status === 404) throw new StorageError('NOT_FOUND', `No object at ${objectKey}.`);
      throw new StorageError(
        'PROVIDER_ERROR',
        `Azure Blob Storage returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    return response;
  }

  private authorization(
    method: string,
    url: URL,
    headers: Record<string, string>,
    contentLength: number,
  ): string {
    const normalized = Object.entries(headers)
      .filter(([name]) => name.toLowerCase().startsWith('x-ms-'))
      .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}:${value}\n`)
      .join('');
    const resource = `/${this.accountName}${url.pathname}`;
    const query = [...url.searchParams.entries()]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}:${value}\n`)
      .join('');
    const canonicalResource = resource + (query ? `\n${query.trimEnd()}` : '');
    const stringToSign = [
      method, '', '', contentLength === 0 ? '' : String(contentLength), '', headers['Content-Type'] ?? '',
      '', '', '', '', '', headers.Range ?? '', normalized + canonicalResource,
    ].join('\n');
    const signature = createHmac('sha256', this.accountKey).update(stringToSign, 'utf8').digest('base64');
    return `SharedKey ${this.accountName}:${signature}`;
  }
}
