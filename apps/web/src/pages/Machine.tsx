import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePoll, type MachineData, type Trade } from '../api';
import { age, compact, short, sol } from '../format';
import { SwapCard, type Swapped } from '../components/SwapCard';
import { TokenIcon } from '../components/TokenIcon';
import { Cube } from '../components/Logo';

// The machine view, live, for any token: its latest trades on the chart, and every trade's money
// running to where the coin's rules send it (the hook, the creator fee, holders, the burn, its
// companion). B² coins get their own drawing: the pot, its floor and the held coin. Trade from the
// card beside it and your trade runs through the machine as soon as it confirms.
//
// Drawn 2.5D: the cards are slabs with depth and a shadow, the wires are pipes, the pot and the held
// coin are glass tanks, and the chart's line is a raised ribbon. Two layouts: wide (the chart left,
// the machine right) and, under 720 px, tall (the chart on top, the machine under it), so the text
// stays readable on a phone.

type Pt = [number, number];
type Box = { x: number; y: number; w: number; h: number };
type Kind = 'sol' | 'coin' | 'probe' | 'burn';
type Particle = { id: string; route: Pt[]; start: number; dur: number; kind: Kind; r: number };
type Ev = { key: string; at: number; kind: 'trade' | 'step'; trade?: Trade; you?: boolean };
type Taker = { id: string; title: string; lines: string[]; buyBps: number; sellBps: number; kind: Kind };
type Split = { buybackBps: number; holdersBps: number; beneficiaryBps: number; potBps: number };

/** Every position the drawing uses, for one layout. `k` scales the type: the tall layout is shown smaller, so its text is drawn larger. */
type Layout = {
  tall: boolean;
  k: number;
  W: number;
  H: number;
  CH: { x0: number; x1: number; y0: number; y1: number };
  RIGHT: { x0: number; x1: number };
  /** the wire the trades ride to the takers, and the one the companion's trades ride back to the chart */
  BUS: number;
  LOW_BUS: number;
  SIDE_X: number;
  TAKER_Y: number;
  TAKER_H: number;
  COMP: Box;
  POOL: Box;
  BOND_Y: number;
  LEGEND_Y: number;
  LEGEND_COLS: number;
  STAT_COLS: number;
  /** the companion's content sits this much lower in the tall layout, under a two-line heading */
  COMP_HEAD: number;
};

const SUPPLY = 1e9;
const DEPTH = 7;

function layoutFor(tall: boolean, legendItems: number): Layout {
  if (!tall) {
    const COMP: Box = { x: 940, y: 262, w: 630, h: 310 };
    return {
      tall,
      k: 1,
      W: 1600,
      H: 860,
      CH: { x0: 84, x1: 860, y0: 132, y1: 590 },
      RIGHT: { x0: 940, x1: 1570 },
      BUS: 58,
      LOW_BUS: 646,
      SIDE_X: 906,
      TAKER_Y: 100,
      TAKER_H: 118,
      COMP,
      POOL: { x: 940, y: 622, w: 630, h: 104 },
      BOND_Y: 700,
      LEGEND_Y: 806,
      LEGEND_COLS: 7,
      STAT_COLS: 3,
      COMP_HEAD: 0,
    };
  }
  // under the legend (three to a row), the bus, the takers, the companion and the pool
  const k = 1.24;
  const LEGEND_Y = 626;
  const BUS = LEGEND_Y + (Math.ceil(legendItems / 3) - 1) * 34 * k + 40;
  const TAKER_Y = BUS + 26;
  const COMP: Box = { x: 20, y: TAKER_Y + 122 + 32, w: 520, h: 440 };
  const POOL: Box = { x: 20, y: COMP.y + COMP.h + 56, w: 520, h: 116 };
  return {
    tall,
    k,
    W: 560,
    H: POOL.y + POOL.h + 36,
    CH: { x0: 76, x1: 540, y0: 128, y1: 470 },
    RIGHT: { x0: 20, x1: 540 },
    BUS,
    LOW_BUS: 520,
    SIDE_X: 8,
    TAKER_Y,
    TAKER_H: 122,
    COMP,
    POOL,
    BOND_Y: 568,
    LEGEND_Y,
    LEGEND_COLS: 3,
    STAT_COLS: 2,
    COMP_HEAD: 30,
  };
}

const along = (pts: Pt[], s: number): Pt => {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let d = Math.min(1, Math.max(0, s)) * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) {
      const r = lens[i] ? d / lens[i] : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
    }
    d -= lens[i];
  }
  return pts[pts.length - 1];
};
const ease = (s: number) => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);
const poly = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
const solR = (v: number) => Math.min(11, 2.5 + 8.5 * Math.sqrt(Math.max(0, v) / 0.3));
const tri = (x: number, y: number, s: number, up: boolean) =>
  up ? `M${x},${y - s * 0.62}L${x + s * 0.58},${y + s * 0.38}L${x - s * 0.58},${y + s * 0.38}Z` : `M${x},${y + s * 0.62}L${x + s * 0.58},${y - s * 0.38}L${x - s * 0.58},${y - s * 0.38}Z`;
const pctOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/** A type size that keeps `text` inside `max` units: the font's average glyph is about 0.6 em (mono) or 0.58 em (display). */
const fit = (text: string, max: number, size: number, mono = false) => Math.min(size, max / Math.max(1, text.length * (mono ? 0.6 : 0.58)));

// ---- Drawing pieces -------------------------------------------------------------------------------

/** A card as a slab: its thickness under it, a lit top face, a sheen and a shadow. */
function Slab({ b, rx = 12, hit, base }: { b: Box; rx?: number; hit?: boolean; base?: boolean }) {
  return (
    <g>
      <rect x={b.x + 2} y={b.y + DEPTH} width={b.w} height={b.h} rx={rx} fill="#07080a" filter="url(#shadow)" />
      <rect x={b.x + 1} y={b.y + DEPTH * 0.5} width={b.w} height={b.h} rx={rx} fill="url(#edge)" />
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={rx} fill={base ? 'url(#slabBase)' : 'url(#slab)'} stroke={hit ? 'var(--spot)' : 'var(--line-2)'} strokeWidth={hit ? 2 : 1} style={{ transition: 'stroke 0.3s' }} />
      <rect x={b.x + 1} y={b.y + 1} width={b.w - 2} height={Math.min(46, b.h * 0.4)} rx={rx - 1} fill="url(#sheen)" />
      {hit ? <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={rx} fill="none" stroke="var(--spot)" strokeWidth={6} opacity={0.18} /> : null}
    </g>
  );
}

