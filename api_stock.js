// api/stock.js - 네이버 금융 + Yahoo Finance 하이브리드
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { code, market } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });

  // 미국 주식 → Yahoo Finance
  if (market === 'US') {
    const d = await fetchYahoo(code, true);
    if (d) return res.json(d);
    return res.status(404).json({ error: 'not found' });
  }

  // 한국 주식 → 네이버 먼저, 실패시 Yahoo
  const naverData = await fetchNaver(code, market);
  if (naverData) return res.json(naverData);

  const sym = market === 'KOSPI' ? code + '.KS' : code + '.KQ';
  const yahooData = await fetchYahoo(sym, false);
  if (yahooData) return res.json({ ...yahooData, source: 'yahoo_fallback' });

  return res.status(404).json({ error: 'price not found' });
}

async function fetchNaver(code, market) {
  // 1차: 네이버 실시간 Polling API
  try {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.finance.naver.com/',
        'Accept': 'application/json',
      }
    });
    if (!r.ok) throw new Error('naver polling failed');
    const data = await r.json();
    const item = data?.result?.areas?.[0]?.datas?.[0];
    if (!item) throw new Error('no item');

    const price = parseInt(item.nv || item.sv || 0);
    if (!price) throw new Error('no price');
    const change = parseInt(item.cv || 0);
    const changeRate = parseFloat(item.cr || 0);
    const isDown = item.rf === '5' || parseFloat(item.cr || 0) < 0;

    return {
      code, market,
      price,
      change: isDown ? -Math.abs(change) : Math.abs(change),
      changeRate: isDown ? -Math.abs(changeRate) : Math.abs(changeRate),
      open: parseInt(item.ov || price),
      high: parseInt(item.hv || price),
      low: parseInt(item.lv || price),
      volume: parseInt(item.tv || 0),
      isUS: false,
      source: 'naver',
    };
  } catch(e1) {}

  // 2차: 네이버 모바일 주식 API
  try {
    const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.stock.naver.com/',
        'Accept': 'application/json',
      }
    });
    if (!r.ok) throw new Error('naver mobile failed');
    const d = await r.json();

    const price = parseInt((d.closePrice || '0').replace(/,/g, ''));
    if (!price) throw new Error('no price');
    const change = parseInt((d.compareToPreviousClosePrice || '0').replace(/,/g, ''));
    const changeRate = parseFloat((d.fluctuationsRatio || '0').replace(/,/g, ''));
    const isDown = d.compareToPreviousPrice?.code === '5';

    return {
      code, market,
      price,
      change: isDown ? -Math.abs(change) : Math.abs(change),
      changeRate: isDown ? -Math.abs(changeRate) : Math.abs(changeRate),
      open: parseInt((d.openPrice || '0').replace(/,/g, '')),
      high: parseInt((d.highPrice || '0').replace(/,/g, '')),
      low: parseInt((d.lowPrice || '0').replace(/,/g, '')),
      volume: parseInt((d.accumulatedTradingVolume || '0').replace(/,/g, '')),
      isUS: false,
      source: 'naver_mobile',
    };
  } catch(e2) {}

  return null;
}

async function fetchYahoo(sym, isUS) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose || price;
    const change = price - prev;

    return {
      price: isUS ? parseFloat(price.toFixed(2)) : Math.round(price),
      change: isUS ? parseFloat(change.toFixed(2)) : Math.round(change),
      changeRate: parseFloat(((change / prev) * 100).toFixed(2)),
      open: isUS ? parseFloat((meta.regularMarketOpen||price).toFixed(2)) : Math.round(meta.regularMarketOpen||price),
      high: isUS ? parseFloat((meta.regularMarketDayHigh||price).toFixed(2)) : Math.round(meta.regularMarketDayHigh||price),
      low: isUS ? parseFloat((meta.regularMarketDayLow||price).toFixed(2)) : Math.round(meta.regularMarketDayLow||price),
      volume: meta.regularMarketVolume || 0,
      isUS,
      source: 'yahoo',
    };
  } catch(e) { return null; }
}
