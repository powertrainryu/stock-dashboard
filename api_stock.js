// api/stock.js - 네이버 금융 크롤링 서버 함수
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const { code, market } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'code required' });
  }

  // 미국 주식은 Yahoo Finance 사용
  if (market === 'US') {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=1d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return res.status(404).json({ error: 'not found' });
      
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || price;
      const change = price - prev;
      
      return res.json({
        code, market: 'US',
        price: parseFloat(price.toFixed(2)),
        change: parseFloat(change.toFixed(2)),
        changeRate: parseFloat(((change/prev)*100).toFixed(2)),
        open: parseFloat((meta.regularMarketOpen||price).toFixed(2)),
        high: parseFloat((meta.regularMarketDayHigh||price).toFixed(2)),
        low: parseFloat((meta.regularMarketDayLow||price).toFixed(2)),
        volume: meta.regularMarketVolume||0,
        isUS: true,
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // 한국 주식 - 네이버 금융
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${code}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://finance.naver.com',
      }
    });
    const html = await r.text();

    // 현재가
    const priceMatch = html.match(/id="_nowVal"[^>]*>([0-9,]+)/);
    const changeMatch = html.match(/id="_change"[^>]*>([0-9,]+)/);
    const rateMatch = html.match(/id="_rate"[^>]*>\s*([0-9.]+)/);
    const signMatch = html.match(/class="(blind)"[^>]*>(상승|하락|보합)/);
    const volMatch = html.match(/id="_volume"[^>]*>([0-9,]+)/);
    const openMatch = html.match(/시가[^<]*<[^>]+>([0-9,]+)/);
    const highMatch = html.match(/고가[^<]*<[^>]+>([0-9,]+)/);
    const lowMatch = html.match(/저가[^<]*<[^>]+>([0-9,]+)/);

    if (!priceMatch) return res.status(404).json({ error: 'price not found' });

    const price = parseInt(priceMatch[1].replace(/,/g, ''));
    const change = changeMatch ? parseInt(changeMatch[1].replace(/,/g, '')) : 0;
    const rate = rateMatch ? parseFloat(rateMatch[1]) : 0;
    const isDown = signMatch && signMatch[2] === '하락';
    const volume = volMatch ? parseInt(volMatch[1].replace(/,/g, '')) : 0;
    const open = openMatch ? parseInt(openMatch[1].replace(/,/g, '')) : price;
    const high = highMatch ? parseInt(highMatch[1].replace(/,/g, '')) : price;
    const low = lowMatch ? parseInt(lowMatch[1].replace(/,/g, '')) : price;

    return res.json({
      code, market,
      price,
      change: isDown ? -change : change,
      changeRate: isDown ? -rate : rate,
      open, high, low, volume,
      isUS: false,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
