// api/stock.js - 디버그 버전
let kisToken = null;
let kisTokenExpiry = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { type, query, code, name, price, changeRate } = req.body;
    if (type === 'summary') {
      const result = await callGemini(`${name}(${code}) 주식 최근 동향을 30자 이내 한 줄로만 요약. 현재가 ${price}원, 등락률 ${changeRate}%. 딱 한 줄만: "외국인 순매수 전환, 단기 반등 가능성"`, false);
      return res.json({ result });
    }
    if (type === 'news') {
      const result = await callGemini(`"${query}" 관련 한국 주식 최신 뉴스 5개 검색 후 분석. JSON 배열만 응답. 형식: [{"title":"제목","summary":"2줄 요약","sentiment":"positive/negative/neutral","impact":"주가 영향 한줄","time":"시간"}]`, true);
      return res.json({ result });
    }
    return res.status(400).json({ error: 'invalid type' });
  }

  const { code, market, search, debug } = req.query;

  // 디버그 모드
  if (debug) {
    const log = { env: {}, token: null, error: null };
    log.env.hasKey = !!process.env.KIS_APP_KEY;
    log.env.hasSecret = !!process.env.KIS_APP_SECRET;
    log.env.hasGemini = !!process.env.GEMINI_API_KEY;
    log.env.keyPrefix = process.env.KIS_APP_KEY?.substring(0, 8);

    // 토큰 테스트
    try {
      const token = await getKISToken();
      log.token = token ? '발급성공 (' + token.substring(0,20) + '...)' : '발급실패';

      if (token) {
        // 검색 테스트
        const APP_KEY = process.env.KIS_APP_KEY;
        const APP_SECRET = process.env.KIS_APP_SECRET;

        // 실전투자 종목 검색 테스트
        const searchRes = await fetch('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PRDT_TYPE_CD=300&PDNO=005930', {
          headers: {
            'Content-Type': 'application/json',
            'authorization': `Bearer ${token}`,
            'appkey': APP_KEY,
            'appsecret': APP_SECRET,
            'tr_id': 'CTPF1604R',
            'custtype': 'P',
          }
        });
        const searchData = await searchRes.json();
        log.searchTest = { status: searchRes.status, body: JSON.stringify(searchData).substring(0, 300) };

        // 주가 조회 테스트
        const priceRes = await fetch('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930', {
          headers: {
            'Content-Type': 'application/json',
            'authorization': `Bearer ${token}`,
            'appkey': APP_KEY,
            'appsecret': APP_SECRET,
            'tr_id': 'FHKST01010100',
            'custtype': 'P',
          }
        });
        const priceData = await priceRes.json();
        log.priceTest = { status: priceRes.status, body: JSON.stringify(priceData).substring(0, 300) };
      }
    } catch(e) {
      log.error = e.message;
    }

    return res.json(log);
  }

  if (search) {
    const results = await searchStocks(search);
    return res.json(results);
  }

  if (!code) return res.status(400).json({ error: 'code required' });

  if (market === 'US') {
    const d = await fetchKIS_US(code) || await fetchYahoo(code, true);
    if (d) return res.json(d);
    return res.status(404).json({ error: 'not found' });
  }

  const kis = await fetchKIS_KR(code, market);
  if (kis) return res.json(kis);

  const naver = await fetchNaver(code, market);
  if (naver) return res.json(naver);

  const sym = market === 'KOSPI' ? code + '.KS' : code + '.KQ';
  const yahoo = await fetchYahoo(sym, false);
  if (yahoo) return res.json(yahoo);

  return res.status(404).json({ error: 'not found' });
}

