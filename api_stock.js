// api/stock.js
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

// 종목 검색 - 여러 소스 시도
async function searchStocks(query) {
  // 1차: KIS 한국투자증권 공공 API (인증 불필요)
  try {
    const url = `https://m.stock.naver.com/api/search/all?query=${encodeURIComponent(query)}&page=1&pageSize=10`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://m.stock.naver.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Origin': 'https://m.stock.naver.com',
      }
    });
    if (!r.ok) throw new Error('naver search failed: ' + r.status);
    const d = await r.json();
    // 응답 구조 탐색
    const items = d?.result?.d || d?.result?.items || d?.stocks || d?.items || [];
    if (items.length > 0) {
      return items.slice(0,8).map(i => ({
        code: i.code || i.itemCode || i.symbolCode,
        name: i.name || i.itemName || i.korName,
        market: getMarket(i.market || i.stockExchangeType?.code || i.marketType)
      })).filter(i => i.code && i.name);
    }
    throw new Error('no items');
  } catch(e1) {}

  // 2차: 다음 금융 자동완성
  try {
    const url = `https://finance.daum.net/api/search/completion?term=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.daum.net/',
        'Accept': 'application/json, text/javascript, */*',
      }
    });
    if (!r.ok) throw new Error('daum failed');
    const d = await r.json();
    const items = d?.data || d?.result || d || [];
    return (Array.isArray(items) ? items : []).slice(0,8).map(i => ({
      code: i.symbolCode?.replace('A','') || i.code,
      name: i.name || i.korName,
      market: getMarket(i.exchange || i.market)
    })).filter(i => i.code && i.name);
  } catch(e2) {}

  // 3차: KRX 한국거래소 공공 API
  try {
    const url = `https://data.krx.co.kr/comm/bldAttendant/executeForResourceBundle.cmd?browserCheckOverride=false&lang=ko&code=dbms/MDC/STAT/standard/MDCSTAT01901&name=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://data.krx.co.kr/',
      }
    });
    if (!r.ok) throw new Error('krx failed');
    const d = await r.json();
    const items = d?.OutBlock_1 || [];
    return items.slice(0,8).map(i => ({
      code: i.ISU_SRT_CD,
      name: i.ISU_ABBRV,
      market: i.MKT_NM === 'KOSPI' ? 'KOSPI' : 'KOSDAQ'
    })).filter(i => i.code && i.name);
  } catch(e3) {}

  return [];
}

function getMarket(raw) {
  if (!raw) return 'KOSDAQ';
  const s = String(raw).toUpperCase();
  if (s.includes('KOSPI') || s === 'KSE' || s === 'STOCKMARKET') return 'KOSPI';
  return 'KOSDAQ';
}

async function fetchNaver(code, market) {
  try {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.finance.naver.com/',
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
    const isDown = changeRate < 0;
    return {
      code, market,
      price,
      change: isDown ? -Math.abs(change) : Math.abs(change),
      changeRate: isDown ? -Math.abs(changeRate) : Math.abs(changeRate),
      open: parseInt(item.ov || price),
      high: parseInt(item.hv || price),
      low: parseInt(item.lv || price),
      volume: parseInt(item.tv || 0),
      isUS: false, source: 'naver',
    };
  } catch(e1) {}

  try {
    const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://m.stock.naver.com/',
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
      code, market, price,
      change: isDown ? -Math.abs(change) : Math.abs(change),
      changeRate: isDown ? -Math.abs(changeRate) : Math.abs(changeRate),
      open: parseInt((d.openPrice || '0').replace(/,/g, '')),
      high: parseInt((d.highPrice || '0').replace(/,/g, '')),
      low: parseInt((d.lowPrice || '0').replace(/,/g, '')),
      volume: parseInt((d.accumulatedTradingVolume || '0').replace(/,/g, '')),
      isUS: false, source: 'naver_mobile',
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
      isUS, source: 'yahoo',
    };
  } catch(e) { return null; }
}
