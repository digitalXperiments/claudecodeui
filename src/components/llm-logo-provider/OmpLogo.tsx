type OmpLogoProps = {
  className?: string;
};

/**
 * Oh My Pi mark: a filled rounded square carrying an Ω, deliberately distinct
 * from the outlined π circle used for the separate `pi` provider.
 */
const OmpLogo = ({ className = 'w-5 h-5' }: OmpLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Oh My Pi"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2" y="2" width="20" height="20" rx="5.5" fill="currentColor" opacity="0.15" />
    <rect x="2" y="2" width="20" height="20" rx="5.5" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M8.1 17.5h2.6c-1.9-1.1-2.9-2.8-2.9-4.8 0-2.6 1.8-4.5 4.2-4.5s4.2 1.9 4.2 4.5c0 2-1 3.7-2.9 4.8h2.6"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default OmpLogo;
