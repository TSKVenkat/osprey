# Changelog

Notable changes, newest first.

Nothing has been released yet, so there are no version numbers to point at — `main`
is what exists. The first tagged release will start the usual `Added` / `Changed` /
`Fixed` sections.

## Unreleased

First public version. Record your screen in a browser, get a share link, watch it
back.

- Screen, window or tab capture, with microphone, system audio, and a camera bubble
  that can be dragged anywhere on screen while recording.
- Parts upload while recording continues, so the share link is live one to three
  seconds after you press stop, regardless of how long the recording ran.
- Crash recovery: parts are written to the browser's own file system as they are
  made, so an interrupted recording can be finished rather than lost.
- Share links that work without an account, optionally behind a password, revocable
  immediately. View and completion counts for the owner.
- Four storage backends — S3 and compatible, Cloudinary, ImageKit, local disk —
  behind one interface, added and tested from the settings screen, with credentials
  encrypted at rest.
- ffmpeg normalisation to a faststart H.264/AAC MP4 with a poster frame, doing the
  cheapest thing that will work: reuse, remux, or transcode.
- Email and password accounts with two roles, sessions that revoke on the spot, and
  login rate limiting keyed by address and account together.
- Licensed AGPL-3.0.
