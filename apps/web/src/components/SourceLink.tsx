/**
 * Where to get the source of the instance you are looking at.
 *
 * Not decoration and not a credit: this software is under the AGPL, and section 13
 * says that people who interact with it over a network have to be offered its
 * source. A link in the interface is the way the licence itself suggests doing
 * that, so it appears on the two pages someone without an account can reach as
 * well as the ones behind sign-in.
 *
 * Anyone running a modified copy should point SOURCE_URL at their fork. Running a
 * modified version as a network service and linking back to the original is
 * exactly the arrangement the licence exists to prevent.
 */
const SOURCE_URL = 'https://github.com/TSKVenkat/bilby';

export function SourceLink({ className = 'source-link' }: { className?: string }) {
  return (
    <a className={className} href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
      Source
    </a>
  );
}
