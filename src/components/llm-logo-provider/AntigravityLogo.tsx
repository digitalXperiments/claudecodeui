type AntigravityLogoProps = {
  className?: string;
};

/**
 * Official Google Antigravity / Gemini emblem.
 * Features the signature 4-point radiant diamond star with Google's vibrant gradient
 * (Sky Blue #1BA1E3 -> Electric Indigo #5B52FF -> Rose Coral #D96570) and radiant core highlight.
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
    <defs>
      <linearGradient
        id="antigravity-brand-grad"
        x1="2.5"
        y1="2.5"
        x2="21.5"
        y2="21.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0%" stopColor="#1BA1E3" />
        <stop offset="48%" stopColor="#5B52FF" />
        <stop offset="100%" stopColor="#D96570" />
      </linearGradient>
      <radialGradient
        id="antigravity-core-glow"
        cx="12"
        cy="12"
        r="5"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.45" />
        <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
      </radialGradient>
    </defs>
    {/* Main 4-pointed Gemini / Antigravity star */}
    <path
      d="M12 1.5C12 7.299 7.299 12 1.5 12C7.299 12 12 16.701 12 22.5C12 16.701 16.701 12 22.5 12C16.701 12 12 7.299 12 1.5Z"
      fill="url(#antigravity-brand-grad)"
    />
    {/* Radiant core for depth */}
    <circle cx="12" cy="12" r="4.5" fill="url(#antigravity-core-glow)" />
    {/* Center pinpoint sparkle */}
    <circle cx="12" cy="12" r="1.2" fill="#FFFFFF" opacity="0.9" />
  </svg>
);

export default AntigravityLogo;
