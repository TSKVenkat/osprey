# Changelog

Notable changes, newest first. Dates are when the change landed on `main`.

This project has not cut a release yet, so there are no version numbers to point
at — `main` is what exists. The first tagged release will start the usual
`Added`/`Changed`/`Fixed` sections; until then this file is a record of what
happened and why, which is the part worth keeping.

## Unreleased

### Changed

- **Renamed from `openloom` to `bilby`, with a new mark.** "Loom" is a trademark and
  the old name was close enough to it to be a problem for anyone running this at any
  scale. The obvious replacement, `capybara`, is a well known Ruby testing framework
  and would have left this project as the second result for its own name. A bilby is
  all ears and digs its own burrow, which is close enough to the pitch, and the ears
  are the one part of the animal that still reads at sixteen pixels in a browser tab.

  This renames the Postgres role and database, the MinIO bucket, the session cookie
  and the package scope, so an existing instance needs its volumes recreated rather
  than upgraded in place.

### Added

- **Open-sourced under the AGPL-3.0.** Licence, contributing guide, security
  policy, code of conduct, and issue and pull request templates. The interface
  links to its own source on every page, which is how section 13 asks for it to be
  done.
- **Thumbnails.** The worker had been cutting a poster frame from every recording
  since it was written and nothing ever displayed it. The list and detail endpoints
  return a URL for it now, and the player opens on it rather than on black.
- **A draggable camera window.** The camera is a real window on the screen that can
  be moved mid-recording and is captured where you put it, rather than a bubble
  pinned to one corner of the output.
- **Floating recording controls**, in a Document Picture-in-Picture window, so the
  recording can be paused or stopped without switching back to the tab being
  recorded.
- **Crash recovery.** Parts are spilled to the origin private file system while
  recording, so a browser that dies mid-recording can offer to finish the upload
  rather than losing it.

### Changed

- **A light theme, blue, in DM Sans**, and no dark mode. A player that inverts with
  the viewer's system setting is a different product depending on who opens the
  link.
- **The library is a grid** rather than a list of filenames, with relative times,
  durations and state.
- **Storage settings say what is wrong.** Each backend can be tested on the spot and
  reports what the provider actually said; required fields are marked before
  anything is sent.
- **Saving a storage backend can start using it** in the same step. Saving and
  activating used to be separate, and doing only the first left a working
  configuration that nothing ever wrote to, with nothing on screen to say so.

### Fixed

- **Staged uploads lost their parts between requests.** `StagedConnector` chose a
  fresh temporary directory the first time each instance needed one, and the API
  builds a connector per request — so every part of an upload landed somewhere
  different and completing it found nothing. Every recording to Cloudinary or
  ImageKit failed with "Part 1 is missing". The conformance suite now builds a
  second connector between calls, which is the shape a request-scoped connector
  actually has.
- **Testing a storage backend could hang forever.** There was no timeout, and the
  two mistakes people actually make both hang rather than fail: an endpoint that
  silently drops packets, and a directory the process cannot reach. Twenty seconds
  now, and a message naming the likely cause.
- **Recordings lied about their state.** One mid-upload sat there until the page was
  reloaded by hand; one stuck for hours still said "Uploading". Both views refresh
  while something is genuinely in flight, and anything still mid-upload a quarter of
  an hour later is called interrupted.
- **The stack refused to start** next to anything else already using Postgres. The
  published ports are configurable now.
- **Chrome recorded WebM with an infinite duration**, which is what leaves the
  scrubber broken. The codec preference list never matched MP4 because Chrome has
  no AAC in `MediaRecorder`; it pairs MP4 with Opus instead.
- **Login was rate limited by address alone**, so one office behind one address
  could lock each other out. Keyed by address and account together.
