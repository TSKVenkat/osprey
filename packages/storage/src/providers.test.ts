import { describe } from 'vitest';

import type { StorageConnector } from './types.ts';
import { StagedConnector } from './staged.ts';
import { CloudinaryPublisher } from './cloudinary.ts';
import { ImagekitPublisher } from './imagekit.ts';
import { AzureBlobPublisher } from './azure.ts';
import { runConformanceSuite } from './conformance.ts';

/**
 * The real providers, run against real accounts when credentials are present.
 *
 * They skip rather than fail without credentials, so the suite still runs on a
 * machine with no provider accounts — but skipping is not passing.
 */

/**
 * Records every object the suite creates so it can be removed afterwards.
 *
 * Most conformance tests have no reason to delete what they wrote — the local and
 * S3 backends are thrown away wholesale between runs. A real account is not, and
 * leaving a dozen files in someone's Cloudinary every time the suite runs is not
 * an acceptable way to borrow their credentials.
 */
function tracked(connector: StorageConnector): {
  connector: StorageConnector;
  cleanup: () => Promise<void>;
} {
  const created = new Set<string>();

  const wrapper: StorageConnector = Object.create(connector, {
    createUpload: {
      value: async (input: Parameters<StorageConnector['createUpload']>[0]) => {
        created.add(input.objectKey);
        return connector.createUpload(input);
      },
    },
  });

  return {
    connector: wrapper,
    cleanup: async () => {
      await Promise.all(
        [...created].map((objectKey) => connector.delete(objectKey).catch(() => undefined)),
      );
    },
  };
}

function trackedFactory(build: () => StorageConnector): {
  connector: StorageConnector;
  fresh: () => StorageConnector;
  cleanup: () => Promise<void>;
} {
  const created = new Set<string>();
  const wrap = (connector: StorageConnector): StorageConnector =>
    Object.create(connector, {
      createUpload: {
        value: async (input: Parameters<StorageConnector['createUpload']>[0]) => {
          created.add(input.objectKey);
          return connector.createUpload(input);
        },
      },
    });

  return {
    connector: wrap(build()),
    fresh: () => wrap(build()),
    cleanup: async () => {
      const connector = build();
      await Promise.all([...created].map((key) => connector.delete(key).catch(() => undefined)));
    },
  };
}

const azure = {
  accountName: process.env.AZURE_TEST_ACCOUNT_NAME,
  accountKey: process.env.AZURE_TEST_ACCOUNT_KEY,
  container: process.env.AZURE_TEST_CONTAINER,
  endpoint: process.env.AZURE_TEST_ENDPOINT,
};

if (azure.accountName && azure.accountKey && azure.container) {
  runConformanceSuite('azure blob storage', async () =>
    trackedFactory(() => new StagedConnector({
      publisher: new AzureBlobPublisher({
        accountName: azure.accountName!,
        accountKey: azure.accountKey!,
        container: azure.container!,
        endpoint: azure.endpoint,
      }),
    })),
  );
} else {
  describe.skip('storage conformance: azure blob storage (set AZURE_TEST_* to run)', () => {});
}

const cloudinary = {
  cloudName: process.env.CLOUDINARY_TEST_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_TEST_API_KEY,
  apiSecret: process.env.CLOUDINARY_TEST_API_SECRET,
};

if (cloudinary.cloudName && cloudinary.apiKey && cloudinary.apiSecret) {
  runConformanceSuite('cloudinary', async () => {
    return tracked(
      new StagedConnector({
        publisher: new CloudinaryPublisher({
          cloudName: cloudinary.cloudName!,
          apiKey: cloudinary.apiKey!,
          apiSecret: cloudinary.apiSecret!,
          // Everything the suite writes lands under one folder, so anything it
          // still manages to leave behind is obvious and easy to remove by hand.
          folder: process.env.CLOUDINARY_TEST_FOLDER ?? 'osprey-conformance',
        }),
      }),
    );
  }, {
    // Cloudinary inspects what it is given and rejects anything that is not real
    // video, so the suite uploads an actual MP4 rather than random bytes.
    payload: 'media',
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
    return tracked(
      new StagedConnector({
        publisher: new ImagekitPublisher({
          urlEndpoint: imagekit.urlEndpoint!,
          publicKey: imagekit.publicKey!,
          privateKey: imagekit.privateKey!,
          folder: process.env.IMAGEKIT_TEST_FOLDER ?? 'osprey-conformance',
        }),
      }),
    );
  });
} else {
  describe.skip('storage conformance: imagekit (set IMAGEKIT_TEST_* to run)', () => {});
}
