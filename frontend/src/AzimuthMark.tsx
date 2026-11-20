import { useId } from 'react'

export function AzimuthMark({ size = 38 }: { size?: number }) {
  return <svg viewBox="0 0 48 48" width={size} height={size} className="azimuth-mark" aria-hidden="true">
    <path className="azimuth-mark-wedge" d="M24 1 45 12.5v23L24 47 3 35V12.5Z" fill="var(--azimuth-mark-wedge, #171716)"/>
    <path className="azimuth-mark-gold" d="M24 1 45 12.5 3 35V12.5Z" fill="#e89d45"/>
    <path className="azimuth-mark-ivory" d="M45 12.5v23L24 47l-10.5-6Z" fill="#faf7ef"/>
    <path className="azimuth-mark-outline" d="M45 12.5v23L24 47l-10.5-6" fill="none" stroke="var(--azimuth-mark-edge, transparent)" strokeWidth="1" strokeLinejoin="round"/>
  </svg>
}

export function AzimuthLoadingMark({ size = 16 }: { size?: number }) {
  const clipId = useId()
  return <svg viewBox="0 0 48 48" width={size} height={size} className="azimuth-loading-mark" aria-hidden="true">
    <defs><clipPath id={clipId}><path d="M24 1 45 12.5v23L24 47 3 35V12.5Z"/></clipPath></defs>
    <g clipPath={`url("#${clipId}")`}>
      <path d="M0 0h48v48H0Z" fill="#e89d45"/>
      <path d="M45 12.5v23L24 47 3 35Z" fill="#faf7ef"/>
      <path className="azimuth-loading-wedge" d="M45 12.5 3 35l10.5 6Z" fill="#171716"/>
    </g>
  </svg>
}

export function AzimuthWordmark() {
  return <svg viewBox="0 0 260 40" width="130" height="20" className="azimuth-wordmark" fill="currentColor" aria-hidden="true">
    <path d="M18 0h12l18 40H36.8l-3.1-7.2H14.4L11.2 40H0Zm.8 22.8h10.4L24 11.5Z" fillRule="evenodd"/>
    <path d="M50 0h32.5v8L63.3 31H82.5v9H50v-8l19-23H50Z"/>
    <path d="M87 0h10v40H87Z"/>
    <path d="M102.5 0h9.3l12.5 17L137 0h9.2v40h-10V19l-11.9 15.7L112.5 19v21h-10Z"/>
    <path d="M152.5 0h10v24.5c0 4.8 1.7 6.4 6.2 6.4h2.5c4.4 0 6-1.6 6-6.4V0h10v25.6c0 9.7-4.6 14.4-13.6 14.4h-7.5c-9 0-13.6-4.7-13.6-14.4Z"/>
    <path d="M191.5 0h30.7v9h-10.3v31h-10V9h-10.4Z"/>
    <path d="M226.5 0h10v15h13.5V0h10v40h-10V24h-13.5v16h-10Z"/>
  </svg>
}
