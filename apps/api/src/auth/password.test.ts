import { describe, expect, it, vi } from 'vitest';

/**
 * The minimum is read once, when the module is first loaded, so each case has to
 * import a fresh copy with the environment already set. `resetModules` is what
 * makes the second import actually re-run the file rather than hand back the first.
 */
async function policyWith(min: string | undefined) {
  const previous = process.env.PASSWORD_MIN_LENGTH;
  if (min === undefined) delete process.env.PASSWORD_MIN_LENGTH;
  else process.env.PASSWORD_MIN_LENGTH = min;

  vi.resetModules();
  const module = await import('./password.ts');

  if (previous === undefined) delete process.env.PASSWORD_MIN_LENGTH;
  else process.env.PASSWORD_MIN_LENGTH = previous;
  return module.passwordProblem as (password: string) => string | null;
}

describe('how short a password may be', () => {
  it('asks for ten characters when nothing says otherwise', async () => {
    const problem = await policyWith(undefined);

    expect(problem('short')).toMatch(/at least 10/);
    expect(problem('tenchars10')).toBeNull();
  });

  // An instance that never leaves a laptop is allowed to say so. The point is that
  // lowering it takes a deliberate line of configuration.
  it('accepts a shorter one when the instance has lowered the floor', async () => {
    const problem = await policyWith('6');

    expect(problem('passwd')).toBeNull();
    expect(problem('short')).toMatch(/at least 6/);
  });

  it('still refuses one long enough to be a denial of service', async () => {
    const problem = await policyWith(undefined);

    expect(problem('x'.repeat(201))).toMatch(/at most 200/);
  });
});
