type AntigravityLogoProps = {
  className?: string;
};

/** Official full-color Google Antigravity icon from antigravity.google/press. */
const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => (
  <img
    src="/provider-logos/antigravity-icon-full-color.png"
    alt="Antigravity"
    className={className}
  />
);

export default AntigravityLogo;
