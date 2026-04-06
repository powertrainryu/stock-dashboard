// api/stock.js

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
    const { type, query, code: stockCode, name, price, changeRate } = req.body;
  const code = stockCode;
    if (type === 'summary') {
      const result = await callAI(`${name}(${code}) 주식 최근 동향을 30자 이내 한 줄로만 요약해줘. 현재가 ${price}원, 등락률 ${changeRate}%. 예시처럼 딱 한 줄만 답해: "외국인 순매수 전환, 단기 반등 가능성"`);
      return res.json({ result });
    }
    if (type === 'news') {
      // 1. 네이버 금융 종목 뉴스 가져오기 (code로)
      const newsData = await fetchNaverNews(code || query);
      if (!newsData.success || newsData.items.length === 0) {
        return res.json({ result: null, error: '뉴스를 가져올 수 없어요' });
      }
      // 2. Groq로 분석
      const newsText = newsData.items.map((n,i) =>
        `${i+1}. [${n.date}] ${n.title}`
      ).join('\n');
      const aiResult = await callAI(`다음 "${query}" 주식 뉴스들을 호재/악재 분석해줘. JSON 배열만 응답. 다른 텍스트 절대 금지. 모든 뉴스 항목 분석.
뉴스:
${newsText}

형식 (뉴스 개수만큼 모두 포함):
[{"title":"뉴스제목 그대로","summary":"1줄요약","sentiment":"positive/negative/neutral","impact":"주가영향 한줄","time":"날짜"}]`);

      // 날짜는 실제 날짜로 강제 적용, 최신순 유지
      try {
        const clean = (aiResult||'').replace(/```json|```/g,'').trim();
        const arr = JSON.parse(clean.match(/\[[\s\S]*\]/)?.[0] || '[]');
        arr.forEach((item, i) => {
          if (newsData.items[i]?.date) item.time = newsData.items[i].date;
        });
        return res.json({ result: JSON.stringify(arr) });
      } catch(e) {
        return res.json({ result: aiResult });
      }
    }
    return res.status(400).json({ error: 'invalid type' });
  }

  const { code, market, search, debug, news } = req.query;

  // 뉴스 테스트
  if (news) {
    const result = await fetchNaverNews(news);
    return res.json(result);
  }

  // 디버그
  if (debug) {
    const token = await getKISToken();
    const krx = await loadKRX();
    return res.json({
      token_ok: !!token,
      krx_total: krx.length,
      krx_sample: krx.slice(0, 3),
      krx_protina: krx.filter(s => s.name.includes('프로티나')),
      krx_samsung: krx.filter(s => s.name.includes('삼성전자')),
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

// ── KRX 전종목 데이터 ──
let KRX_STOCKS = null;

async function getKRXStocks() {
  if (KRX_STOCKS) return KRX_STOCKS;
  try {
    const r = await fetch('https://raw.githubusercontent.com/powertrainryu/stock-dashboard/main/stocks.json');
    if (r.ok) {
      KRX_STOCKS = await r.json();
      console.log('KRX loaded:', KRX_STOCKS.length);
    }
  } catch(e) {
    console.log('KRX load error:', e.message);
    KRX_STOCKS = [];
  }
  return KRX_STOCKS || [];
}

async function loadKRX() {
  return await getKRXStocks();
}

// ── 종목 검색 ──
async function searchStocks(query) {
  const q = query.trim();

  // 1. KRX 캐시에서 종목명 검색
  if (!/^\d{5,6}$/.test(q)) {
    const krx = await loadKRX();
    if (krx.length > 0) {
      const matched = krx.filter(s => s.name && s.name.includes(q)).slice(0, 8);
      if (matched.length > 0) return matched;
    }
  }

  // 2. 코드 직접 입력 → 한투로 종목명 조회
  if (/^\d{5,6}$/.test(q)) {
    const code = q.padStart(6, '0');
    const token = await getKISToken();
    if (token) {
      try {
        const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PRDT_TYPE_CD=300&PDNO=${code}&PRDT_NAME=`, {
          headers: {
            'Content-Type': 'application/json',
            'authorization': `Bearer ${token}`,
            'appkey': process.env.KIS_APP_KEY,
            'appsecret': process.env.KIS_APP_SECRET,
            'tr_id': 'CTPF1604R',
            'custtype': 'P'
          }
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

  // 3. 내장 주요 종목
  const KR_DB = [
    {code:'005930',name:'삼성전자',market:'KOSPI'},{code:'000660',name:'SK하이닉스',market:'KOSPI'},
    {code:'035420',name:'NAVER',market:'KOSPI'},{code:'005380',name:'현대차',market:'KOSPI'},
    {code:'035720',name:'카카오',market:'KOSPI'},{code:'068270',name:'셀트리온',market:'KOSPI'},
    {code:'066570',name:'LG전자',market:'KOSPI'},{code:'006400',name:'삼성SDI',market:'KOSPI'},
    {code:'051910',name:'LG화학',market:'KOSPI'},{code:'352820',name:'하이브',market:'KOSPI'},
    {code:'042700',name:'한미반도체',market:'KOSPI'},{code:'012450',name:'한화에어로스페이스',market:'KOSPI'},
    {code:'017670',name:'SK텔레콤',market:'KOSPI'},{code:'030200',name:'KT',market:'KOSPI'},
    {code:'247540',name:'에코프로비엠',market:'KOSDAQ'},{code:'086520',name:'에코프로',market:'KOSDAQ'},
    {code:'196170',name:'알테오젠',market:'KOSDAQ'},{code:'087010',name:'펩트론',market:'KOSDAQ'},
    {code:'204840',name:'지투지바이오',market:'KOSDAQ'},{code:'468530',name:'프로티나',market:'KOSDAQ'},
    {code:'277810',name:'레인보우로보틱스',market:'KOSDAQ'},{code:'141080',name:'리가켐바이오',market:'KOSDAQ'},
  ];
  const local = KR_DB.filter(s => s.name.includes(q));
  if (local.length > 0) return local.slice(0, 8);

  // 4. 미국 주식 → Yahoo
  return await searchYahoo(q);
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
  const token = await getKISToken();
  if (!token) return null;
  try {
    const r = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, {
      headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': process.env.KIS_APP_KEY, 'appsecret': process.env.KIS_APP_SECRET, 'tr_id': 'FHKST01010100', 'custtype': 'P' }
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

// ── 네이버 뉴스 가져오기 ──
async function fetchNaverNews(codeOrQuery) {
  const isCode = /^\d{6}$/.test(codeOrQuery);
  const items = [];

  // Google News RSS - Vercel에서 접근 가능
  try {
    const searchQ = isCode ? codeOrQuery : codeOrQuery;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQ + ' 주식')}&hl=ko&gl=KR&ceid=KR:ko`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, */*',
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    console.log('Google RSS status:', r.status, 'length:', xml.length);

    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null && items.length < 20) {
      const block = m[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1]
        ?.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim();
      if (title && !title.includes('Google')) {
        let date = '최근';
        if (pubDate) {
          const d = new Date(pubDate);
          if (!isNaN(d)) {
            const now = new Date();
            const diff = now - d;
            const mins = Math.floor(diff/60000);
            const hours = Math.floor(diff/3600000);
            const days = Math.floor(diff/86400000);
            if (mins < 60) date = `${mins}분 전`;
            else if (hours < 24) date = `${hours}시간 전`;
            else if (days < 7) date = `${days}일 전`;
            else date = d.toLocaleDateString('ko-KR', {year:'numeric',month:'2-digit',day:'2-digit'}).replace(/\. /g,'.').replace(/\.$/,'');
          }
        }
        items.push({ title, date, _ts: pubDate ? new Date(pubDate).getTime() : 0 });
      }
    }
    console.log('Google News items:', items.length, items.map(i=>i.date));
  } catch(e) {
    console.log('Google News RSS error:', e.message);
  }

  // 최신순 정렬
  items.sort((a, b) => {
    if (a._ts && b._ts) return b._ts - a._ts;
    return 0;
  });
  // _ts 필드 제거 (클라이언트에 불필요)
  items.forEach(i => delete i._ts);

  return { success: items.length > 0, items, count: items.length };
}

async function callAI(prompt) {
  // 1순위: Groq (무료, 빠름)
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
          temperature: 0.7,
        })
      });
      if (r.ok) {
        const data = await r.json();
        const txt = data.choices?.[0]?.message?.content?.trim();
        if (txt) return txt;
      }
    } catch(e) { console.log('Groq error:', e.message); }
  }

  // 2순위: Gemini fallback
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (GEMINI_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
        })
      });
      if (r.ok) {
        const data = await r.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      }
    } catch(e) { console.log('Gemini error:', e.message); }
  }

  return null;
}
