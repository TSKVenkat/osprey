import bcrypt from 'bcryptjs';

// 12 rounds is the usual recommendation: roughly a quarter of a second to verify,
// which is slow enough to matter to an attacker and fast enough not to matter here.
// Tests lower it, because a suite that signs in fifty times should not spend twelve
// seconds proving that bcrypt is slow.
const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);

// Compared against when no user matches, so a request for an unknown email costs
// the same time as one for a known email. Without this, response timing tells an
// attacker which addresses have accounts.
const DUMMY_HASH = bcrypt.hashSync('osprey-timing-equalizer', ROUNDS);

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH).then((ok) => (hash ? ok : false));
}

/** Deliberately mild: length does more for password strength than character classes. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return null;
}
