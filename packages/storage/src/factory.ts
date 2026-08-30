import { LocalConnector } from './local.ts';
import { S3Connector } from './s3.ts';
import { StagedConnector } from './staged.ts';
import { CloudinaryPublisher } from './cloudinary.ts';
import { ImagekitPublisher } from './imagekit.ts';
import { StorageError } from './errors.ts';
import type { StorageConnector } from './types.ts';

export interface ConnectorContext {
  /** Base URL the API serves local files from, including the configuration id. */
  localBaseUrl: string;
  /** Signs local read URLs. */
  signingSecret: string;
  /** Where whole-file providers assemble parts before publishing them. */
  stagingRoot?: string;
}

/**
 * Builds a connector from a stored configuration.
 *
 * One switch, used by both the API and the worker. It was duplicated while there
 * were two backends; at four it is the kind of duplication that drifts.
 */
export function buildConnector(
  input: { kind: string; config: Record<string, unknown>; secret: Record<string, unknown> },
  context: ConnectorContext,
): StorageConnector {
  const { kind, config, secret } = input;

  switch (kind) {
    case 'local':
      return new LocalConnector({
        root: String(config.root),
        baseUrl: context.localBaseUrl,
        signingSecret: context.signingSecret,
      });

    case 's3':
      return new S3Connector({
        bucket: String(config.bucket),
        region: config.region ? String(config.region) : undefined,
        endpoint: config.endpoint ? String(config.endpoint) : undefined,
        publicEndpoint: config.publicEndpoint ? String(config.publicEndpoint) : undefined,
        forcePathStyle: Boolean(config.forcePathStyle),
        accessKeyId: String(secret.accessKeyId),
        secretAccessKey: String(secret.secretAccessKey),
      });

    case 'cloudinary':
      return new StagedConnector({
        stagingRoot: context.stagingRoot,
        publisher: new CloudinaryPublisher({
          cloudName: String(config.cloudName),
          folder: config.folder ? String(config.folder) : undefined,
          apiKey: String(secret.apiKey),
          apiSecret: String(secret.apiSecret),
        }),
      });

    case 'imagekit':
      return new StagedConnector({
        stagingRoot: context.stagingRoot,
        publisher: new ImagekitPublisher({
          urlEndpoint: String(config.urlEndpoint),
          folder: config.folder ? String(config.folder) : undefined,
          publicKey: String(config.publicKey),
          privateKey: String(secret.privateKey),
        }),
      });

    default:
      throw new StorageError('UNSUPPORTED', `Storage backend "${kind}" is not built yet.`);
  }
}