function Panel({ b, title, lines, hit, accent, k }: { b: Box; title: string; lines: string[]; hit?: boolean; accent?: boolean; k: number }) {
  const room = b.w - 32;
  return (
    <g>
      <Slab b={b} rx={10} hit={hit} />
      {accent ? <rect x={b.x} y={b.y + 16} width={3.5} height={26} rx={1.75} fill="var(--spot)" /> : null}
      <text x={b.x + 16} y={b.y + 36 * Math.min(k, 1.1)} className="t-display" fontSize={fit(title, room, 24 * k)} fill="var(--ink)">
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={i} x={b.x + 16} y={b.y + (62 + i * 22) * Math.min(k, 1.1) + (k > 1 ? 4 : 0)} className="t-mono" fontSize={fit(l, room, 15 * k, true)} fill="var(--ink-2)" opacity={0.82}>
          {l}
        </text>
      ))}
    </g>
  );
}

/** A glass tank: a cylinder, its liquid with a lit surface, the floor line, and its figures on the glass. */
function Tank({ b, id, title, value, sub, level, floor, hatch, k }: { b: Box; id: string; title: string; value: string; sub: string; level: number; floor?: number; hatch?: boolean; k: number }) {
  const ry = Math.min(12, b.w * 0.06);
  const head = 104 * Math.min(k, 1.1);
  const bottom = b.y + b.h - ry;
  const fy = (v: number) => bottom - (bottom - (b.y + head)) * Math.min(1, Math.max(0, v));
  const cx = b.x + b.w / 2;
  const ly = fy(level);
  return (
    <g>
      <ellipse cx={cx + 3} cy={b.y + b.h + 4} rx={b.w / 2 + 4} ry={ry + 4} fill="#000" opacity={0.45} filter="url(#shadow)" />
      <clipPath id={`clip-${id}`}>
        <rect x={b.x} y={b.y + ry} width={b.w} height={b.h - 2 * ry} />
        <ellipse cx={cx} cy={bottom} rx={b.w / 2} ry={ry} />
      </clipPath>
      {/* the glass */}
      <rect x={b.x} y={b.y + ry} width={b.w} height={b.h - 2 * ry} fill="url(#glass)" />
      <ellipse cx={cx} cy={bottom} rx={b.w / 2} ry={ry} fill="url(#glass)" />
      {/* the liquid, and its surface */}
      <g clipPath={`url(#clip-${id})`}>
        <rect x={b.x} y={ly} width={b.w} height={b.y + b.h - ly} fill={hatch ? 'url(#hatch)' : 'url(#liquid)'} style={{ transition: 'all 0.9s ease' }} />
      </g>
      <ellipse cx={cx} cy={ly} rx={b.w / 2} ry={ry} fill={hatch ? 'rgba(170,182,255,0.22)' : 'rgba(238,240,242,0.16)'} stroke={hatch ? 'rgba(170,182,255,0.6)' : 'rgba(238,240,242,0.45)'} strokeWidth={1.2} style={{ transition: 'all 0.9s ease' }} />
      {floor !== undefined && floor > 0.05 ? (
        <g>
          <ellipse cx={cx} cy={fy(floor)} rx={b.w / 2} ry={ry} fill="none" stroke="var(--spot)" strokeWidth={1.4} strokeDasharray="5 4" />
          <text x={b.x + b.w - 12} y={fy(floor) + ry + 16 * k} textAnchor="end" className="t-mono" fontSize={14 * k} fill="#aab6ff">
            FLOOR ½
          </text>
        </g>
      ) : null}
      {/* the rim and the glass's highlights */}
      <ellipse cx={cx} cy={b.y + ry} rx={b.w / 2} ry={ry} fill="rgba(11,12,14,0.85)" stroke="rgba(238,240,242,0.28)" strokeWidth={1.2} />
      <rect x={b.x} y={b.y + ry} width={b.w} height={b.h - 2 * ry} fill="none" stroke="rgba(238,240,242,0.14)" />
      <rect x={b.x + b.w * 0.1} y={b.y + ry * 2} width={b.w * 0.05} height={b.h - ry * 4} rx={b.w * 0.025} fill="rgba(255,255,255,0.07)" />
      <text x={b.x + 14} y={b.y + ry + 30 * Math.min(k, 1.1)} className="t-mono" fontSize={14 * k} fill="var(--muted)" letterSpacing="0.08em">
        {title}
      </text>
      <text x={b.x + 14} y={b.y + ry + 66 * Math.min(k, 1.1)} className="t-display" fontSize={fit(value, b.w - 28, 32 * k)} fill="var(--ink)">
        {value}
      </text>
      <text x={b.x + 14} y={b.y + ry + 90 * Math.min(k, 1.1)} className="t-mono" fontSize={fit(sub, b.w - 28, 14.5 * k, true)} fill="var(--ink-2)" opacity={0.8}>
        {sub}
      </text>
    </g>
  );
}

function Dot({ p, kind, r, o = 1 }: { p: Pt; kind: Kind; r: number; o?: number }) {
  if (kind === 'sol') return <circle cx={p[0]} cy={p[1]} r={r} fill="url(#pearl)" filter="url(#glow)" opacity={o} />;
  if (kind === 'burn') return <circle cx={p[0]} cy={p[1]} r={r} fill="#ff8a5c" filter="url(#glow)" opacity={o} />;
  if (kind === 'probe') return <circle cx={p[0]} cy={p[1]} r={r} fill="var(--card)" stroke="var(--ink)" strokeWidth={1.5} opacity={o} />;
  return <rect x={p[0] - r} y={p[1] - r} width={r * 2} height={r * 2} rx={2} fill="var(--card)" stroke="#aab6ff" strokeWidth={1.6} opacity={o} />;
}

function companionSplitLine(s: Split) {
  const parts = [s.potBps ? `pot ${pctOf(s.potBps)}` : '', s.buybackBps ? `buyback ${pctOf(s.buybackBps)}` : '', s.holdersBps ? `holders ${pctOf(s.holdersBps)}` : '', s.beneficiaryBps ? `dev ${pctOf(s.beneficiaryBps)}` : ''];
  return parts.filter(Boolean).join(' · ') || 'its split';
}

