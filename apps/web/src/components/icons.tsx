/**
 * The handful of icons the interface uses, drawn inline.
 *
 * An icon font or an icon package would be more to install and more to load than
 * eight shapes are worth. They all share one stroke weight and one 24-unit grid so
 * they sit together; anything added later should do the same.
 */

type IconProps = { size?: number; className?: string };

function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every icon in this interface sits beside its own label, so a
      // screen reader announcing it as well would only repeat the label.
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FilmIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 12h18M3 8.5h4M3 15.5h4M17 8.5h4M17 15.5h4" />
    </Svg>
  );
}

export function RecordIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12M10 11v5M14 11v5" />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.4" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

/**
 * The mark, drawn rather than loaded.
 *
 * It is the same shape as `assets/logo.svg` and the favicon, and has to stay that
 * way. Inline because the navigation bar is the first thing rendered, and an icon
 * that arrives on its own request arrives after everything around it.
 */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="bilby"
      focusable="false"
    >
      <defs>
        <linearGradient id="bilby-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8bf5" />
          <stop offset="1" stopColor="#2250c8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill="url(#bilby-mark)" />
      {/* Mostly ears, because that is the part of the animal that still reads at
          sixteen pixels in a browser tab. */}
      <g fill="#ffffff">
        <ellipse cx="11.1" cy="10.4" rx="3.05" ry="5.5" transform="rotate(-13 11.1 10.4)" />
        <ellipse cx="20.9" cy="10.4" rx="3.05" ry="5.5" transform="rotate(13 20.9 10.4)" />
        <circle cx="16" cy="20.2" r="7.4" />
      </g>
      {/* Cut out of the head rather than drawn on it, so the mark stays two shapes
          and one colour at every size. */}
      <path d="M13.7 16.6 20.4 20.2l-6.7 3.6z" fill="#2250c8" />
    </svg>
  );
}
