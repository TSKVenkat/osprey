import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalConnector } from './local.ts';
import { runConformanceSuite } from './conformance.ts';

const roots: string[] = [];

runConformanceSuite('local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openloom-local-'));
  roots.push(root);
  return {
    connector: new LocalConnector({
      root,
      baseUrl: 'http://localhost:3000/files',
      signingSecret: 'test-secret',
    }),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
});
