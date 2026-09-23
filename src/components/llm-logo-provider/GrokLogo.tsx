type GrokLogoProps = {
  className?: string;
};

/** Official Grok application icon served by grok.com. */
const GrokLogo = ({ className = 'w-5 h-5' }: GrokLogoProps) => (
  <img
    src="/provider-logos/grok-icon.svg"
    alt="Grok"
    className={className}
  />
);

export default GrokLogo;
