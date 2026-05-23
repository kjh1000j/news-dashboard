import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';
import fs from 'fs';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'kjh1000j/news-dashboard';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const today = new Date().toLocaleDateString('ko-KR', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});

// ── 1. RSS 수집 ──
const feeds = [
  { name: 'CNN',      country: 'us', url: 'http://rss.cnn.com/rss/edition.rss' },
  { name: 'Fox News', country: 'us', url: 'https://moxie.foxnews.com/google-publisher/world.xml' },
  { name: 'NBC',      country: 'us', url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { name: 'BBC',      country: 'uk', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Sky News', country: 'uk', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
];

async function collectRSS() {
  const items = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      const xml = await res.text();
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const channel = parsed?.rss?.channel;
      const feedItems = Array.isArray(channel?.item)
        ? channel.item.slice(0, 8)
        : [channel?.item].filter(Boolean).slice(0, 8);
      feedItems.forEach(item => {
        if (item?.title) {
          const title = typeof item.title === 'object' ? (item.title._ || '') : (item.title || '');
          const link  = typeof item.link  === 'object' ? (item.link._  || '') : (item.link  || '');
          const guid  = typeof item.guid  === 'object' ? (item.guid._  || '') : (item.guid  || '');
          if (title) items.push({
            source: feed.name,
            country: feed.country,
            title: title.replace(/\n/g, ' ').trim(),
            link: link || guid || '#'
          });
        }
      });
    } catch(e) {
      console.log(feed.name + ' RSS 실패: ' + e.message);
    }
  }
  return items;
}

// ── 2. Gemini 가 안되서 grok으로 바꿈 ──
async function analyzeWithGemini(items) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const newsText = items.map((item, i) =>
    '[' + (i+1) + '][' + item.source + '] ' + item.title + ' | ' + item.link
  ).join('\n');

  const prompt = '오늘 날짜: ' + today + '\n' +
    '아래는 CNN, Fox News, NBC, BBC, Sky News 5개 채널의 실제 오늘 뉴스 헤드라인입니다.\n\n' +
    newsText + '\n\n' +
    '위 뉴스를 분석해서 아래 JSON 형식으로만 응답하세요. JSON 외 텍스트나 마크다운 코드블록은 절대 포함하지 마세요.\n\n' +
    '{"date":"' + today + '",' +
    '"stories":[{"count":5,"sources":["CNN","Fox","NBC","BBC","Sky"],"headline":"한국어헤드라인30자이내","summary":"한국어요약2문장","url":"실제URL","color":"#C04828"}],' +
    '"others":[{"text":"한국어헤드라인25자이내","src":"CNN","country":"us","url":"실제URL"}]}\n\n' +
    '규칙:\n' +
    '- stories: 2개이상 채널 동시보도, count높은순 정렬, 최소5개\n' +
    '- others: 단독보도, 최소6개\n' +
    '- color: count5→#C04828, count4→#185FA5, count3→#3B6D11, count2→#888780\n' +
    '- country: CNN/Fox/NBC→us, BBC/Sky→uk\n' +
    '- url은 위목록 실제URL만 사용\n' +
    '- 반드시 유효한 JSON만 출력';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 3000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '당신은 세계 뉴스 분석 전문가입니다. 반드시 유효한 JSON만 출력하세요.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) {
    throw new Error('Groq 응답 없음: ' + JSON.stringify(data).slice(0, 300));
  }

  const raw = data.choices[0].message.content;
  const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON 파싱 실패');
  return JSON.parse(match[0]);
}

