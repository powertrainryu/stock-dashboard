// api/stock.js
import iconv from 'iconv-lite';
let kisToken = null;
let kisTokenExpiry = 0;
let krxCache = null;
let krxCacheExpiry = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST = Gemini AI
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

  // 디버그
  if (debug) {
    const token = await getKISToken();
    let krxTest = null;
    try {
      const krx = await loadKRX();
      // 408470 코드의 raw HTML도 가져오기
      let rawSample = null;
      try {
        const r = await fetch('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kind.krx.co.kr/' }
        });
        const ab = await r.arrayBuffer();
        const buf = Buffer.from(ab);
        const html = (await import('iconv-lite')).default.decode(buf, 'euc-kr');
        // 408470 주변 텍스트
        const idx = html.indexOf('408470');
        if (idx > 0) rawSample = html.slice(idx - 200, idx + 400).replace(/[
	]/g, ' ');
      } catch(e2) { rawSample = e2.message; }
      krxTest = {
        total: krx.length,
        sample: krx.slice(0, 5),
        protina: krx.filter(s => s.name && s.name.includes('프로티나')),
        rawSample,
      };
    } catch(e) { krxTest = { error: e.message }; }
    return res.json({
      token_ok: !!token,
      krx: krxTest,
      env: {
        has_kis: !!process.env.KIS_APP_KEY,
        has_gemini: !!process.env.GEMINI_API_KEY,
      }
    });
  }

  // 종목 검색
  if (search) {
    const results = await searchStocks(search);
    return res.json(results);
  }

  if (!code) return res.status(400).json({ error: 'code required' });

  if (market === 'US') {
    const d = await fetchYahoo(code, true);
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

// ── KRX 전종목 로드 ──
async function loadKRX() {
  if (krxCache && Date.now() < krxCacheExpiry) return krxCache;

  const stocks = [];

  for (const searchType of ['13', '12']) {
    const market = searchType === '12' ? 'KOSPI' : 'KOSDAQ';
    try {
      const url = `https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=${searchType}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'text/html,*/*',
          'Referer': 'https://kind.krx.co.kr/',
        }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      // iconv-lite로 euc-kr 디코딩
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const html = iconv.decode(buf, 'euc-kr');

      // HTML 테이블 파싱
      const rows = html.split('</tr>');
      let first = true;
      for (const row of rows) {
        if (first) { first = false; continue; }
        const tds = [];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let tdm;
        while ((tdm = tdRe.exec(row)) !== null) {
          tds.push(tdm[1].replace(/<[^>]+>/g, '').trim());
        }
        if (tds.length >= 4 && /^\d{6}$/.test(tds[2]) && tds[3]) {
          stocks.push({ code: tds[2], name: tds[3], market });
        }
      }

      console.log(`KRX ${market}:`, stocks.filter(s => s.market === market).length);
    } catch(e) {
      console.log(`KRX ${market} error:`, e.message);
    }
  }

  if (stocks.length > 0) {
    krxCache = stocks;
    krxCacheExpiry = Date.now() + 6 * 60 * 60 * 1000;
  }
  return stocks;
}

// ── 종목 검색 ──
async function searchStocks(query) {
  const q = query.trim();

  // 1. KRX 캐시에서 종목명 검색
  if (!/^\d{5,6}$/.test(q)) {
    try {
      const krx = await loadKRX();
      const matched = krx.filter(s => s.name && s.name.includes(q)).slice(0, 8);
      if (matched.length > 0) return matched;
    } catch(e) {}
  }

  // 2. 6자리 코드 직접 입력 → 한투로 종목명 조회
  if (/^\d{5,6}$/.test(q)) {
    const code = q.padStart(6, '0');
    const token = await getKISToken();
    const APP_KEY = process.env.KIS_APP_KEY;
    const APP_SECRET = process.env.KIS_APP_SECRET;
    if (token) {
      try {
        const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PRDT_TYPE_CD=300&PDNO=${code}&PRDT_NAME=`, {
          headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': APP_KEY, 'appsecret': APP_SECRET, 'tr_id': 'CTPF1604R', 'custtype': 'P' }
        });
        const d = await r.json();
        const o = d.output;
        if (o && o.shtn_pdno) {
          return [{ code: o.shtn_pdno, name: o.prdt_abrv_name || o.prdt_name, market: o.rprs_mrkt_kor_name?.includes('KOSPI') ? 'KOSPI' : 'KOSDAQ' }];
        }
      } catch(e) {}
    }
    return [
      { code, name: `${code} (KOSPI)`, market: 'KOSPI' },
      { code, name: `${code} (KOSDAQ)`, market: 'KOSDAQ' }
    ];
  }

  // 3. 내장 주요 종목 DB
  const KR_DB = [
    {code:'005930',name:'삼성전자',market:'KOSPI'},{code:'000660',name:'SK하이닉스',market:'KOSPI'},
    {code:'035420',name:'NAVER',market:'KOSPI'},{code:'005380',name:'현대차',market:'KOSPI'},
    {code:'035720',name:'카카오',market:'KOSPI'},{code:'068270',name:'셀트리온',market:'KOSPI'},
    {code:'066570',name:'LG전자',market:'KOSPI'},{code:'006400',name:'삼성SDI',market:'KOSPI'},
    {code:'051910',name:'LG화학',market:'KOSPI'},{code:'352820',name:'하이브',market:'KOSPI'},
    {code:'042700',name:'한미반도체',market:'KOSPI'},{code:'012450',name:'한화에어로스페이스',market:'KOSPI'},
    {code:'064350',name:'현대로템',market:'KOSPI'},{code:'017670',name:'SK텔레콤',market:'KOSPI'},
    {code:'030200',name:'KT',market:'KOSPI'},{code:'000100',name:'유한양행',market:'KOSPI'},
    {code:'128940',name:'한미약품',market:'KOSPI'},{code:'036570',name:'엔씨소프트',market:'KOSPI'},
    {code:'247540',name:'에코프로비엠',market:'KOSDAQ'},{code:'086520',name:'에코프로',market:'KOSDAQ'},
    {code:'196170',name:'알테오젠',market:'KOSDAQ'},{code:'263750',name:'펄어비스',market:'KOSDAQ'},
    {code:'087010',name:'펩트론',market:'KOSDAQ'},{code:'091990',name:'셀트리온헬스케어',market:'KOSDAQ'},
    {code:'145020',name:'휴젤',market:'KOSDAQ'},{code:'214150',name:'클래시스',market:'KOSDAQ'},
    {code:'293490',name:'카카오게임즈',market:'KOSDAQ'},{code:'112040',name:'위메이드',market:'KOSDAQ'},
    {code:'277810',name:'레인보우로보틱스',market:'KOSDAQ'},{code:'141080',name:'리가켐바이오',market:'KOSDAQ'},
    {code:'267980',name:'레고켐바이오',market:'KOSDAQ'},{code:'204840',name:'지투지바이오',market:'KOSDAQ'},
    {code:'468530',name:'프로티나',market:'KOSDAQ'},{code:'100120',name:'뷰노',market:'KOSDAQ'},
    {code:'403870',name:'HPSP',market:'KOSDAQ'},{code:'310210',name:'보로노이',market:'KOSDAQ'},
    {code:'458970',name:'에이피알',market:'KOSDAQ'},{code:'382800',name:'지씨셀',market:'KOSDAQ'},
    {code:'066970',name:'엘앤에프',market:'KOSDAQ'},{code:'018290',name:'브이티',market:'KOSDAQ'},
  ];
  const local = KR_DB.filter(s => s.name.includes(q) || s.code.includes(q));
  if (local.length > 0) return local.slice(0, 8);

  // 4. 미국 주식 → Yahoo
  return await searchYahoo(q);
}

