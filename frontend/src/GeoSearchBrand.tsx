import { useId } from 'react'
/** H³ GeoSearch with the Azimuth Platform lockup. */
export function GeoSearchBrand() {
  const id = useId()
  return <svg viewBox="0 0 526 64" className="geosearch-brand" role="img" aria-label="H³ GeoSearch · Azimuth Platform"><defs>
      <linearGradient id={id + "-metal"} x1="0" y1="0" x2="0.28" y2="1">
        <stop offset="0" stopColor="var(--brand-metal-top, #575650)"/>
        <stop offset=".5" stopColor="var(--brand-metal-mid, #272723)"/>
        <stop offset="1" stopColor="var(--brand-metal-bottom, #10100f)"/>
      </linearGradient>
      <linearGradient id={id + "-bevel"} x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="var(--brand-accent, #e89d45)" stopOpacity=".65"/>
        <stop offset=".65" stopColor="var(--brand-accent, #e89d45)"/>
        <stop offset="1" stopColor="#ffdfa1"/>
      </linearGradient>
      <filter id={id + "-shadow"} x="-20%" y="-30%" width="150%" height="170%" colorInterpolationFilters="sRGB">
        <feDropShadow dx="0" dy="1.3" stdDeviation="1" floodColor="var(--brand-shade, #000000)" floodOpacity=".24"/>
      </filter>
      <clipPath id={id + "-a-clip"}><path fillRule="evenodd" clipRule="evenodd" d="M0 48 53.05263157894737 0 41.609907120743 48H31.2074303405573L33.2879256965944 36H19.7647058823529L8.32198142414861 48Z M26.0061919504644 29H35.3684210526316L38.4891640866873 16Z"/></clipPath>
      <symbol id={id + "-hex"} viewBox="0 0 48 48">
        <path d="M24 1 45 12.5v23L24 47 3 35V12.5Z" fill="#171716"/>
        <path d="M24 1 45 12.5 3 35V12.5Z" fill="var(--brand-accent, #e89d45)"/>
        <path d="M45 12.5v23L24 47l-10.5-6Z" fill="#faf7ef"/>
      </symbol>
      <symbol id={id + "-a"} viewBox="-3 -3 61 56">
        <path className="brand-a-body" d="M0 48 53.05263157894737 0 41.609907120743 48H31.2074303405573L33.2879256965944 36H19.7647058823529L8.32198142414861 48Z M26.0061919504644 29H35.3684210526316L38.4891640866873 16Z" fill={`url(#${id}-metal)`} fillRule="evenodd" filter={`url(#${id}-shadow)`}/>
        <g className="brand-effect" clipPath={`url(#${id}-a-clip)`}>
          <path d="M0 48 53.05263157894737 0 50.4 7.1 4.8 48.4Z" fill={`url(#${id}-bevel)`}/>
          <path d="M53.05263157894737 0 41.609907120743 48H38.7L49.6 3.12Z" fill="var(--brand-highlight, #ffffff)" opacity=".13"/>
          <path d="M19.7647058823529 36H33.2879256965944L32.6 39H17.4Z" fill="var(--brand-highlight, #ffffff)" opacity=".18"/>
          <path d="M0 48 53.05263157894737 0" fill="none" stroke="#ffdf9f" strokeWidth=".65"/>
        </g>
      </symbol>
</defs>
        <use href={`#${id}-hex`} x="4" y="8" width="48" height="48"/>
        <text className="brand-title-effect" filter={`url(#${id}-shadow)`} x="64" y="43" fontFamily="Inter, Segoe UI, Arial, sans-serif" fontSize="34" fontWeight="650" letterSpacing="-1.4" fill="currentColor">H<tspan dy="-12" fontSize="18" letterSpacing="-.8">3</tspan><tspan dx="6" dy="12" letterSpacing="-1.4">GeoSearch</tspan></text>
        <use href={`#${id}-a`} x="289" y="16" width="32.68" height="30"/>
        <g transform="translate(297 24) scale(.475)" fill="currentColor" aria-label="ZIMUTH">
          <path d="M50 0h32.5v8L63.3 31H82.5v9H50v-8l19-23H50Z"/>
          <path d="M87 0h10v40H87Z"/>
          <path d="M102.5 0h9.3l12.5 17L137 0h9.2v40h-10V19l-11.9 15.7L112.5 19v21h-10Z"/>
          <path d="M152.5 0h10v24.5c0 4.8 1.7 6.4 6.2 6.4h2.5c4.4 0 6-1.6 6-6.4V0h10v25.6c0 9.7-4.6 14.4-13.6 14.4h-7.5c-9 0-13.6-4.7-13.6-14.4Z"/>
          <path d="M191.5 0h30.7v9h-10.3v31h-10V9h-10.4Z"/>
          <path d="M226.5 0h10v15h13.5V0h10v40h-10V24h-13.5v16h-10Z"/>
        </g>
        <text x="434" y="43" fontFamily="Inter, Segoe UI, Arial, sans-serif" fontSize="21" fontWeight="400" letterSpacing=".5" fill="var(--brand-soft, currentColor)">Platform</text>
</svg>
}
