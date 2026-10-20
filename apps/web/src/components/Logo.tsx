// The B² mark: a cut wordmark, a heavy geometric B drawn as paths (no font to wait for), sliced on the
// diagonal with its lower half slipped along the cut, a spot-blue hairline in the cut, and the ² set in
// a block. The spinning cube from the film appears once per screen: on Connect and in the wallet box.

export function Cube({ size = 36, big }: { size?: number; big?: boolean }) {
  return <img src={big ? '/b2-cube.gif' : '/b2-cube-160.gif'} width={size} height={size} alt="" className="cube" />;
}

// One B, counters cut out (even-odd): stem and upper bowl, stem and wider lower bowl.
const B =
  'M2 2H26C33.5 2 37 6 37 11.5C37 15.6 35 18.4 31.6 19.7C36.4 20.8 39.5 24.4 39.5 29.6C39.5 36.4 35 40 27 40H2Z' +
  'M12 9.6V16.4H24.2C26.4 16.4 27.4 15.2 27.4 13S26.4 9.6 24.2 9.6Z' +
  'M12 23.4V32.4H25.4C28 32.4 29.4 31 29.4 27.9S28 23.4 25.4 23.4Z';

export function Wordmark({ height = 30 }: { height?: number }) {
  const w = (height * 70) / 42;
  return (
    <svg width={w} height={height} viewBox="0 0 70 42" className="wordmark" aria-label="B²">
      <defs>
        <clipPath id="b2-top">
          <polygon points="0,0 70,0 70,13 0,26" />
        </clipPath>
        <clipPath id="b2-bot">
          <polygon points="0,28 70,15 70,42 0,42" />
        </clipPath>
      </defs>
      <path d={B} fill="currentColor" fillRule="evenodd" clipPath="url(#b2-top)" />
      <path d={B} fill="currentColor" fillRule="evenodd" clipPath="url(#b2-bot)" transform="translate(2.4 0)" />
      <line x1="0" y1="27" x2="44" y2="18.8" stroke="var(--spot)" strokeWidth="1.3" />
      <rect x="46" y="1" width="20" height="20" rx="2" fill="currentColor" />
      <text x="56" y="16.6" textAnchor="middle" fill="var(--paper)" style={{ fontFamily: '"Arial Black", Arial, sans-serif', fontWeight: 900, fontSize: 15 }}>
        2
      </text>
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <Wordmark height={28} />
    </span>
  );
}
