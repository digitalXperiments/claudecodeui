import { useId } from 'react';

type AgyLogoProps = {
  className?: string;
};

// Google Antigravity's brand mark: a smooth arched "A" with the signature
// blue → green → orange → red → blue gradient sweeping across it (warm at the
// apex, blue at both feet). Rendered as a stroked arch so it scales cleanly and
// keeps the gradient regardless of the surrounding text color.
const AgyLogo = ({ className = 'w-5 h-5' }: AgyLogoProps) => {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Antigravity"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="4" y1="12" x2="20" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4F86F7" />
          <stop offset="30%" stopColor="#34A853" />
          <stop offset="50%" stopColor="#F9A825" />
          <stop offset="63%" stopColor="#EA4335" />
          <stop offset="100%" stopColor="#4F86F7" />
        </linearGradient>
      </defs>
      <path
        d="M5.5 19C5.5 13.5 8 7.5 12 5.5C16 7.5 18.5 13.5 18.5 19"
        stroke={`url(#${gradientId})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default AgyLogo;