// ── 종목 검색 ──
async function searchStocks(query) {
  const APP_KEY = process.env.KIS_APP_KEY;
  const APP_SECRET = process.env.KIS_APP_SECRET;
  const token = await getKISToken();
  if (!token) return [];

  // 종목명으로 검색
  try {
    const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PRDT_TYPE_CD=300&PDNO=${encodeURIComponent(query)}`, {
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${token}`,
        'appkey': APP_KEY,
        'appsecret': APP_SECRET,
        'tr_id': 'CTPF1604R',
        'custtype': 'P',
      }
    });
    const d = await r.json();
    let items = d.output || d.output1 || [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    if (items.length > 0) {
      return items.slice(0,10).map(i => ({
        code: i.shtn_pdno || i.pdno,
        name: i.prdt_abrv_name || i.prdt_name,
        market: i.mket_id_cd === '01' ? 'KOSPI' : 'KOSDAQ'
      })).filter(i => i.code && i.name);
    }
  } catch(e) {}

  // 마스터 파일 fallback
  try {
    const master = await fetchMaster();
    if (master.length > 0) {
      return master.filter(s => s.name.includes(query) || s.code.includes(query)).slice(0,10);
    }
  } catch(e) {}

  return await searchYahoo(query);
}

// 한투 종목마스터 파일
async function fetchMaster() {
  const results = [];
  for (const [market, filename] of [['KOSPI','kospi_code.mst.gz'],['KOSDAQ','kosdaq_code.mst.gz']]) {
    try {
      const r = await fetch(`https://download.koreainvestment.com/MasterFile/${filename}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!r.ok) continue;
      const ds = new DecompressionStream('gzip');
      const stream = r.body.pipeThrough(ds);
      const reader = stream.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const merged = new Uint8Array(chunks.reduce((a,c) => a+c.length, 0));
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      const text = new TextDecoder('euc-kr').decode(merged);
      text.split('\n').forEach(line => {
        if (line.length > 20) {
          const code = line.substring(0,9).trim();
          const name = line.substring(21,61).trim();
          if (code && name && /^\d{6}$/.test(code)) results.push({ code, name, market });
        }
      });
    } catch(e) {}
  }
  return results;
}

async function searchYahoo(query) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=ko-KR&region=KR&quotesCount=10&newsCount=0`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return [];
    const data = await r.json();
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    const results = [];
    for (const q of quotes) {
      if (!q.symbol) continue;
      if (q.symbol.endsWith('.KS')) results.push({ code: q.symbol.replace('.KS',''), name: q.shortname||q.symbol, market: 'KOSPI' });
      else if (q.symbol.endsWith('.KQ')) results.push({ code: q.symbol.replace('.KQ',''), name: q.shortname||q.symbol, market: 'KOSDAQ' });
      else if (!q.symbol.includes('.') && (q.quoteType==='EQUITY'||q.quoteType==='ETF')) results.push({ code: q.symbol, name: q.shortname||q.symbol, market: 'US' });
    }
    return results;
  } catch(e) { return []; }
}

async function getKISToken() {
  if (kisToken && Date.now() < kisTokenExpiry) return kisToken;
  const APP_KEY = process.env.KIS_APP_KEY;
  const APP_SECRET = process.env.KIS_APP_SECRET;
  if (!APP_KEY || !APP_SECRET) return null;
  try {
    const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET })
    });
    const d = await r.json();
    if (d.access_token) {
      kisToken = d.access_token;
      kisTokenExpiry = Date.now() + (d.expires_in * 1000) - 60000;
      return kisToken;
    }
  } catch(e) {}
  return null;
}

async function fetchKIS_KR(code, market) {
  const APP_KEY = process.env.KIS_APP_KEY;
  const APP_SECRET = process.env.KIS_APP_SECRET;
  const token = await getKISToken();
  if (!token) return null;
  try {
    const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, {
      headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': APP_KEY, 'appsecret': APP_SECRET, 'tr_id': 'FHKST01010100', 'custtype': 'P' }
    });
    const d = await r.json();
    const o = d.output;
    if (!o || !o.stck_prpr) return null;
    const price = parseInt(o.stck_prpr);
    const change = parseInt(o.prdy_vrss);
    const changeRate = parseFloat(o.prdy_ctrt);
    const isDown = o.prdy_vrss_sign === '5';
    return { code, market, price, change: isDown?-Math.abs(change):Math.abs(change), changeRate: isDown?-Math.abs(changeRate):Math.abs(changeRate), open: parseInt(o.stck_oprc||price), high: parseInt(o.stck_hgpr||price), low: parseInt(o.stck_lwpr||price), volume: parseInt(o.acml_vol||0), isUS: false, source: 'kis' };
  } catch(e) { return null; }
}

