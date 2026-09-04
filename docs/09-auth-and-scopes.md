# 09 — Authentication and scopes: what Windmill does, and what is worth taking

A look at how [Windmill](https://www.windmill.dev) handles accounts, roles and API
credentials, and an honest reckoning of which parts apply here. Windmill is a much
larger system — a script and workflow platform with workspaces and tenants — so most
of its model is answering questions this project does not have. Two parts of it are
directly useful, one is worth copying almost exactly, and the rest should be left
alone.

## What osprey does today

- **Email and password**, bcrypt at 12 rounds, with a dummy hash compared against
  when no user matches so an unknown address costs the same time as a known one.
- **Sessions are rows**, not signed tokens: a cookie carries an opaque id, the row
  carries an expiry, and revocation is a delete. Changing someone's role or
  disabling them revokes every session they have.
- **Two roles**, `admin` and `user`, on the users table.
  - `requireAuth` — signed in.
  - `requireAdmin` — administrators only: storage configuration, accounts.
  - `requireOwnerOrAdmin` — your own recording, or any recording if you are an
    admin. A non-owner gets **404, not 403**, so the endpoint does not confirm that
    an id exists.
- **Login is rate limited by address *and* account together**, so one office behind
  one address cannot lock each other out, and one address cannot grind through
  accounts.
- **Share links** are the only other credential: an unguessable token, optionally
  password-protected, revocable, and checked server-side.

There is no API token. Everything is a browser session.

## What Windmill does

### Roles

| Role | What it is for |
|---|---|
| Superadmin | The whole instance. Admin of every workspace by default. |
| Devops | Instance-level but read-focused — "a readonly superadmin", for logs and alerts. |
| Workspace admin | One workspace: all of its content, its permissions, its members. |
| Developer | Authors and runs scripts, flows and apps; read/write on what they created or were granted. |
| Operator | Runs and views only. Cannot create, edit, archive or delete, cannot run previews, cannot deploy. |
| Service account | A workspace identity with no login, acting as Developer or Operator, used through a token. |
| Anonymous app viewer | Reaches one app through a secret URL and nothing else. |

Underneath the roles, permissions hang off **paths**. Everything lives at either
`u/<user>/<name>` or `f/<folder>/<name>`, and a folder grants **admin**, **writer**
or **viewer** to users and to groups. Groups exist so that permissions are granted
to a role in the organisation rather than to a list of people.

Jobs can also run **"permissioned as"** somebody other than the person who triggered
them, which is how a schedule keeps working after its author leaves, and how a
`billing-bot` identity can be given exactly the access one automation needs.

### Tokens

Windmill's API is bearer tokens, created from account settings with a **label** and
an optional **expiry**, shown once and never again, revocable by deletion. The part
worth stealing is that a token can be **scoped down**, in a readable grammar:

```
{domain}:{action}[:{resource_path}]

scripts:read                          every script
scripts:write:f/production/*          write, but only inside one folder
jobs:run:scripts:u/admin/my_script    run exactly one thing
resources:read:u/user/*               read one user's resources
```

Write implies read. Paths take wildcards, and several can be comma-separated. So a
CI job gets a credential that can do the one thing CI does, and a leak of it is a
much smaller event than a leak of a session.

Windmill also does SSO — Google, GitHub, Azure AD, Okta, GitLab and generic OpenID
Connect.

## What applies here, and what does not

**Not applicable: workspaces, folders, paths, groups.** Windmill's whole permission
lattice exists because one instance holds many workspaces and thousands of scripts
that need to be shared in complicated ways. This project is single-tenant by
decision, and its objects are recordings that have exactly one owner. A folder ACL
system here would be machinery with nothing to hold.

**Not applicable, yet: "permissioned as".** Nothing runs on a schedule on behalf of
a user. The worker acts on the system's behalf, not a person's.

**Worth taking, in order:**

### 1. A third role: `viewer`

The gap in two roles is the person who should watch but never record — a manager, a
customer, a contractor. Today they need an account that can also record, or no
account at all. Windmill calls it Operator, and the shape is the same: view what you
have been given, create nothing.

Concretely: `viewer` can open a recording shared with `authenticated` visibility and
nothing else. No `POST /v1/recordings`, no shares, no uploads. That is three route
guards and one enum value, and it is the single change that most increases who can
be given an account.

### 2. API tokens, scoped, with a label and an expiry

The reason to want one here is narrow and real: **uploading from CI or a script**,
and **automating retention or exports**. A session cookie is the wrong credential
for both — it belongs to a browser, and it carries every permission its owner has.

Windmill's grammar is worth copying nearly verbatim, minus the path segment, which
has nothing to address here:

```
recordings:read           list and fetch metadata
recordings:write          create, rename, delete
uploads:write             start and complete an upload
shares:write              create and revoke links
admin:storage             configure backends
```

With the same properties that make Windmill's version safe: a **label** so a person
can tell two tokens apart a year later, an **optional expiry**, shown **once** at
creation and stored as a hash, revocable by deletion, and **never able to exceed the
permissions of the account that made it** — a `user` cannot mint a token with
`admin:storage`, whatever they type.

### 3. Service accounts, but only after tokens

A token belonging to a person dies with that person's account. Windmill's answer is
an identity that never logs in and exists to hold tokens. Worth having eventually;
pointless before there are tokens to hold.

### 4. SSO, last

The right shape is generic OIDC rather than a list of named providers, so that Okta,
Google and Authentik are one code path. It is also the largest of these by a wide
margin and benefits nobody until somebody is running this for a team big enough to
have an identity provider. It should not be started first because it is the most
interesting.

## What not to copy

**Do not add a permission lattice before there is something to permission.** Windmill
has folders and groups because it needs them. Adding ACLs to a system where every
object has one owner produces a settings screen nobody can answer questions about,
and every future feature then has to be expressed in it.

**Do not let tokens become a second, weaker authentication path.** The failure mode
is a token that skips the checks a session goes through — rate limiting, revocation
on role change, the 404-not-403 rule. A token should resolve to the same
`request.user` the cookie does, with a scope set attached, and every existing guard
should keep working unchanged.

## Suggested order

1. `viewer` role — small, and immediately useful.
2. Scoped API tokens — the real gap, and the one with a security story worth writing
   down.
3. Service accounts — once tokens exist.
4. OIDC — when somebody actually has an identity provider.

## Sources

- [Roles and permissions — Windmill](https://www.windmill.dev/docs/core_concepts/roles_and_permissions)
- [User tokens — Windmill](https://www.windmill.dev/docs/core_concepts/user_tokens)
- [Authentication — Windmill](https://www.windmill.dev/docs/core_concepts/authentification/)
- [Role-based access control — Windmill](https://www.windmill.dev/platform/rbac)