// ── 3. HTML 생성 ──
function buildHTML(newsData) {
  let storyCards = '';
  (newsData.stories || []).forEach((s, i) => {
    const c = s.color || '#888780';
    const badges = (s.sources || []).map(b =>
      '<span class="sbadge" style="background:' + c + '18;color:' + c + '">' + b + '</span>'
    ).join('');
    storyCards += '<a class="story' + (i === 0 ? ' top' : '') + '" href="' + (s.url || '#') + '" target="_blank" rel="noopener">' +
      '<div class="story-accent" style="background:' + c + '"></div>' +
      '<div class="story-count" style="background:' + c + '">' + s.count + '</div>' +
      '<div class="story-badges">' + badges + '</div>' +
      '<div class="story-headline">' + s.headline + '</div>' +
      '<div class="story-body">' + s.summary + '</div>' +
      '<span class="story-link">↗</span></a>';
  });

  let otherCards = '';
  (newsData.others || []).forEach(o => {
    const dot = o.country === 'us' ? '#185FA5' : '#BA7517';
    otherCards += '<a class="other" href="' + (o.url || '#') + '" target="_blank" rel="noopener">' +
      '<div class="other-dot" style="background:' + dot + '"></div>' +
      '<div><div class="other-text">' + o.text + '</div>' +
      '<div class="other-src">' + o.src + ' ↗</div></div></a>';
  });

  const updatedTime = new Date().toLocaleString('ko-KR');
  const dateLabel = newsData.date || today;

  return '<!DOCTYPE html>' +
'<html lang="ko"><head>' +
'<meta charset="UTF-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>홍이의 세계 뉴스 브리핑 — ' + dateLabel + '</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f8f7f4;color:#1a1a18;min-height:100vh}' +
'.page{max-width:780px;margin:0 auto;padding:2rem 1rem 4rem}' +
'.header{text-align:center;margin-bottom:1.8rem}' +
'.hd{font-size:11px;font-weight:600;letter-spacing:.1em;color:#9c9a92;margin-bottom:5px}' +
'.ht{font-size:24px;font-weight:600;margin-bottom:5px}' +
'.hs{font-size:13px;color:#6b6b67}' +
'.channels{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-bottom:1.8rem}' +
'.ch{display:flex;align-items:center;gap:5px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}' +
'.ch-us{background:#E6F1FB;color:#0C447C}.ch-uk{background:#FAEEDA;color:#633806}' +
'.ch-dot{width:5px;height:5px;border-radius:50%}' +
'.us-dot{background:#185FA5}.uk-dot{background:#BA7517}' +
'.sec{display:flex;align-items:center;gap:10px;margin:0 0 .9rem}' +
'.sec-line{flex:1;height:1px;background:rgba(0,0,0,.1)}' +
'.sec-label{font-size:10px;font-weight:600;letter-spacing:.08em;color:#9c9a92;white-space:nowrap}' +
'.stories{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:1.8rem}' +
'.story{background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:14px;padding:10px 12px 10px 15px;position:relative;overflow:hidden;text-decoration:none;display:block;transition:transform .15s,box-shadow .15s}' +
'.story:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.08)}' +
'.story.top{grid-column:1/-1}' +
'.story-accent{position:absolute;left:0;top:0;bottom:0;width:4px}' +
'.story-count{position:absolute;top:8px;right:10px;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}' +
'.story-badges{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:5px}' +
'.sbadge{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600}' +
'.story-headline{font-size:12px;font-weight:600;color:#1a1a18;line-height:1.4;margin-bottom:3px;padding-right:26px}' +
'.story-body{font-size:10px;color:#6b6b67;line-height:1.5}' +
'.story-link{position:absolute;bottom:8px;right:10px;font-size:10px;color:#9c9a92}' +
'.others{display:grid;grid-template-columns:1fr 1fr;gap:6px}' +
'.other{display:flex;align-items:flex-start;gap:7px;background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:10px;padding:8px 11px;text-decoration:none;transition:opacity .15s}' +
'.other:hover{opacity:.75}' +
'.other-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:4px}' +
'.other-text{font-size:11px;color:#1a1a18;line-height:1.4}' +
'.other-src{font-size:9px;color:#9c9a92;margin-top:2px}' +
'.legend{display:flex;gap:12px;justify-content:center;margin-top:1.5rem;flex-wrap:wrap}' +
'.legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:#6b6b67}' +
'.legend-dot{width:7px;height:7px;border-radius:50%}' +
'.updated{text-align:center;font-size:11px;color:#9c9a92;margin-top:1rem}' +
'@media(max-width:540px){.stories,.others{grid-template-columns:1fr}.story.top{grid-column:1}}' +
'</style></head><body>' +
'<div class="page">' +
'<div class="header">' +
'<div class="hd">' + dateLabel + ' · 홍이의 세계 뉴스 브리핑</div>' +
'<div class="ht">홍이의 세계 뉴스 브리핑</div>' +
'<div class="hs">CNN · Fox News · NBC News · BBC · Sky News — 5개 채널 RSS 실시간 수집 · Gemini 요약</div>' +
'</div>' +
'<div class="channels">' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>CNN</div>' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>Fox News</div>' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>NBC News</div>' +
'<div class="ch ch-uk"><span class="ch-dot uk-dot"></span>BBC News</div>' +
'<div class="ch ch-uk"><span class="ch-dot uk-dot"></span>Sky News</div>' +
'</div>' +
'<div class="sec"><div class="sec-line"></div><div class="sec-label">중복 보도 통합 요약</div><div class="sec-line"></div></div>' +
'<div class="stories">' + storyCards + '</div>' +
'<div class="sec"><div class="sec-line"></div><div class="sec-label">단독·개별 보도</div><div class="sec-line"></div></div>' +
'<div class="others">' + otherCards + '</div>' +
'<div class="legend">' +
'<div class="legend-item"><div class="legend-dot" style="background:#C04828"></div>5개 채널</div>' +
'<div class="legend-item"><div class="legend-dot" style="background:#185FA5"></div>4개 채널</div>' +
'<div class="legend-item"><div class="legend-dot" style="background:#3B6D11"></div>3개 채널</div>' +
'<div class="legend-item"><div class="legend-dot" style="background:#888780"></div>2개 채널</div>' +
'</div>' +
'<div class="updated">마지막 업데이트: ' + updatedTime + '</div>' +
'</div></body></html>';
}

// ── 4. GitHub 업로드 ──
async function uploadToGitHub(html) {
  const apiUrl = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';
  let sha;
  const getRes = await fetch(apiUrl, {
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json'
    }
  });
  if (getRes.ok) sha = (await getRes.json()).sha;

  const uploadRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: '홍이의 세계 뉴스 브리핑 업데이트: ' + today,
      content: Buffer.from(html).toString('base64'),
      ...(sha && { sha })
    })
  });

  const data = await uploadRes.json();
  if (!uploadRes.ok) throw new Error('GitHub 업로드 실패: ' + JSON.stringify(data));
  console.log('✅ 업로드 성공! https://kjh1000j.github.io/news-dashboard');
}

// ── 실행 ──
(async () => {
  console.log('📰 뉴스 수집 시작...');
  const items = await collectRSS();
  console.log('RSS 수집 완료:', items.length + '개');

  console.log('🤖 Gemini 분석 중...');
  const newsData = await analyzeWithGemini(items);

  console.log('🎨 HTML 생성 중...');
  const html = buildHTML(newsData);

  console.log('📤 GitHub 업로드 중...');
  await uploadToGitHub(html);
})();
