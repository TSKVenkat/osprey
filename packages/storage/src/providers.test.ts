import { describe } from 'vitest';

import { StagedConnector } from './staged.ts';
import { CloudinaryPublisher } from './cloudinary.ts';
import { ImagekitPublisher } from './imagekit.ts';
import { runConformanceSuite } from './conformance.ts';

/**
 * The real providers, run against real accounts when credentials are present.
 *
 * They skip rather than fail without them, so the suite still means something on a
 * machine with no accounts — but skipping is not passing, and these two are the
 * backends with no other proof behind them.
 */

const cloudinary = {
  cloudName: process.env.CLOUDINARY_TEST_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_TEST_API_KEY,
  apiSecret: process.env.CLOUDINARY_TEST_API_SECRET,
};

if (cloudinary.cloudName && cloudinary.apiKey && cloudinary.apiSecret) {
  runConformanceSuite('cloudinary', async () => {
    const connector = new StagedConnector({
      publisher: new CloudinaryPublisher({
        cloudName: cloudinary.cloudName!,
        apiKey: cloudinary.apiKey!,
        apiSecret: cloudinary.apiSecret!,
        folder: process.env.CLOUDINARY_TEST_FOLDER ?? 'openloom-conformance',
      }),
    });
    return { connector, cleanup: async () => {} };
  });
} else {
  describe.skip('storage conformance: cloudinary (set CLOUDINARY_TEST_* to run)', () => {});
}

const imagekit = {
  urlEndpoint: process.env.IMAGEKIT_TEST_URL_ENDPOINT,
  publicKey: process.env.IMAGEKIT_TEST_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_TEST_PRIVATE_KEY,
};

if (imagekit.urlEndpoint && imagekit.publicKey && imagekit.privateKey) {
  runConformanceSuite('imagekit', async () => {
    const connector = new StagedConnector({
      publisher: new ImagekitPublisher({
        urlEndpoint: imagekit.urlEndpoint!,
        publicKey: imagekit.publicKey!,
        privateKey: imagekit.privateKey!,
        folder: process.env.IMAGEKIT_TEST_FOLDER ?? 'openloom-conformance',
      }),
    });
    return { connector, cleanup: async () => {} };
  });
} else {
  describe.skip('storage conformance: imagekit (set IMAGEKIT_TEST_* to run)', () => {});
}
