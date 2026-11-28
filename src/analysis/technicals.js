// Technical indicators computed from daily bars.

export function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

export function emaSeries(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = arr[0];
  for (let i = 0; i < arr.length; i++) {
    e = i === 0 ? arr[0] : arr[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// Wilder RSI
export function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / n;
  let al = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

export function atr(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = trs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}

function stdev(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

export function computeTechnicals(bars, benchBars = null) {
  if (!bars || bars.length < 30) return null;
  const c = bars.map((b) => b.c);
  const v = bars.map((b) => b.v);
  const last = c[c.length - 1];
  const n = c.length;

  const sma20 = sma(c, 20);
  const sma50 = sma(c, 50);
  const sma200 = sma(c, 200);

  const e12 = emaSeries(c, 12);
  const e26 = emaSeries(c, 26);
  const macdLine = e12.map((x, i) => x - e26[i]);
  const signal = emaSeries(macdLine, 9);
  const hist = macdLine[n - 1] - signal[n - 1];
  const histPrev = macdLine[n - 2] - signal[n - 2];

  const win = c.slice(-20);
  const sd = stdev(win);
  const bbUpper = sma20 + 2 * sd;
  const bbLower = sma20 - 2 * sd;
  const pctB = bbUpper !== bbLower ? (last - bbLower) / (bbUpper - bbLower) : 0.5;

  const rets = [];
  for (let i = Math.max(1, n - 20); i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const volRaw = stdev(rets.filter(isFinite)) * Math.sqrt(252) * 100; // annualized %
  const vol20 = isFinite(volRaw) ? volRaw : null;

  const a14 = atr(bars, 14);
  const avgVol20 = sma(v.slice(0, -1), 20);
  const avgVol50 = sma(v, Math.min(50, n));
  const relVol = avgVol20 ? v[n - 1] / avgVol20 : null;
  const vol5 = sma(v, 5);
  const relVol5 = avgVol50 ? vol5 / avgVol50 : null;

  const year = c.slice(-252);
  const hi52 = Math.max(...bars.slice(-252).map((b) => b.h));
  const lo52 = Math.min(...bars.slice(-252).map((b) => b.l));

  // On-balance volume slope over last 20 days vs price slope (accumulation / distribution)
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < n; i++) {
    obv += c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0;
    obvArr.push(obv);
  }
  const obvChange20 = obvArr[n - 1] - obvArr[Math.max(0, n - 21)];
  const obvNorm = avgVol20 ? obvChange20 / (avgVol20 * 20) : 0;

  const ret = (d) => (n > d ? pct(last, c[n - 1 - d]) : null);

  let relStrength3m = null;
  if (benchBars && benchBars.length > 63 && n > 63) {
    const bc = benchBars.map((b) => b.c);
    relStrength3m = pct(last, c[n - 64]) - pct(bc[bc.length - 1], bc[bc.length - 64]);
  }

  return {
    price: last,
    change1d: pct(last, c[n - 2]),
    ret5d: ret(5),
    ret1m: ret(21),
    ret3m: ret(63),
    ret1y: n > 250 ? pct(last, year[0]) : null,
    rsi14: rsi(c, 14),
    sma20,
    sma50,
    sma200,
    macd: macdLine[n - 1],
    macdSignal: signal[n - 1],
    macdHist: hist,
    macdCross: hist > 0 && histPrev <= 0 ? 'bullish' : hist < 0 && histPrev >= 0 ? 'bearish' : null,
    pctB,
    vol20,
    atr14: a14,
    atrPct: a14 ? (a14 / last) * 100 : null,
    volume: v[n - 1],
    avgVolume20: avgVol20,
    relVolume: relVol,
    relVolume5: relVol5,
    hi52,
    lo52,
    fromHigh: pct(last, hi52),
    fromLow: pct(last, lo52),
    obvTrend: obvNorm,
    relStrength3m,
    goldenCross: sma50 && sma200 ? sma50 > sma200 : null,
  };
}
