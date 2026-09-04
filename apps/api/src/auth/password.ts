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

/**
 * The shortest password this instance will accept.
 *
 * Ten by default, and length does more for password strength than character
 * classes do, so that is the only rule.
 *
 * Configurable because the people running this are the people who own it, and on a
 * laptop instance that never leaves localhost a ten-character password is friction
 * with nothing on the other side of it. The default is the number that matters —
 * anyone who lowers it has said so out loud in their own configuration, which is
 * different from the software quietly not caring.
 */
const MIN_LENGTH = Math.max(1, Number(process.env.PASSWORD_MIN_LENGTH ?? 10));

/** Deliberately mild: length does more for password strength than character classes. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return null;
}
