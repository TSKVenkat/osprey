# Storage

Recordings go to storage you control. Four backends ship, they are added through
**Settings** in the running application, and every one of them is tested — written
to, read back, deleted — before it is saved. A backend that cannot be written to is
rejected there rather than in the middle of somebody's recording.

Credentials are encrypted at rest with `SECRET_KEY` and no endpoint returns them,
not even to an administrator. They go in, they are used, that is all.

## What each one needs

### Local disk

| Field | Example |
|---|---|
| Directory | `./data/storage` |

Fine for one server. The API and the worker must see the same path — under compose
they share a volume for exactly this reason — and nothing else can read the files,
so playback is served by the API through signed URLs.

### S3 or compatible

AWS S3, MinIO, Cloudflare R2, Backblaze B2.

| Field | Example |
|---|---|
| Bucket | `osprey` |
| Region | `us-east-1` |
| Endpoint | blank for AWS, `http://minio:9000` for MinIO in compose |
| Endpoint browsers use | only if browsers reach it at a different address |
| Access key id, Secret access key | |

The last field is the one that catches people. Inside compose the API reaches MinIO
at `http://minio:9000`, but a browser cannot resolve `minio` — it needs
`http://localhost:9000`. Set both and the URLs are signed for the right host each
time.

This is the only backend a browser uploads to directly.

### Cloudinary

| Field | Example |
|---|---|
| Cloud name | from the dashboard, not your account email |
| Folder | `osprey` |
| API key, API secret | |

### ImageKit

| Field | Example |
|---|---|
| URL endpoint | `https://ik.imagekit.io/your-id` |
| Public key | `public_…` |
| Folder | `osprey` |
| Private key | |

## What they can actually do

Declared capabilities are checked against measured behaviour by a shared conformance
suite, so this table is what the providers do rather than what they claim.

| | S3/MinIO | Cloudinary | ImageKit | Local disk |
|---|---|---|---|---|
| Browser uploads directly | yes | no, staged | no, staged | no |
| Multipart, parallel | yes, native | yes, into staging | yes, into staging | yes |
| Resumable | yes | yes | yes | yes |
| Signed reads | yes | yes | yes | yes |
| Byte ranges | yes | yes | yes | yes |
| Immediately consistent | yes | yes | **no** | yes |
| Returns the exact bytes given | yes | yes | **only with `orig-true`** | yes |
| Accepts non-media bytes | yes | **no** | serves them oddly | yes |
| Transcodes for you | no | yes | yes, on the fly | no |
| Adaptive streaming | no | HLS + DASH | HLS + DASH | no |
| Smallest part | 5 MiB | 1 byte | 1 byte | 1 byte |

Three of those are worth saying in words, because each one cost a bug:

**Cloudinary rejects non-media uploads outright.** The connection test and the
conformance suite both have to send real video to it, not random bytes.

**ImageKit serves an optimised rendition by default**, which is not the file you
uploaded. Reads add `?tr=orig-true` to get the original back. Its index is also
eventually consistent, so `stat` goes through an HTTP HEAD and deletes retry.

**Cloudinary and ImageKit are whole-file providers**, so uploads are staged locally
and published as one object when complete. The staging directory is shared and
fixed, because the parts of a single upload arrive across several requests and each
request builds its own connector. Running more than one API process needs that
directory on shared storage.

## Adding a backend

Implement `StorageConnector` from `packages/storage/src/types.ts` and run the
conformance suite against it:

```ts
runConformanceSuite('your backend', async () => ({
  connector: makeYourConnector(),
  fresh: () => makeYourConnector(),
  cleanup: async () => {
    /* remove whatever the test left behind */
  },
}));
```

The suite is what makes "pluggable storage" a property of the system rather than an
intention. A backend is finished when it passes.

Two things it checks that are easy to miss. It rebuilds the connector **between
every call**, because the API constructs one per request and a connector that keeps
upload state in a field works perfectly in a test that reuses one object and fails
the moment it is deployed — that exact bug shipped once. And it checks declared
capabilities against what the backend actually did, so claiming
`immediatelyConsistent` when you are not fails the suite rather than producing a
subtle bug months later.
