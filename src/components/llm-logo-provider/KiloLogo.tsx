type KiloLogoProps = {
  className?: string;
};

/** Kilo Code mark, kept inline so provider logos work offline and in Electron. */
const KiloLogo = ({ className = 'w-5 h-5' }: KiloLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Kilo Code"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M5 4v16M19 4 8.5 12 19 20"
      className="stroke-orange-500"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default KiloLogo;