async function fetchKIS_US(code) {
  const APP_KEY = process.env.KIS_APP_KEY;
  const APP_SECRET = process.env.KIS_APP_SECRET;
  const token = await getKISToken();
  if (!token) return null;
  try {
    const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=NAS&SYMB=${code}`, {
      headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': APP_KEY, 'appsecret': APP_SECRET, 'tr_id': 'HHDFS00000300', 'custtype': 'P' }
    });
    const d = await r.json();
    const o = d.output;
    if (!o || !o.last) return null;
    return { code, market: 'US', price: parseFloat(o.last), change: parseFloat(o.diff||0), changeRate: parseFloat(o.rate||0), open: parseFloat(o.open||o.last), high: parseFloat(o.high||o.last), low: parseFloat(o.low||o.last), volume: parseInt(o.tvol||0), isUS: true, source: 'kis_us' };
  } catch(e) { return null; }
}

async function fetchNaver(code, market) {
  try {
    const r = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Referer': 'https://m.finance.naver.com/' } });
    if (!r.ok) throw new Error('failed');
    const data = await r.json();
    const item = data?.result?.areas?.[0]?.datas?.[0];
    if (!item) throw new Error('no item');
    const price = parseInt(item.nv||item.sv||0);
    if (!price) throw new Error('no price');
    const changeRate = parseFloat(item.cr||0);
    const change = parseInt(item.cv||0);
    const isDown = changeRate < 0;
    return { code, market, price, change: isDown?-Math.abs(change):Math.abs(change), changeRate: isDown?-Math.abs(changeRate):Math.abs(changeRate), open: parseInt(item.ov||price), high: parseInt(item.hv||price), low: parseInt(item.lv||price), volume: parseInt(item.tv||0), isUS: false, source: 'naver' };
  } catch(e1) {}
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Referer': 'https://m.stock.naver.com/' } });
    if (!r.ok) throw new Error('failed');
    const d = await r.json();
    const price = parseInt((d.closePrice||'0').replace(/,/g,''));
    if (!price) throw new Error('no price');
    const change = parseInt((d.compareToPreviousClosePrice||'0').replace(/,/g,''));
    const changeRate = parseFloat((d.fluctuationsRatio||'0').replace(/,/g,''));
    const isDown = d.compareToPreviousPrice?.code === '5';
    return { code, market, price, change: isDown?-Math.abs(change):Math.abs(change), changeRate: isDown?-Math.abs(changeRate):Math.abs(changeRate), open: parseInt((d.openPrice||'0').replace(/,/g,'')), high: parseInt((d.highPrice||'0').replace(/,/g,'')), low: parseInt((d.lowPrice||'0').replace(/,/g,'')), volume: parseInt((d.accumulatedTradingVolume||'0').replace(/,/g,'')), isUS: false, source: 'naver_mobile' };
  } catch(e2) {}
  return null;
}

async function fetchYahoo(sym, isUS) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose||meta.chartPreviousClose||price;
    const change = price - prev;
    return { price: isUS?parseFloat(price.toFixed(2)):Math.round(price), change: isUS?parseFloat(change.toFixed(2)):Math.round(change), changeRate: parseFloat(((change/prev)*100).toFixed(2)), open: isUS?parseFloat((meta.regularMarketOpen||price).toFixed(2)):Math.round(meta.regularMarketOpen||price), high: isUS?parseFloat((meta.regularMarketDayHigh||price).toFixed(2)):Math.round(meta.regularMarketDayHigh||price), low: isUS?parseFloat((meta.regularMarketDayLow||price).toFixed(2)):Math.round(meta.regularMarketDayLow||price), volume: meta.regularMarketVolume||0, isUS, source: 'yahoo' };
  } catch(e) { return null; }
}

async function callGemini(prompt, useSearch) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return null;
  try {
    const model = useSearch ? 'gemini-2.0-flash' : 'gemini-1.5-flash';
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 1000 } };
    if (useSearch) body.tools = [{ google_search: {} }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch(e) { return null; }
}