/** The companion's split as raised bars, each labelled under it; a label that would run past the card turns to end at its edge, and one that would collide drops a line. */
function SplitBars({ s, b, top, k }: { s: Split; b: Box; top: number; k: number }) {
  const parts = (
    [
      ['POT', s.potBps, 'url(#hatch)'],
      ['BUYBACK', s.buybackBps, 'url(#barInk)'],
      ['HOLDERS', s.holdersBps, 'url(#barUp)'],
      ['LAUNCHER', s.beneficiaryBps, 'url(#barSoft)'],
    ] as [string, number, string][]
  ).filter(([, bps]) => bps > 0);
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1;
  const x0 = b.x + 30;
  const right = b.x + b.w - 30;
  const w = right - x0;
  const fs = 14 * k;
  const barY = top + 14 * k;
  const labelY = barY + 30 + 24 * Math.min(k, 1.1);
  let x = x0;
  let lastEnd = -Infinity;
  const labels: { text: string; x: number; anchor: 'start' | 'end'; row: number }[] = [];
  const bars = parts.map(([name, bps, fill]) => {
    const bw = (w * bps) / total;
    const text = `${name} ${pctOf(bps)}`;
    const tw = text.length * fs * 0.6;
    let lx = x;
    let anchor: 'start' | 'end' = 'start';
    if (lx + tw > right) {
      anchor = 'end';
      lx = right;
    }
    const start = anchor === 'end' ? lx - tw : lx;
    const row = start < lastEnd + 12 ? 1 : 0;
    if (row === 0) lastEnd = start + tw;
    labels.push({ text, x: lx, anchor, row });
    const bar = (
      <g key={name}>
        <rect x={x} y={barY + 4} width={Math.max(2, bw - 3)} height={30} rx={6} fill="#07080a" />
        <rect x={x} y={barY} width={Math.max(2, bw - 3)} height={30} rx={6} fill={fill} stroke="rgba(238,240,242,0.12)" />
        <rect x={x + 1} y={barY + 1} width={Math.max(1, bw - 5)} height={10} rx={5} fill="rgba(255,255,255,0.06)" />
      </g>
    );
    x += bw;
    return bar;
  });
  return (
    <g>
      <text x={x0} y={top} className="t-mono" fontSize={fit('WHERE ITS PART OF THE CREATOR FEE GOES', w, fs, true)} fill="var(--muted)" letterSpacing="0.06em">
        WHERE ITS PART OF THE CREATOR FEE GOES
      </text>
      {bars}
      {labels.map((l) => (
        <text key={l.text} x={l.x} y={labelY + l.row * (fs + 6)} textAnchor={l.anchor} className="t-mono" fontSize={fs} fill="var(--ink-2)">
          {l.text}
        </text>
      ))}
    </g>
  );
}

/** A label on a dark pill, so a line's name reads over the chart's marks. */
function Tag({ x, y, text, anchor = 'start', color, fs }: { x: number; y: number; text: string; anchor?: 'start' | 'end'; color: string; fs: number }) {
  const tw = text.length * fs * 0.6 + 14;
  const left = anchor === 'end' ? x - tw : x;
  return (
    <g>
      <rect x={left} y={y - fs - 2} width={tw} height={fs + 10} rx={(fs + 10) / 2} fill="rgba(13,14,17,0.88)" stroke={color} strokeOpacity={0.45} />
      <text x={left + 7} y={y + 1} className="t-mono" fontSize={fs} fill={color}>
        {text}
      </text>
    </g>
  );
}

// ---- The page -------------------------------------------------------------------------------------

