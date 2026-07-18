type GrokLogoProps = {
  className?: string;
};

const GrokLogo = ({ className = 'w-5 h-5' }: GrokLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Grok"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M4 4L20 20M20 4L4 20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

export default GrokLogo;
