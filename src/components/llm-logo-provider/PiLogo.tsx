type PiLogoProps = {
  className?: string;
};

/**
 * Pi coding agent mark: a minimal circle with the Greek letter π,
 * matching the product's "minimal harness" aesthetic.
 */
const PiLogo = ({ className = 'w-5 h-5' }: PiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Pi"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.75" />
    <path
      d="M8 8.5h8M10.2 8.5v7.2c0 1.1-.55 1.8-1.55 1.8M13.8 8.5v7.2c0 1.1.55 1.8 1.55 1.8"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default PiLogo;
