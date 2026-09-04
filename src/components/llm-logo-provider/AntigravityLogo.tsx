type AntigravityLogoProps = {
  className?: string;
};

/**
 * Antigravity mark: an upward arrow escaping a ring — "anti gravity" — kept
 * geometrically distinct from every other provider mark in this folder so the
 * session list stays scannable at 16px.
 */
const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Antigravity"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
    <path
      d="M12 17.5V7.2"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <path
      d="M8.2 10.6 12 6.6l3.8 4"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default AntigravityLogo;