// ── Yahoo 검색 ──
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

// ── 한투 토큰 ──
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

// ── 한투 국내 주가 ──
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

// ── 네이버 fallback ──
async function fetchNaver(code, market) {
  try {
    const r = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Referer': 'https://m.finance.naver.com/' }
    });
    if (!r.ok) throw new Error('failed');
    const data = await r.json();
    const item = data?.result?.areas?.[0]?.datas?.[0];
    if (!item) throw new Error('no item');
    const price = parseInt(item.nv || item.sv || 0);
    if (!price) throw new Error('no price');
    const changeRate = parseFloat(item.cr || 0);
    const change = parseInt(item.cv || 0);
    const isDown = changeRate < 0;
    return { code, market, price, change: isDown?-Math.abs(change):Math.abs(change), changeRate: isDown?-Math.abs(changeRate):Math.abs(changeRate), open: parseInt(item.ov||price), high: parseInt(item.hv||price), low: parseInt(item.lv||price), volume: parseInt(item.tv||0), isUS: false, source: 'naver' };
  } catch(e1) {}
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Referer': 'https://m.stock.naver.com/' }
    });
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

// ── Yahoo 주가 ──
async function fetchYahoo(sym, isUS) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose || price;
    const change = price - prev;
    return { price: isUS?parseFloat(price.toFixed(2)):Math.round(price), change: isUS?parseFloat(change.toFixed(2)):Math.round(change), changeRate: parseFloat(((change/prev)*100).toFixed(2)), open: isUS?parseFloat((meta.regularMarketOpen||price).toFixed(2)):Math.round(meta.regularMarketOpen||price), high: isUS?parseFloat((meta.regularMarketDayHigh||price).toFixed(2)):Math.round(meta.regularMarketDayHigh||price), low: isUS?parseFloat((meta.regularMarketDayLow||price).toFixed(2)):Math.round(meta.regularMarketDayLow||price), volume: meta.regularMarketVolume||0, isUS, source: 'yahoo' };
  } catch(e) { return null; }
}

// ── Gemini AI ──
async function callGemini(prompt, useSearch) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return null;
  try {
    const model = useSearch ? 'gemini-2.0-flash-lite' : 'gemini-2.0-flash-lite';
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 1000 } };
    if (useSearch) body.tools = [{ google_search: {} }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch(e) { return null; }
}
