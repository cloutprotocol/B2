import { useEffect, useRef } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../api';

// Candles in SOL per token (TradingView's lightweight-charts), coloured from the page's own tokens.

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function Chart({ candles }: { candles: Candle[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--card') }, textColor: css('--muted'), fontFamily: 'IBM Plex Mono' },
      grid: { vertLines: { color: css('--faint') }, horzLines: { color: css('--faint') } },
      rightPriceScale: { borderColor: css('--rule') },
      timeScale: { borderColor: css('--rule'), timeVisible: true },
      localization: { priceFormatter: (p: number) => (p < 0.001 ? p.toExponential(3) : p.toFixed(6)) },
    });
    series.current = c.addCandlestickSeries({
      upColor: css('--up'),
      downColor: css('--down'),
      borderVisible: false,
      wickUpColor: css('--up'),
      wickDownColor: css('--down'),
      priceFormat: { type: 'price', precision: 12, minMove: 1e-12 },
    });
    volume.current = c.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' }, color: css('--rule') });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => c.remove();
  }, []);

  useEffect(() => {
    if (!series.current || !volume.current) return;
    series.current.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    volume.current.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, value: k.v, color: k.c >= k.o ? css('--rule') : css('--soft') })));
  }, [candles]);

  return <div ref={box} style={{ position: 'absolute', inset: 0 }} />;
}
