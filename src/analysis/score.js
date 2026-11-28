// Composite scoring. Each component returns a score in [-1, 1], a weight, a
// confidence in [0, 1] and plain-language signals. The composite is the
// confidence-weighted average scaled to [-100, 100].
import { clamp, daysBetween } from '../util.js';

export const WEIGHTS = {
  insider: 0.23,
  technical: 0.22,
  analyst: 0.14,
  news: 0.12,
  positioning: 0.1,
  congress: 0.1,
  social: 0.09,
};

const fmtMoney = (v) => {
  if (v == null) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const sig = (text, impact) => ({ text, impact });
const isCSuite = (t) => /CEO|Chief Executive|CFO|Chief Financial|President|Chair|COO|Chief Operating/i.test(t || '');

// ---------- Insiders ----------
export function scoreInsider(ins) {
  if (!ins || !ins.available) return null;
  const tx = ins.transactions || [];
  const buys = tx.filter((t) => t.code === 'P');
  const sells = tx.filter((t) => t.code === 'S');
  const signals = [];
  let s = 0;

  if (buys.length) {
    const buyers = new Set(buys.map((b) => b.owner));
    const value = buys.reduce((a, b) => a + (b.value || 0), 0);
    const csuite = new Set(buys.filter((b) => isCSuite(b.title)).map((b) => b.owner));
    s += 0.35 + 0.15 * Math.min(buyers.size - 1, 3);
    if (csuite.size) s += 0.15;
    s += 0.1 * clamp(Math.log10(Math.max(value, 1) / 100000), 0, 2);
    const incs = buys.filter((b) => b.ownedAfter && b.shares && b.ownedAfter > b.shares).map((b) => b.shares / (b.ownedAfter - b.shares));
    const maxInc = incs.length ? Math.max(...incs) : 0;
    if (maxInc > 0.1) s += 0.1;
    const newest = buys.map((b) => b.date).sort().pop();
    if (newest && daysBetween(newest) <= 7) s += 0.05;
    signals.push(
      sig(
        `${buyers.size} insider${buyers.size > 1 ? 's' : ''} bought ${fmtMoney(value)} on the open market${csuite.size ? `, including ${[...csuite].slice(0, 2).join(' and ')}` : ''}`,
        1
      )
    );
    if (buyers.size >= 3) signals.push(sig('Cluster buy: 3 or more insiders buying in the same window, historically one of the strongest insider signals', 1));
    if (maxInc > 0.1) signals.push(sig(`At least one insider grew their stake by ${(maxInc * 100).toFixed(0)}%`, 1));
    const planBuys = buys.filter((b) => b.plan10b5).length;
    if (planBuys) signals.push(sig(`${planBuys} of these purchases ${planBuys === 1 ? 'was' : 'were'} made under a pre-scheduled 10b5-1 plan`, 0));
  }

  const planSells = sells.filter((t) => t.plan10b5);
  const discSells = sells.filter((t) => !t.plan10b5);
  if (discSells.length) {
    const sellers = new Set(discSells.map((x) => x.owner));
    const value = discSells.reduce((a, b) => a + (b.value || 0), 0);
    const cs = discSells.some((x) => isCSuite(x.title));
    s -= Math.min(0.1 * sellers.size + (cs ? 0.1 : 0) + 0.05 * clamp(Math.log10(Math.max(value, 1) / 1e6), 0, 2), 0.5);
    if (sellers.size >= 3) s -= 0.1;
    signals.push(sig(`${sellers.size} insider${sellers.size > 1 ? 's' : ''} sold ${fmtMoney(value)} outside a pre-set 10b5-1 plan${cs ? ' (includes a top executive)' : ''}`, -1));
  }
  if (planSells.length) {
    s -= Math.min(0.03 * planSells.length, 0.12);
    signals.push(sig(`${planSells.length} sale${planSells.length > 1 ? 's' : ''} under pre-scheduled 10b5-1 plans (weak signal)`, 0));
  }
  if (!tx.length) signals.push(sig('No open-market insider buys or sells in the lookback window', 0));
  return { key: 'insider', label: 'Insider activity', score: clamp(s), weight: WEIGHTS.insider, confidence: tx.length ? 1 : 0.35, signals };
}

// ---------- Technicals ----------
export function scoreTechnical(t) {
  if (!t) return null;
  const signals = [];
  let s = 0;
  if (t.sma50) {
    s += t.price > t.sma50 ? 0.12 : -0.12;
  }
  if (t.sma200) {
    s += t.price > t.sma200 ? 0.12 : -0.12;
    signals.push(sig(t.price > t.sma200 ? 'Price is above its 200 day average (long term uptrend)' : 'Price is below its 200 day average (long term downtrend)', t.price > t.sma200 ? 1 : -1));
  }
  if (t.goldenCross != null) s += t.goldenCross ? 0.06 : -0.06;
  if (t.macdCross === 'bullish') {
    s += 0.15;
    signals.push(sig('Fresh bullish MACD crossover', 1));
  } else if (t.macdCross === 'bearish') {
    s -= 0.15;
    signals.push(sig('Fresh bearish MACD crossover', -1));
  } else s += t.macdHist > 0 ? 0.06 : -0.06;

  if (t.rsi14 != null) {
    if (t.rsi14 < 30) {
      s += 0.15;
      signals.push(sig(`RSI ${t.rsi14.toFixed(0)}: oversold, rebound risk is to the upside`, 1));
    } else if (t.rsi14 > 75) {
      s -= 0.15;
      signals.push(sig(`RSI ${t.rsi14.toFixed(0)}: very overbought, pullback risk`, -1));
    } else if (t.rsi14 > 70) {
      s -= 0.07;
      signals.push(sig(`RSI ${t.rsi14.toFixed(0)}: overbought`, -1));
    } else if (t.rsi14 >= 50 && t.rsi14 <= 65) s += 0.05;
  }
  if (t.relVolume != null && t.relVolume > 1.8) {
    const up = (t.change1d || 0) >= 0;
    s += up ? 0.15 : -0.15;
    signals.push(sig(`Volume ${t.relVolume.toFixed(1)}x the 20 day average on a${up ? 'n up' : ' down'} day`, up ? 1 : -1));
  }
  if (t.fromHigh != null && t.fromHigh > -3) {
    s += 0.1;
    signals.push(sig('Trading within 3% of its 52 week high (breakout zone)', 1));
  } else if (t.fromLow != null && t.fromLow < 5) {
    s -= 0.1;
    signals.push(sig('Trading within 5% of its 52 week low', -1));
  }
  if (t.relStrength3m != null) {
    s += 0.15 * clamp(t.relStrength3m / 20);
    if (Math.abs(t.relStrength3m) > 10) signals.push(sig(`${t.relStrength3m > 0 ? 'Outperformed' : 'Underperformed'} the S&P 500 by ${Math.abs(t.relStrength3m).toFixed(0)} points over 3 months`, Math.sign(t.relStrength3m)));
  }
  if (t.obvTrend) {
    s += clamp(t.obvTrend * 0.4, -0.1, 0.1);
    if (Math.abs(t.obvTrend) > 0.25) signals.push(sig(t.obvTrend > 0 ? 'On balance volume shows accumulation' : 'On balance volume shows distribution', Math.sign(t.obvTrend)));
  }
  return { key: 'technical', label: 'Technicals', score: clamp(s), weight: WEIGHTS.technical, confidence: 1, signals };
}

// ---------- Analysts ----------
export function scoreAnalyst(a, price) {
  if (!a) return null;
  const signals = [];
  let s = 0;
  let conf = 0.3;
  const recent = (a.actions || []).filter((x) => daysBetween(x.date) <= 30);
  let up = 0;
  let down = 0;
  for (const x of recent) {
    const act = (x.action || '').toLowerCase();
    if (act === 'up') up++;
    else if (act === 'down') down++;
    else if (act === 'init') {
      if (/buy|outperform|overweight|positive/i.test(x.toGrade)) s += 0.08;
      if (/sell|underperform|underweight|negative/i.test(x.toGrade)) s -= 0.08;
    }
    if (/raise/i.test(x.ptAction || '')) s += 0.04;
    if (/lower/i.test(x.ptAction || '')) s -= 0.04;
  }
  s += 0.2 * up - 0.2 * down;
  if (recent.length) conf = 1;
  if (up) signals.push(sig(`${up} analyst upgrade${up > 1 ? 's' : ''} in the last 30 days (${recent.filter((x) => x.action === 'up').map((x) => x.firm).slice(0, 3).join(', ')})`, 1));
  if (down) signals.push(sig(`${down} analyst downgrade${down > 1 ? 's' : ''} in the last 30 days (${recent.filter((x) => x.action === 'down').map((x) => x.firm).slice(0, 3).join(', ')})`, -1));
  const raises = recent.filter((x) => /raise/i.test(x.ptAction || '')).length;
  const lowers = recent.filter((x) => /lower/i.test(x.ptAction || '')).length;
  if (raises + lowers >= 2) signals.push(sig(`${raises} price target raise${raises === 1 ? '' : 's'} vs ${lowers} cut${lowers === 1 ? '' : 's'} this month`, Math.sign(raises - lowers)));

  if (a.targetMean && price) {
    const upside = (a.targetMean / price - 1) * 100;
    s += 0.3 * clamp(upside / 30);
    conf = Math.max(conf, 0.7);
    signals.push(sig(`Average price target ${a.targetMean.toFixed(2)} implies ${upside >= 0 ? '+' : ''}${upside.toFixed(1)}% (${a.numAnalysts || '?'} analysts)`, upside > 5 ? 1 : upside < -5 ? -1 : 0));
  }
  if (a.recMean) s += 0.2 * clamp((3 - a.recMean) / 2);
  return { key: 'analyst', label: 'Wall Street analysts', score: clamp(s), weight: WEIGHTS.analyst, confidence: conf, signals };
}

// ---------- Short interest / positioning ----------
export function scorePositioning(p, tech) {
  if (!p || p.shortPctFloat == null) return null;
  const signals = [];
  let s = 0;
  const si = p.shortPctFloat * 100;
  const uptrend = tech && tech.sma50 ? tech.price > tech.sma50 : null;
  if (si >= 20) {
    if (uptrend) {
      s += 0.35;
      signals.push(sig(`Short interest ${si.toFixed(1)}% of float in an uptrend: squeeze potential`, 1));
    } else {
      s -= 0.2;
      signals.push(sig(`Short interest ${si.toFixed(1)}% of float and price is below its 50 day average: shorts are winning`, -1));
    }
  } else if (si >= 10) {
    s += uptrend ? 0.12 : -0.08;
    signals.push(sig(`Elevated short interest: ${si.toFixed(1)}% of float`, uptrend ? 1 : -1));
  } else signals.push(sig(`Short interest is modest at ${si.toFixed(1)}% of float`, 0));
  if (p.shortChange != null) {
    if (p.shortChange > 0.2) {
      s -= 0.15;
      signals.push(sig(`Shares sold short rose ${(p.shortChange * 100).toFixed(0)}% vs the prior report`, -1));
    } else if (p.shortChange < -0.2) {
      s += 0.12;
      signals.push(sig(`Shares sold short fell ${(-p.shortChange * 100).toFixed(0)}% vs the prior report (covering)`, 1));
    }
  }
  if (p.daysToCover != null && p.daysToCover >= 5) signals.push(sig(`${p.daysToCover.toFixed(1)} days to cover`, 0));
  return { key: 'positioning', label: 'Short interest', score: clamp(s), weight: WEIGHTS.positioning, confidence: 0.9, signals };
}

// ---------- Congress ----------
export function scoreCongress(trades) {
  if (!trades) return null;
  const signals = [];
  const buys = trades.filter((t) => t.type === 'buy');
  const sells = trades.filter((t) => t.type === 'sell');
  let s = 0;
  for (const b of buys) s += 0.2 + (b.amountMin >= 50000 ? 0.1 : 0);
  for (const x of sells) s -= 0.15 + (x.amountMin >= 50000 ? 0.08 : 0);
  if (buys.length) signals.push(sig(`${buys.length} recent congressional purchase${buys.length > 1 ? 's' : ''} (${[...new Set(buys.map((b) => b.member))].slice(0, 3).join(', ')})`, 1));
  if (sells.length) signals.push(sig(`${sells.length} recent congressional sale${sells.length > 1 ? 's' : ''} (${[...new Set(sells.map((b) => b.member))].slice(0, 3).join(', ')})`, -1));
  if (!trades.length) signals.push(sig('No recent congressional trades disclosed', 0));
  return { key: 'congress', label: 'Congress trades', score: clamp(s, -0.8, 0.8), weight: WEIGHTS.congress, confidence: trades.length ? 0.9 : 0.25, signals };
}

// ---------- Social ----------
export function scoreSocial(soc, tech) {
  if (!soc) return null;
  const signals = [];
  let s = 0;
  let conf = 0.3;
  const { ape, st, trending } = soc;
  if (st && st.bullish + st.bearish >= 5) {
    const tot = st.bullish + st.bearish;
    const bias = (st.bullish - st.bearish) / tot;
    // Retail is structurally bullish on StockTwits, so center around ~70% bulls.
    const adj = clamp((st.bullish / tot - 0.7) / 0.3);
    s += 0.45 * adj;
    conf = Math.min(1, 0.4 + tot / 30);
    signals.push(sig(`StockTwits: ${st.bullish} bullish vs ${st.bearish} bearish tagged posts`, adj > 0.15 ? 1 : adj < -0.15 ? -1 : 0));
    void bias;
  }
  if (ape) {
    const mom = (ape.mentions - ape.mentions24hAgo) / Math.max(ape.mentions24hAgo, 5);
    conf = Math.max(conf, 0.6);
    signals.push(sig(`Reddit: ${ape.mentions} mentions in 24h (rank #${ape.rank}${ape.rank24hAgo ? `, was #${ape.rank24hAgo}` : ''})`, 0));
    if (mom > 1) signals.push(sig(`Reddit mentions up ${(mom * 100).toFixed(0)}% day over day`, 0));
    // Hype into an overbought chart is a contrarian warning.
    if (tech && tech.rsi14 > 75 && ape.rank <= 20) {
      s -= 0.2;
      signals.push(sig('Heavy retail hype while the chart is overbought: crowded trade risk', -1));
    } else if (mom > 1) s += 0.15;
  }
  if (trending) signals.push(sig('Currently trending on StockTwits', 0));
  if (!signals.length) return null;
  return { key: 'social', label: 'Social buzz', score: clamp(s), weight: WEIGHTS.social, confidence: conf, signals };
}

// ---------- News ----------
export function scoreNews(n) {
  if (!n || !n.items || !n.items.length) return null;
  const pos = n.items.filter((i) => i.tone > 0).length;
  const neg = n.items.filter((i) => i.tone < 0).length;
  const signals = [sig(`${pos} positive and ${neg} negative stories out of ${n.items.length} in the last 10 days (newest count most)`, n.score > 0.1 ? 1 : n.score < -0.1 ? -1 : 0)];
  const cats = [...new Set(n.items.filter((i) => i.catalyst && i.ageDays <= 5).map((i) => i.catalyst))];
  if (cats.length) signals.push(sig(`Recent catalysts in the headlines: ${cats.slice(0, 4).join(', ')}`, 0));
  if (n.last48h >= 6) signals.push(sig(`Heavy news flow: ${n.last48h} stories in the last 48 hours`, 0));
  const top = n.items.find((i) => i.tone !== 0 && i.ageDays <= 3);
  if (top) signals.push(sig(`Latest ${top.tone > 0 ? 'positive' : 'negative'} story: "${top.title.slice(0, 120)}"`, top.tone));
  return {
    key: 'news',
    label: 'Latest news',
    score: clamp(n.score * 1.3),
    weight: WEIGHTS.news,
    confidence: Math.min(1, 0.3 + n.items.length / 15),
    signals,
  };
}

// ---------- Composite ----------
const finite = (x) => typeof x === 'number' && isFinite(x);

export function composite(components) {
  // A component with a non numeric score (bad upstream data) is left out
  // rather than turning the whole composite into NaN.
  const cs = components.filter((c) => c && finite(c.score) && finite(c.weight) && finite(c.confidence));
  let num = 0;
  let den = 0;
  for (const c of cs) {
    num += c.score * c.weight * c.confidence;
    den += c.weight * c.confidence;
  }
  const score = den ? Math.round((num / den) * 100) : 0;
  let verdict = 'Neutral';
  if (score >= 35) verdict = 'Bullish';
  else if (score >= 15) verdict = 'Leaning bullish';
  else if (score <= -35) verdict = 'Bearish';
  else if (score <= -15) verdict = 'Leaning bearish';
  const coverage = cs.reduce((a, c) => a + c.weight, 0) / Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  return { score, verdict, coverage: +coverage.toFixed(2) };
}

// How likely is a big move (either direction)? 0 to 100.
export function movePotential({ tech, positioning, social, earningsDays, score, insiderCluster, newsFlow = 0 }) {
  // Each input adds its share only when it is a real number, so one bad
  // field cannot turn the whole reading into NaN.
  let p = 0;
  const add = (x) => {
    if (finite(x)) p += x;
  };
  const why = [];
  if (tech) {
    add(clamp((tech.vol20 || 0) / 80, 0, 1) * 30);
    if (tech.vol20 > 50) why.push(`high realized volatility (${tech.vol20.toFixed(0)}% annualized)`);
    if (tech.relVolume5 != null) {
      add(clamp((tech.relVolume5 - 1) / 1.5, 0, 1) * 15);
      if (tech.relVolume5 > 1.5) why.push(`volume running ${tech.relVolume5.toFixed(1)}x normal this week`);
    }
  }
  if (positioning && positioning.shortPctFloat != null) {
    add(clamp((positioning.shortPctFloat * 100) / 25, 0, 1) * 15);
    if (positioning.shortPctFloat > 0.15) why.push('heavy short interest');
  }
  if (social && social.ape) {
    const mom = (social.ape.mentions - social.ape.mentions24hAgo) / Math.max(social.ape.mentions24hAgo, 5);
    add(clamp(mom / 2, 0, 1) * 10);
    if (social.ape.rank <= 25) {
      add(5);
      why.push('top 25 on Reddit');
    }
  }
  if (earningsDays != null && earningsDays >= 0 && earningsDays <= 14) {
    add(15);
    why.push(`earnings in ${earningsDays} day${earningsDays === 1 ? '' : 's'}`);
  }
  if (insiderCluster) {
    add(5);
    why.push('insider cluster buying');
  }
  if (newsFlow >= 6) {
    add(8);
    why.push(`${newsFlow} news stories in the last 48 hours`);
  }
  if (finite(score) && Math.abs(score) >= 40) add(10);
  p = Math.round(clamp(p, 0, 100));
  const level = p >= 60 ? 'High' : p >= 35 ? 'Elevated' : 'Normal';
  const oneSigma1m = tech && finite(tech.vol20) && tech.vol20 > 0 ? tech.vol20 / Math.sqrt(12) : null;
  return { value: p, level, why, typicalMonthMovePct: oneSigma1m ? +oneSigma1m.toFixed(1) : null };
}
