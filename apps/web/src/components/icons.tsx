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
 * It is the same shape as `assets/logo.svg` and the favicon. Inline because the
 * navigation bar is the first thing rendered, and an icon that arrives on its own
 * request arrives after everything around it.
 */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="openloom"
      focusable="false"
    >
      <defs>
        <linearGradient id="openloom-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill="url(#openloom-mark)" />
      {/* The gap is the whole idea: closed, this is the play button every other
          product uses. See assets/logo.svg, which this has to stay identical to. */}
      <path
        d="M25.61 14.65A9.7 9.7 0 1 1 17.35 6.39"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.5"
        strokeWidth="2.9"
        strokeLinecap="round"
      />
      <path d="M13.6 11.5 21.3 16l-7.7 4.5z" fill="#ffffff" />
    </svg>
  );
}
