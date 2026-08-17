type ClineLogoProps = { className?: string };

export default function ClineLogo({ className = 'h-5 w-5' }: ClineLogoProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z" fill="currentColor" opacity=".2" />
      <path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z" stroke="currentColor" strokeWidth="1.7" />
      <path d="m8.5 12 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
