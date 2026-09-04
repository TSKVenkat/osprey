# Roadmap

What is likely next, why, and — as importantly — what is deliberately not planned.

Nothing here is a promise. It is the order things would be done in if they get done.

## Accounts

**A third role, `viewer`.** There are two today, `admin` and `user`, and the gap is
the person who should watch but never record: a manager, a customer, a contractor.
Right now they need an account that can also record, or no account at all. A viewer
would open recordings shared with them and create nothing. Three route guards and
one enum value.

**Scoped API tokens.** A session cookie is the wrong credential for uploading from
CI or automating exports — it belongs to a browser and carries every permission its
owner has. A token would have a label, an optional expiry, be shown once and stored
hashed, and be restricted to what it is for:

```
recordings:read     uploads:write     shares:write     admin:storage
```

The rule that matters: a token can never exceed the permissions of the account that
minted it, and it resolves to the same user a cookie does, so it cannot become a
second, weaker path around the checks that already exist.

**Service accounts**, for tokens that should outlive the person who made them. Not
before tokens exist, since there would be nothing for them to hold.

**Single sign-on**, as generic OIDC rather than a list of named providers, so that
Okta, Google and Authentik are one code path. Last, because it is the largest of
these by a wide margin and benefits nobody until somebody is running this for a team
big enough to have an identity provider — not first, just because it is the most
interesting.

## Recording and playback

- Adaptive streaming for the backends that do not provide it themselves.
- A desktop client. The capture core is already free of React and of the DOM beyond
  what capture requires, behind a `CaptureSource` seam, so this is a client rather
  than a rewrite.
- Trimming, which is the one edit almost every recording wants.

## Operations

- More than one API process, which needs the staged-upload directory on shared
  storage.
- Metrics worth alerting on, rather than logs to read after the fact.

## Not planned

**No AI features.** Not transcription, not summaries, not chapters, not "ask your
video". This is the point of the project rather than an omission, and requests for
it are closed politely and immediately.

**No permission lattice.** No workspaces, no folders, no per-object ACLs. Every
object here has exactly one owner. Systems that need that machinery need it because
they hold many tenants and thousands of objects shared in complicated ways; adding
it here would produce a settings screen nobody can answer questions about, and every
feature afterwards would have to be expressed in it.

**No multi-tenancy.** One instance is one team. Running two teams means running two
instances, which is cheap, and keeps the data model honest.