export function MachinePage() {
  const { mint } = useParams();
  const { data, error, refresh } = usePoll<MachineData>(mint ? `/api/machine/${mint}` : null, 5_000);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [now, setNow] = useState(performance.now());
  const [mine, setMine] = useState<Ev[]>([]);
  const seen = useRef<Set<string> | null>(null);
  // the layout follows the drawing's own width: tall under 720 px
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTall(e.contentRect.width < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data ? 1 : 0]);
  useEffect(() => {
    seen.current = null;
    setMine([]);
    setParticles([]);
  }, [mint]);

  const legendItems = data?.b2?.machine ? 7 : 6;
  const L = useMemo(() => layoutFor(tall, legendItems), [tall, legendItems]);
  const { CH, RIGHT, k } = L;

  const t = data?.token;
  const lm = data?.launch;
  const b2 = data?.b2?.machine ?? null;
  const steps = data?.b2?.steps ?? [];
  const companionAddr = b2?.companion.address ?? lm?.companion?.address ?? null;
  const isCompanion = (x: Trade) => !!companionAddr && (x.trader === companionAddr || x.recipient === companionAddr);

  // The last 40 trades (and B²'s waits), oldest first; your own trades join as soon as they confirm.
  const events = useMemo<Ev[]>(() => {
    if (!data) return [];
    const sigs = new Set(data.trades.map((x) => x.signature));
    const es: Ev[] = [
      ...data.trades.map((x) => ({ key: x.signature, at: x.ts, kind: 'trade' as const, trade: x, you: mine.some((m) => m.key === x.signature) })),
      ...steps.filter((s) => s.action !== 'hold').map((s) => ({ key: s.signature + ':s', at: s.at, kind: 'step' as const })),
      ...mine.filter((m) => !sigs.has(m.key)),
    ];
    return es.sort((a, b) => a.at - b.at).slice(-40);
  }, [data, mine]);

  // Who takes what from a trade, by this coin's rules.
  const takers = useMemo<Taker[]>(() => {
    const r = data?.rules;
    if (!r || !lm) return [];
    const out: Taker[] = [];
    if (r.customHook) {
      const rules = r.customHook.workshop?.reading?.rules ?? [];
      const buy = rules.filter((x) => x.on === 'buy' && x.to !== 'none').reduce((a, x) => Math.max(a, x.bps), 0);
      const sell = rules.filter((x) => x.on === 'sell' && x.to !== 'none').reduce((a, x) => Math.max(a, x.bps), 0);
      out.push({
        id: 'hook',
        title: b2 ? 'B² HOOK' : r.customHook.workshop?.name ? `HOOK · ${r.customHook.workshop.name}` : 'CUSTOM HOOK',
        lines: b2
          ? ['1% SOL cut', `dip: buy 0% · sell 3%`]
          : [buy || sell ? `buy ${pctOf(buy)} · sell ${pctOf(sell)}` : 'rules in its hook', short(r.customHook.program)],
        buyBps: b2 ? 100 : buy,
        sellBps: b2 ? 100 : sell,
        kind: 'sol',
      });
    }
    out.push({
      id: 'creator',
      title: `CREATOR FEE ${pctOf(r.creatorFeeBps)}`,
      lines: [lm.companion ? 'to the companion' : `to ${short(lm.launch.creator)}`, lm.companion ? companionSplitLine(lm.companion.split) : 'its creator claims'],
      buyBps: r.creatorFeeBps,
      sellBps: r.creatorFeeBps,
      kind: 'sol',
    });
    const kit = r.rules;
    if (kit && (kit.holderFeeBuyBps || kit.holderFeeSellBps || kit.burnBuyBps || kit.burnSellBps)) {
      const burns = !!(kit.burnBuyBps || kit.burnSellBps);
      const holders = !!(kit.holderFeeBuyBps || kit.holderFeeSellBps);
      out.push({
        id: 'kit',
        title: burns ? (holders ? 'HOLDERS · BURN' : 'BURN') : 'HOLDERS',
        lines: [
          holders ? `holders ${pctOf(Math.max(kit.holderFeeBuyBps, kit.holderFeeSellBps))} · ${compact(r.rewardsDistributedSol)} SOL` : '',
          burns ? `burn ${pctOf(Math.max(kit.burnBuyBps, kit.burnSellBps))} · ${compact(r.burnedTokens)} gone` : '',
        ].filter(Boolean),
        buyBps: kit.holderFeeBuyBps + kit.burnBuyBps,
        sellBps: kit.holderFeeSellBps + kit.burnSellBps,
        kind: burns ? 'burn' : 'sol',
      });
    }
    return out;
  }, [data?.rules, lm, b2]);

  // Geometry: the chart's scale, and the machine's boxes.
  const prices = events.filter((e) => e.trade).map((e) => e.trade!.priceQuote * SUPPLY);
  const nowPrice = (b2?.pool.priceSol ?? lm?.pool.priceSol ?? t?.priceSol ?? 0) * SUPPLY;
  const refs = b2 ? [b2.hook?.referenceSol, b2.hook?.dipLineSol, b2.script?.guardSol].filter((v): v is number => !!v).map((v) => v * SUPPLY) : [];
  const all = [...prices, ...refs, nowPrice].filter((v) => v > 0);
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const pad = Math.max(hi * 0.02, (hi - lo) * 0.14);
  const yLo = lo - pad;
  const yHi = hi + pad;
  const inner = CH.x1 - CH.x0 - 70;
  const x = (i: number) => CH.x0 + 20 + ((i + 0.5) / Math.max(events.length, 1)) * inner;
  const y = (mc: number) => CH.y1 - ((mc - yLo) / (yHi - yLo || 1)) * (CH.y1 - CH.y0);
  const pointOf = (i: number): Pt => {
    for (let j = i; j >= 0; j--) if (events[j]?.trade) return [x(i), y(events[j].trade!.priceQuote * SUPPLY)];
    return [x(i), y(nowPrice)];
  };
  // marks no wider than the room each event has, so 40 of them don't pile up
  const slot = inner / Math.max(events.length, 1);
  const zMax = Math.max(10, Math.min(22, slot * 0.95));

  const gap = 16;
  const tw = takers.length ? (RIGHT.x1 - RIGHT.x0 - gap * (takers.length - 1)) / takers.length : 0;
  const takerBox = (i: number): Box => ({ x: RIGHT.x0 + i * (tw + gap), y: L.TAKER_Y, w: tw, h: L.TAKER_H });
  const COMP = L.COMP;
  const POOL = L.POOL;
  const tankTop = COMP.y + 76 + L.COMP_HEAD;
  const tankW = L.tall ? (COMP.w - 72) / 2 : 220;
  const tankH = COMP.y + COMP.h - 24 - tankTop;
  const POT: Box = { x: COMP.x + 30, y: tankTop, w: tankW, h: tankH };
  const HELD: Box = { x: COMP.x + COMP.w - 30 - tankW, y: tankTop, w: tankW, h: tankH };
  const PORT: Pt = [COMP.x, COMP.y + COMP.h - 30];
  const takerIn = (i: number): Pt[] => {
    const b = takerBox(i);
    return [
      [b.x + b.w / 2, L.BUS],
      [b.x + b.w / 2, b.y],
    ];
  };
  const toTaker = (p: Pt, i: number): Pt[] => [p, [p[0], L.BUS], ...takerIn(i)];
  const toChart = (p: Pt): Pt[] => [PORT, [L.SIDE_X, PORT[1]], [L.SIDE_X, L.LOW_BUS], [p[0], L.LOW_BUS], p];
  const potOut: Pt[] = [[POT.x + POT.w / 2, POT.y + POT.h], [POT.x + POT.w / 2, PORT[1]], PORT];
  const heldIn: Pt[] = [PORT, [HELD.x + HELD.w / 2, PORT[1]], [HELD.x + HELD.w / 2, HELD.y + HELD.h]];

  const tradeParticles = (e: Ev, i: number, start: number): Particle[] => {
    const tr = e.trade!;
    const q = Number(tr.quoteAmount) / 1e9;
    const p = pointOf(i);
    if (isCompanion(tr)) {
      const route = b2 ? [...potOut, ...toChart(p).slice(1)] : toChart(p);
      const back = b2 ? [...[...toChart(p)].reverse(), ...heldIn.slice(1)] : [...toChart(p)].reverse();
      return [
        { id: e.key + 's', route, start, dur: 1500, kind: 'sol', r: solR(q) },
        { id: e.key + 'c', route: back, start: start + 1500, dur: 1500, kind: 'coin', r: 6 },
      ];
    }
    return takers
      .map((tk, ti): Particle | null => {
        const bps = tr.side === 'buy' ? tk.buyBps : tk.sellBps;
        if (!bps) return null;
        return { id: `${e.key}${tk.id}`, route: toTaker(p, ti), start: start + ti * 120, dur: 1400, kind: tk.kind, r: solR((q * bps) / 10_000) + (e.you ? 2 : 0) };
      })
      .filter((v): v is Particle => v !== null);
  };

  // New trades and steps since the last poll become particles; the first load only draws.
  useEffect(() => {
    if (!events.length) return;
    const keys = new Set(events.map((e) => e.key));
    if (!seen.current) {
      seen.current = keys;
      return;
    }
    const fresh = events.map((e, i) => ({ e, i })).filter(({ e }) => !seen.current!.has(e.key));
    seen.current = keys;
    if (!fresh.length) return;
    const t0 = performance.now();
    const add: Particle[] = [];
    fresh.forEach(({ e, i }, n) => {
      const start = t0 + n * 260;
      if (e.trade) add.push(...tradeParticles(e, i, start));
      else add.push({ id: e.key + 'p', route: toChart(pointOf(i)), start, dur: 1300, kind: 'probe', r: 6 });
    });
    setParticles((ps) => [...ps.filter((p) => p.start + p.dur > t0), ...add]);
  }, [events]);

  // a new layout drops the particles in flight: their routes belong to the old one
  useEffect(() => setParticles([]), [tall]);

  useEffect(() => {
    if (!particles.length) return;
    let raf = 0;
    const tick = () => {
      const tt = performance.now();
      setNow(tt);
      if (particles.some((p) => p.start + p.dur > tt)) raf = requestAnimationFrame(tick);
      else setParticles([]);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [particles]);

  // Your trade joins the chart at the latest price the moment it confirms; the indexer's copy replaces it.
  const onSwapped = (s: Swapped) => {
    const ts = Math.floor(Date.now() / 1000);
    const last = events.filter((e) => e.trade).slice(-1)[0]?.trade?.priceQuote ?? t?.priceSol ?? 0;
    setMine((m) => [
      ...m,
      {
        key: s.signature,
        at: ts,
        kind: 'trade',
        you: true,
        trade: { signature: s.signature, ts, trader: 'you', side: s.side, baseAmount: '0', quoteAmount: String(Math.round(s.sol * 1e9)), priceQuote: last },
      },
    ]);
    setTimeout(refresh, 2500);
  };

  if (error && !data) return <div className="note err">{error}</div>;
  if (!data || !t) return <div className="note">Reading the machine from chain…</div>;

  const graduated = (lm?.launch.status ?? 'graduated') === 'graduated';
  const progress = lm?.launch.progress ?? 1;
  const stepPath = events.length
    ? events
        .map((_, i) => pointOf(i))
        .map(([px, py], i) => (i === 0 ? `M${CH.x0},${py}H${px}` : `H${px}V${py}`))
        .join('') + `H${CH.x1}`
    : `M${CH.x0},${y(nowPrice)}H${CH.x1}`;
  const areaPath = stepPath + `V${CH.y1}H${CH.x0}Z`;
  const fs = 14 * k;
  const hline = (v: number | undefined, dash: string, stroke: string, label: string, at: 'start' | 'end') =>
    v ? (
      <g>
        <line x1={CH.x0} x2={CH.x1} y1={y(v * SUPPLY)} y2={y(v * SUPPLY)} stroke={stroke} strokeWidth={1.4} strokeDasharray={dash} />
        <Tag x={at === 'end' ? CH.x1 - 4 : CH.x0 + 6} y={y(v * SUPPLY) - 9} text={label} anchor={at} color={stroke === 'var(--soft)' ? 'var(--ink-2)' : stroke} fs={fs * 0.95} />
      </g>
    ) : null;
  const hit = (suffix: string) => particles.some((p) => p.id.endsWith(suffix) && now > p.start + p.dur * 0.85 && now < p.start + p.dur + 300);
  /** a wire as a pipe: a dark casing, then a lit core */
  const wire = (pts: Pt[], dash?: string) =>
    dash ? (
      <path d={poly(pts)} fill="none" stroke="var(--line-2)" strokeWidth={1.2} strokeDasharray={dash} />
    ) : (
      <g>
        <path d={poly(pts)} fill="none" stroke="#07080a" strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
        <path d={poly(pts)} fill="none" stroke="rgba(238,240,242,0.10)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
        <path d={poly(pts)} fill="none" stroke="rgba(238,240,242,0.20)" strokeWidth={1} strokeLinejoin="round" transform="translate(0,-1)" />
      </g>
    );
  const timed = events.filter((e) => e.at);
  const ticks = (timed.length ? [0, Math.floor((events.length - 1) / 2), events.length - 1] : []).filter((v, i, a) => a.indexOf(v) === i && a.findIndex((u) => age(events[u].at) === age(events[v].at)) === i);
  const priceY = y(nowPrice);
  const priceLabel = `${nowPrice >= 100 ? nowPrice.toFixed(1) : nowPrice.toFixed(2)}`;
  const legend = (
    [
      ['buy', <path key="b" d={tri(0, 0, 14, true)} fill="url(#upFill)" stroke="var(--up)" strokeWidth={1.5} />],
      ['sell', <path key="s" d={tri(0, 0, 14, false)} fill="url(#downFill)" stroke="var(--down)" strokeWidth={1.5} />],
      [b2 ? 'B² buy' : 'companion', <rect key="c" x={-6.5} y={-6.5} width={13} height={13} rx={2.5} fill="#aab6ff" />],
      ...(b2 ? [['B² step', <circle key="p" r={6.5} fill="var(--card)" stroke="#aab6ff" strokeWidth={1.6} />] as [string, JSX.Element]] : []),
      ['your trade', <circle key="y" r={9} fill="none" stroke="var(--spot)" strokeWidth={2} />],
      ['SOL', <circle key="o" r={5} fill="url(#pearl)" />],
      ['coin', <rect key="k" x={-5.5} y={-5.5} width={11} height={11} rx={2} fill="var(--card)" stroke="#aab6ff" strokeWidth={1.5} />],
    ] as [string, JSX.Element][]
  );
  const legendW = L.tall ? (L.W - CH.x0 - 20) / L.LEGEND_COLS : 150;

  return (
    <div>
      <div className="machine-hero">
        {t.b2 ? <Cube size={64} big /> : <TokenIcon src={t.image} symbol={t.symbol} size={56} />}
        <div>
          <h1>
            {t.name} <span className="muted" style={{ fontWeight: 500 }}>machine</span>
          </h1>
          <div className="note" style={{ paddingLeft: 0 }}>
            <span className="pulse" />
            Live from chain · {t.symbol} · {lm ? (graduated ? 'graduated' : `curve ${(progress * 100).toFixed(1)}%`) : 'pool'}
            {b2?.script ? ` · ${b2.script.steps} B² steps, last ${age(b2.script.lastStepAt)} ago (${b2.script.lastAction})` : ''}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Link to={`/token/${t.mint}`} className="btn">
          Token page
        </Link>
      </div>

      <div className="machine-grid">
        <div ref={box}>
          <svg className="machine-svg" viewBox={`0 0 ${L.W} ${L.H}`}>
            <style>{`.t-mono{font-family:var(--mono)} .t-display{font-family:var(--display);font-weight:700;letter-spacing:-0.01em} text{font-family:var(--sans)}`}</style>
            <defs>
              <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="7" height="7" fill="rgba(59,85,255,0.16)" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(170,182,255,0.5)" strokeWidth="1.2" />
              </pattern>
              <linearGradient id="slab" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#23272d" />
                <stop offset="1" stopColor="#1a1d22" />
              </linearGradient>
              <linearGradient id="slabBase" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#191c21" />
                <stop offset="1" stopColor="#131519" />
              </linearGradient>
              <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2a2e35" />
                <stop offset="1" stopColor="#0f1114" />
              </linearGradient>
              <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(255,255,255,0.07)" />
                <stop offset="1" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
              <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="rgba(238,240,242,0.10)" />
                <stop offset="0.35" stopColor="rgba(11,12,14,0.9)" />
                <stop offset="0.7" stopColor="rgba(11,12,14,0.9)" />
                <stop offset="1" stopColor="rgba(238,240,242,0.08)" />
              </linearGradient>
              <linearGradient id="liquid" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="rgba(238,240,242,0.26)" />
                <stop offset="0.4" stopColor="rgba(238,240,242,0.12)" />
                <stop offset="1" stopColor="rgba(238,240,242,0.22)" />
              </linearGradient>
              <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(59,85,255,0.34)" />
                <stop offset="0.6" stopColor="rgba(59,85,255,0.08)" />
                <stop offset="1" stopColor="rgba(59,85,255,0)" />
              </linearGradient>
              <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#15171b" />
                <stop offset="1" stopColor="#101215" />
              </linearGradient>
              <linearGradient id="bond" x1="0" x2="1">
                <stop offset="0" stopColor="#3b55ff" />
                <stop offset="1" stopColor="#8a9bff" />
              </linearGradient>
              <linearGradient id="upFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(70,194,122,0.55)" />
                <stop offset="1" stopColor="rgba(70,194,122,0.12)" />
              </linearGradient>
              <linearGradient id="downFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(255,138,122,0.12)" />
                <stop offset="1" stopColor="rgba(255,138,122,0.55)" />
              </linearGradient>
              <linearGradient id="barInk" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f4f5f7" />
                <stop offset="1" stopColor="#b9bec5" />
              </linearGradient>
              <linearGradient id="barUp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#5fd894" />
                <stop offset="1" stopColor="#35a465" />
              </linearGradient>
              <linearGradient id="barSoft" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#7a8089" />
                <stop offset="1" stopColor="#4f545b" />
              </linearGradient>
              <radialGradient id="pearl" cx="0.35" cy="0.3" r="0.75">
                <stop offset="0" stopColor="#ffffff" />
                <stop offset="0.6" stopColor="#dfe3ea" />
                <stop offset="1" stopColor="#9aa1ab" />
              </radialGradient>
              <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="2.4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="lineGlow" x="-5%" y="-20%" width="110%" height="140%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feColorMatrix in="b" values="0 0 0 0 0.55  0 0 0 0 0.62  0 0 0 0 1  0 0 0 0.55 0" />
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
                <feGaussianBlur stdDeviation="9" />
              </filter>
              <clipPath id="chart-clip">
                <rect x={CH.x0} y={CH.y0 - 12} width={CH.x1 - CH.x0} height={CH.y1 - CH.y0 + 24} />
              </clipPath>
            </defs>

            {/* Wires, under everything */}
            {wire([
              [CH.x0, L.BUS],
              [RIGHT.x1 - 0.1, L.BUS],
            ])}
            {takers.map((_, i) => (
              <g key={i}>{wire(takerIn(i))}</g>
            ))}
            {companionAddr ? wire([[CH.x0, L.LOW_BUS], [L.SIDE_X, L.LOW_BUS], [L.SIDE_X, PORT[1]], PORT]) : null}

            {/* Chart: a raised plate, the area, the line as a ribbon, the marks */}
            <Slab b={{ x: CH.x0 - 10, y: CH.y0 - 16, w: CH.x1 - CH.x0 + 20, h: CH.y1 - CH.y0 + 32 }} rx={10} base />
            <text x={CH.x0} y={CH.y0 - 34} className="t-mono" fontSize={fs} fill="var(--ink-2)" letterSpacing="0.08em">
              {L.tall ? `MCAP · SOL · ${events.length} EVENTS` : `MARKET CAP · SOL · LAST ${events.length} EVENTS`}
            </text>
            <text x={CH.x1} y={CH.y0 - 30} textAnchor="end" className="t-display" fontSize={28 * k} fill="var(--ink)">
              {nowPrice.toFixed(1)} SOL
            </text>
            {Array.from({ length: 5 }, (_, i) => yLo + ((yHi - yLo) * i) / 4).map((v) => (
              <g key={v}>
                <line x1={CH.x0} x2={CH.x1} y1={y(v)} y2={y(v)} stroke="rgba(238,240,242,0.09)" />
                <text x={CH.x0 - 18} y={y(v) + 5} textAnchor="end" className="t-mono" fontSize={fs * 1.05} fill="var(--ink-2)" opacity={0.85}>
                  {v >= 100 ? v.toFixed(0) : v.toFixed(1)}
                </text>
              </g>
            ))}
            <g clipPath="url(#chart-clip)">
              <path d={areaPath} fill="url(#area)" />
              {/* the ribbon's thickness, then its lit edge */}
              <path d={stepPath} fill="none" stroke="#26305a" strokeWidth={3} strokeLinejoin="round" transform="translate(0,5)" />
              <path d={stepPath} fill="none" stroke="var(--ink)" strokeWidth={2.6} strokeLinejoin="round" filter="url(#lineGlow)" />
            </g>
            {b2 ? (
              <>
                {hline(b2.hook?.referenceSol, '10 8', 'var(--soft)', 'hook 6h ref', 'end')}
                {hline(b2.hook?.dipLineSol, '2 6', '#ff8a7a', 'dip −15%: buys 0%, sells 3%', 'start')}
                {hline(b2.script?.guardSol, '4 4', '#aab6ff', 'B² guard: 1h ref +3%', 'start')}
              </>
            ) : null}
            {events.map((e, i) => {
              const [px, py] = pointOf(i);
              if (!e.trade) return <circle key={e.key} cx={px} cy={py} r={Math.min(6.5, zMax * 0.42)} fill="var(--card)" stroke="#aab6ff" strokeWidth={1.6} />;
              const q = Number(e.trade.quoteAmount) / 1e9;
              if (isCompanion(e.trade)) {
                const z = Math.min(zMax * 0.8, 9 + 8 * Math.sqrt(Math.min(q, 1) / 0.3));
                return (
                  <g key={e.key}>
                    <rect x={px - z / 2 + 1.5} y={py - z / 2 + 3} width={z} height={z} rx={2.5} fill="#07080a" opacity={0.7} />
                    <rect x={px - z / 2} y={py - z / 2} width={z} height={z} rx={2.5} fill="#aab6ff" stroke="#dfe4ff" strokeWidth={0.8} />
                  </g>
                );
              }
              const z = Math.min(zMax, 9 + 14 * Math.sqrt(Math.min(q, 5) / 5));
              return (
                <g key={e.key}>
                  {e.you ? <circle cx={px} cy={py} r={z * 0.95} fill="none" stroke="var(--spot)" strokeWidth={2} /> : null}
                  <path d={tri(px + 1.5, py + 3, z, e.trade.side === 'buy')} fill="#07080a" opacity={0.6} />
                  {e.trade.side === 'buy' ? (
                    <path d={tri(px, py, z, true)} fill="url(#upFill)" stroke="var(--up)" strokeWidth={1.5} strokeLinejoin="round" />
                  ) : (
                    <path d={tri(px, py, z, false)} fill="url(#downFill)" stroke="var(--down)" strokeWidth={1.5} strokeLinejoin="round" />
                  )}
                </g>
              );
            })}
            {/* the price now, tagged at the chart's edge */}
            <g>
              <line x1={CH.x1 - 6} x2={CH.x1} y1={priceY} y2={priceY} stroke="var(--spot)" strokeWidth={2} />
              <rect x={CH.x1 - 8 - (priceLabel.length * fs * 0.6 + 16)} y={priceY - fs * 0.8 - 5} width={priceLabel.length * fs * 0.6 + 16} height={fs * 1.6 + 2} rx={6} fill="var(--spot)" />
              <text x={CH.x1 - 16} y={priceY + fs * 0.36} textAnchor="end" className="t-mono" fontSize={fs} fill="#fff" fontWeight={600}>
                {priceLabel}
              </text>
            </g>
            {/* time along the bottom */}
            {ticks.map((i, n) => (
              <text key={i} x={n === 0 ? CH.x0 + 4 : n === ticks.length - 1 ? CH.x1 - 4 : x(i)} y={CH.y1 + 12 + fs * 1.15} textAnchor={n === 0 ? 'start' : n === ticks.length - 1 ? 'end' : 'middle'} className="t-mono" fontSize={fs * 0.95} fill="var(--muted)">
                {age(events[i].at)} ago
              </text>
            ))}

            {/* Bond */}
            {lm ? (
              <g>
                <text x={CH.x0} y={L.BOND_Y} className="t-mono" fontSize={fs} fill="var(--ink-2)" letterSpacing="0.08em">
                  {graduated ? (L.tall ? 'GRADUATED' : 'GRADUATED · TRADING IN ITS POOL') : L.tall ? 'BOND' : 'BOND · REAL SOL IN THE CURVE'}
                </text>
                <text x={CH.x1} y={L.BOND_Y} textAnchor="end" className="t-mono" fontSize={fs * 1.05} fill="var(--ink)">
                  {lm.launch.realQuoteSol.toFixed(2)} / {lm.launch.graduationSol.toFixed(2)} · {(progress * 100).toFixed(1)}%
                </text>
                <rect x={CH.x0} y={L.BOND_Y + 14} width={CH.x1 - CH.x0} height={14} rx={7} fill="#07080a" stroke="rgba(238,240,242,0.08)" />
                <rect x={CH.x0 + 2} y={L.BOND_Y + 16} width={Math.max(0, (CH.x1 - CH.x0 - 4) * progress)} height={10} rx={5} fill="url(#bond)" style={{ transition: 'width 0.9s ease' }} />
                <rect x={CH.x0 + 3} y={L.BOND_Y + 17} width={Math.max(0, (CH.x1 - CH.x0 - 6) * progress)} height={4} rx={2} fill="rgba(255,255,255,0.25)" style={{ transition: 'width 0.9s ease' }} />
              </g>
            ) : null}

            {/* Legend */}
            {legend.map(([l, g], i) => (
              <g key={l} transform={`translate(${CH.x0 + 10 + (i % L.LEGEND_COLS) * legendW}, ${L.LEGEND_Y + Math.floor(i / L.LEGEND_COLS) * 34 * k})`}>
                {g}
                <text x={18} y={5} className="t-mono" fontSize={15 * k} fill="var(--ink-2)">
                  {l}
                </text>
              </g>
            ))}

            {/* the machine: wires from the takers into the companion, then the cards */}
            {b2 ? (
              <>
                {wire(potOut)}
                {wire(heldIn)}
              </>
            ) : null}
            {takers.map((tk, i) => {
              const b = takerBox(i);
              return tk.id === 'kit' ? null : <g key={tk.id}>{wire([[b.x + b.w / 2, b.y + b.h + DEPTH], [b.x + b.w / 2, COMP.y]], '3 4')}</g>;
            })}
            {takers.map((tk, i) => (
              <Panel key={tk.id} b={takerBox(i)} title={tk.title} lines={tk.lines} hit={hit(tk.id)} accent={tk.id === 'hook'} k={k} />
            ))}

            {/* B²'s companion, any other companion, or the creator */}
            {b2 ? (
              <g>
                <Slab b={COMP} />
                <text x={COMP.x + 30} y={COMP.y + 42} className="t-display" fontSize={27 * k} fill="var(--ink)">
                  COMPANION
                </text>
                <text
                  x={L.tall ? COMP.x + 30 : COMP.x + COMP.w - 30}
                  y={L.tall ? COMP.y + 42 + L.COMP_HEAD : COMP.y + 42}
                  textAnchor={L.tall ? 'start' : 'end'}
                  className="t-mono"
                  fontSize={fit('a step every 60 s · buys only under its guard', L.tall ? COMP.w - 60 : COMP.w - 260, 14.5 * k, true)}
                  fill="var(--ink-2)"
                  opacity={0.8}
                >
                  a step every 60 s · buys only under its guard
                </text>
                <Tank
                  b={POT}
                  id="pot"
                  title="POT"
                  value={b2.companion.potSol.toFixed(3)}
                  sub={`SOL · ${b2.script?.pregradSpentSol.toFixed(3) ?? '0'} spent`}
                  level={b2.companion.potSol / Math.max(1.5, b2.companion.potSol * 1.3)}
                  floor={graduated ? undefined : b2.companion.floorSol / Math.max(1.5, b2.companion.potSol * 1.3)}
                  k={k}
                />
                <Tank
                  b={HELD}
                  id="held"
                  title="HELD"
                  value={compact(b2.companion.heldCoin)}
                  sub={`coin ≈ ${(b2.companion.heldCoin * b2.pool.priceSol).toFixed(2)} SOL`}
                  level={b2.companion.heldCoin / Math.max(1e6, b2.companion.heldCoin * 1.25)}
                  hatch
                  k={k}
                />
              </g>
            ) : lm?.companion ? (
              <g>
                <Slab b={COMP} />
                <text x={COMP.x + 30} y={COMP.y + 42} className="t-display" fontSize={fit(`COMPANION${lm.companion.game ? ` · ${lm.companion.game.toUpperCase()}` : ''}`, L.tall ? COMP.w - 60 : COMP.w - 340, 27 * k)} fill="var(--ink)">
                  COMPANION{lm.companion.game ? ` · ${lm.companion.game.toUpperCase()}` : ''}
                </text>
                <text
                  x={L.tall ? COMP.x + 30 : COMP.x + COMP.w - 30}
                  y={L.tall ? COMP.y + 42 + L.COMP_HEAD : COMP.y + 42}
                  textAnchor={L.tall ? 'start' : 'end'}
                  className="t-mono"
                  fontSize={14.5 * k}
                  fill="var(--ink-2)"
                  opacity={0.8}
                >
                  {short(lm.companion.address)} · holds {lm.companion.sol.toFixed(3)} SOL
                </text>
                <SplitBars s={lm.companion.split} b={COMP} top={COMP.y + 84 + L.COMP_HEAD} k={k} />
                {(
                  [
                    ['claimed', `${compact(lm.companion.claimedSol)} SOL`],
                    ['spent on buybacks', `${compact(lm.companion.spentSol)} SOL`],
                    ['burned', compact(lm.companion.burnedTokens)],
                    ['to holders', `${compact(lm.companion.sharedSol)} SOL`],
                    ['to launcher', `${compact(lm.companion.paidBeneficiarySol)} SOL`],
                    ['pending', `${compact(lm.companion.pendingBuybackSol + lm.companion.pendingHoldersSol + lm.companion.pendingPotSol)} SOL`],
                  ] as [string, string][]
                ).map(([key, v], i) => {
                  const colW = (COMP.w - 60) / L.STAT_COLS;
                  const rowH = 58 * Math.min(k, 1.15);
                  return (
                    <g key={key} transform={`translate(${COMP.x + 30 + (i % L.STAT_COLS) * colW}, ${COMP.y + 196 * (L.tall ? 1.08 : 1) + L.COMP_HEAD + Math.floor(i / L.STAT_COLS) * rowH})`}>
                      <text className="t-mono" fontSize={fit(key.toUpperCase(), colW - 12, 14 * k, true)} fill="var(--muted)" letterSpacing="0.06em">
                        {key.toUpperCase()}
                      </text>
                      <text y={30 * Math.min(k, 1.1)} className="t-display" fontSize={fit(v, colW - 12, 24 * k)} fill="var(--ink)">
                        {v}
                      </text>
                    </g>
                  );
                })}
              </g>
            ) : (
              <Panel
                b={{ ...COMP, h: 128 }}
                title={lm ? 'CREATOR' : 'POOL ONLY'}
                lines={
                  lm
                    ? [`${short(lm.launch.creator)} claims the creator fee`, data.rules?.creatorShare != null ? `holds ${(data.rules.creatorShare * 100).toFixed(2)}% of supply` : '']
                    : ['an ordinary pool on the DEX: its LP fee stays with liquidity providers']
                }
                k={k}
              />
            )}

            {/* Pool */}
            <Panel
              b={POOL}
              title={lm?.pool.curve ? 'BONDING CURVE' : 'POOL'}
              lines={[`${short(lm?.pool.address ?? t.pool ?? '')} · LP fee ${pctOf(data.rules?.lpFeeBps ?? lm?.launch.lpFeeBps ?? 30)} stays in the pool`, `liquidity ${sol(t.liquiditySol, 1)}`]}
              k={k}
            />

            {/* Particles, each with a short trail */}
            {particles.map((p) => {
              const s = (now - p.start) / p.dur;
              if (s <= 0 || s >= 1) return null;
              return (
                <g key={p.id}>
                  {[0.05, 0.025].map((d, j) => (s - d > 0 ? <Dot key={j} p={along(p.route, ease(s - d))} kind={p.kind} r={p.r * (0.55 + j * 0.2)} o={0.18 + j * 0.17} /> : null))}
                  <Dot p={along(p.route, ease(s))} kind={p.kind} r={p.r} />
                </g>
              );
            })}
          </svg>

          {steps.length ? (
            <>
              <div className="label section-title">Latest B² steps</div>
              <div className="table-wrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="l">Action</th>
                      <th>SOL spent</th>
                      <th>Got</th>
                      <th>Pot before</th>
                      <th>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.slice(0, 12).map((s) => (
                      <tr key={s.signature} className="row" onClick={() => window.open(`https://solscan.io/tx/${s.signature}`, '_blank')}>
                        <td className="l mono">{s.action}</td>
                        <td className="mono">{s.sol ? sol(s.sol, 4) : '—'}</td>
                        <td className="mono">{s.amount ? compact(s.amount) : '—'}</td>
                        <td className="mono">{sol(s.pot, 3)}</td>
                        <td className="mono muted">{age(s.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <div className="side">
          <SwapCard initialMint={t.mint} compactCard lockToken onSwapped={onSwapped} />
          <div className="note">Trade here and your trade runs through the machine as soon as it confirms.</div>
          <div className="label">Rules</div>
          <div className="kv">
            {data.rules ? (
              <>
                <div>
                  <span>Buy · sell fee</span>
                  <span className="mono">
                    {pctOf(data.rules.buyFeeBps)} · {pctOf(data.rules.sellFeeBps)}
                  </span>
                </div>
                {(data.rules.customHook?.workshop?.reading?.rules ?? []).map((r, i) => (
                  <div key={i} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
                    <span>{r.when}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.45 }}>{r.text}</span>
                  </div>
                ))}
                {data.rules.customHook ? (
                  <div>
                    <span>Hook upgrade</span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {data.rules.customHook.upgradeable ? `upgradeable · ${short(data.rules.customHook.upgradeAuthority ?? '')}` : 'immutable'}
                    </span>
                  </div>
                ) : null}
                {data.rules.rules?.maxWalletBps ? (
                  <div>
                    <span>Max wallet</span>
                    <span className="mono">{pctOf(data.rules.rules.maxWalletBps)} until graduation</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div>
                <span>Pool</span>
                <span className="mono">not a launch: no rules beyond its fee</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
