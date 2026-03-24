// api/stock.js - 네이버 금융 + Yahoo Finance 하이브리드
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { code, market, search } = req.query;

  // 종목 검색 모드
  if (search) {
    const results = await searchStocks(search);
    return res.json(results);
  }

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
  if (yahooData) return res.json({ ...yahooData, source: 'yahoo' });

  return res.status(404).json({ error: 'price not found' });
}

// 네이버 종목 자동완성 검색
async function searchStocks(query) {
  try {
    const url = `https://ac.finance.naver.com/ac?q=${encodeURIComponent(query)}&q_enc=UTF-8&t_koreng=1&st=111&r_lt=111&r_enc=UTF-8`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.naver.com/',
        'Accept': 'application/json',
      }
    });
    const text = await r.text();
    // 네이버 자동완성 응답 파싱 (JSONP 형태)
    const match = text.match(/\[\[.*\]\]/s);
    if (!match) return [];
    const raw = JSON.parse(match[0]);
    // raw[0] = 종목 목록, 각 항목: [코드, 이름, 시장]
    if (!raw || !raw[0]) return [];
    return raw[0].slice(0, 8).map(item => ({
      code: item[0],
      name: item[1],
      market: item[3] === '1' ? 'KOSPI' : 'KOSDAQ'
    }));
  } catch(e) {
    // fallback: 네이버 모바일 검색
    try {
      const url2 = `https://m.stock.naver.com/api/search/all?query=${encodeURIComponent(query)}&page=1&pageSize=8`;
      const r2 = await fetch(url2, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
          'Referer': 'https://m.stock.naver.com/',
        }
      });
      const d = await r2.json();
      const items = d?.result?.d || d?.stocks || [];
      return items.slice(0,8).map(i => ({
        code: i.code || i.itemCode,
        name: i.name || i.itemName,
        market: (i.market || i.stockExchangeType?.code) === 'KOSPI' ? 'KOSPI' : 'KOSDAQ'
      })).filter(i => i.code && i.name);
    } catch { return []; }
  }
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
    if (!r.ok) throw new Error('polling failed');
    const data = await r.json();
    const item = data?.result?.areas?.[0]?.datas?.[0];
    if (!item) throw new Error('no item');
    const price = parseInt(item.nv || item.sv || 0);
    if (!price) throw new Error('no price');
    const change = parseInt(item.cv || 0);
    const changeRate = parseFloat(item.cr || 0);
    const isDown = parseFloat(item.cr || 0) < 0;
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
      source: 'naver_polling',
    };
  } catch(e1) {}

  // 2차: 네이버 모바일 API
  try {
    const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.stock.naver.com/',
        'Accept': 'application/json',
      }
    });
    if (!r.ok) throw new Error('mobile failed');
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
