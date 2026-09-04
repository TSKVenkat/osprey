import { describe, expect, it } from 'vitest';
import { publicIdFor, resourceTypeFor } from './cloudinary.ts';
import { adaptiveUrlFor, filePathFor, pathFor } from './imagekit.ts';

/**
 * How our object keys map onto each provider's addressing.
 *
 * This is the part of a provider adapter most likely to be quietly wrong, and the
 * only part that can be checked without an account: everything else is one HTTP
 * call away from a service neither the test suite nor CI can reach.
 */

describe('Cloudinary public ids', () => {
  it('drops the extension, because Cloudinary appends the format itself', () => {
    // Keeping it produces original.mp4.mp4 and a file nothing can find again.
    expect(publicIdFor('r/abc/original.mp4')).toBe('r/abc/original');
    expect(publicIdFor('r/abc/poster/9f75.webp')).toBe('r/abc/poster/9f75');
  });

  it('keeps the folder structure, which Cloudinary understands', () => {
    expect(publicIdFor('r/abc/mp4/9f75.mp4')).toBe('r/abc/mp4/9f75');
  });

  it('prefixes an account folder when one is configured', () => {
    expect(publicIdFor('r/abc/original.mp4', 'bilby')).toBe('bilby/r/abc/original');
    expect(publicIdFor('r/abc/original.mp4', 'bilby/')).toBe('bilby/r/abc/original');
  });

  it('leaves a key with no extension alone', () => {
    expect(publicIdFor('r/abc/original')).toBe('r/abc/original');
  });

  it('does not mistake a hash for an extension', () => {
    // A sixteen character content hash is longer than any real extension.
    expect(publicIdFor('r/abc/mp4/9f7590aabbccddee.mp4')).toBe('r/abc/mp4/9f7590aabbccddee');
  });
});

describe('Cloudinary resource types', () => {
  it('separates video, image and everything else', () => {
    // These are separate namespaces: an asset uploaded as one cannot be read back
    // as another, so getting this wrong makes a file unreachable.
    expect(resourceTypeFor('video/mp4')).toBe('video');
    expect(resourceTypeFor('video/webm')).toBe('video');
    expect(resourceTypeFor('image/webp')).toBe('image');
    expect(resourceTypeFor('application/octet-stream')).toBe('raw');
  });
});

describe('ImageKit paths', () => {
  it('splits a key into the folder and file name it wants', () => {
    expect(pathFor('r/abc/original.mp4')).toEqual({
      folder: '/r/abc',
      fileName: 'original.mp4',
    });
  });

  it('prefixes an account folder', () => {
    expect(pathFor('r/abc/original.mp4', 'bilby')).toEqual({
      folder: '/bilby/r/abc',
      fileName: 'original.mp4',
    });
  });

  it('tolerates slashes around the configured folder', () => {
    expect(pathFor('r/abc/original.mp4', '/bilby/').folder).toBe('/bilby/r/abc');
  });

  it('puts a bare key at the root', () => {
    expect(pathFor('original.mp4')).toEqual({ folder: '/', fileName: 'original.mp4' });
  });

  it('rebuilds the full path for lookups and URLs', () => {
    expect(filePathFor('r/abc/original.mp4')).toBe('/r/abc/original.mp4');
    expect(filePathFor('r/abc/original.mp4', 'bilby')).toBe('/bilby/r/abc/original.mp4');
    expect(filePathFor('original.mp4')).toBe('/original.mp4');
  });

  it('keeps the extension, unlike Cloudinary', () => {
    // ImageKit addresses files by their real path, so the extension is part of it.
    expect(filePathFor('r/abc/poster/9f75.webp')).toBe('/r/abc/poster/9f75.webp');
  });
});

describe('ImageKit adaptive streaming', () => {
  it('is a URL, with no pipeline behind it', () => {
    // The manifest and its renditions are produced on the first request, which is
    // the whole reason to pick this backend.
    const url = adaptiveUrlFor('r/abc/original.mp4', {
      urlEndpoint: 'https://ik.imagekit.io/demo',
    });
    expect(url).toBe(
      'https://ik.imagekit.io/demo/r/abc/original.mp4/ik-master.m3u8?tr=sr-240_360_480_720_1080',
    );
  });

  it('takes a custom ladder', () => {
    const url = adaptiveUrlFor('r/abc/original.mp4', {
      urlEndpoint: 'https://ik.imagekit.io/demo/',
      ladder: 'sr-360_720',
    });
    expect(url).toContain('?tr=sr-360_720');
    // A trailing slash on the endpoint must not produce a doubled one.
    expect(url).not.toContain('demo//');
  });
});
