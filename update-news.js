import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'kjh1000j/news-dashboard';

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

// ── 2. MyMemory 번역 ──
async function translate(text) {
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(text) + '&langpair=en|ko';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data?.responseData?.translatedText || text;
  } catch(e) {
    return text;
  }
}

// ── 3. 중복 분석 ──
function analyzeStories(items) {
  const used = new Set();
  const stories = [];
  const others = [];

  // 소스별로 그룹핑
  const bySource = {};
  items.forEach(item => {
    if (!bySource[item.source]) bySource[item.source] = [];
    bySource[item.source].push(item);
  });

  // 핵심 키워드 추출 (3글자 이상 단어)
  function getKeywords(title) {
    return title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(' ')
      .filter(w => w.length >= 3);
  }

  // 두 제목의 공통 키워드 수 계산
  function commonKeywords(t1, t2) {
    const k1 = new Set(getKeywords(t1));
    const k2 = new Set(getKeywords(t2));
    let count = 0;
    k1.forEach(k => { if (k2.has(k)) count++; });
    return count;
  }

  // 모든 아이템 쌍 비교해서 중복 그룹 찾기
  const groups = [];
  items.forEach((item, i) => {
    if (used.has(i)) return;
    const group = { items: [item], sources: new Set([item.source]) };
    items.forEach((other, j) => {
      if (i === j || used.has(j)) return;
      if (item.source === other.source) return;
      if (commonKeywords(item.title, other.title) >= 2) {
        group.items.push(other);
        group.sources.add(other.source);
        used.add(j);
      }
    });
    if (group.sources.size >= 2) {
      used.add(i);
      groups.push(group);
    }
  });

  // 그룹을 stories로 변환
  groups.forEach(group => {
    stories.push({
      count: group.sources.size,
      sources: [...group.sources],
      title: group.items[0].title,
      link: group.items[0].link,
      country: group.items[0].country
    });
  });

  stories.sort((a, b) => b.count - a.count);

  // 나머지는 others
  items.forEach((item, i) => {
    if (!used.has(i)) others.push(item);
  });

  return { stories: stories.slice(0, 8), others: others.slice(0, 8) };
}

// ── 4. HTML 생성 ──
async function buildHTML(stories, others) {
  const colors = { 5: '#C04828', 4: '#185FA5', 3: '#3B6D11', 2: '#888780' };

  let storyCards = '';
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const c = colors[s.count] || '#888780';
    const koTitle = await translate(s.title);
    const badges = s.sources.map(b =>
      '<span class="sbadge" style="background:' + c + '18;color:' + c + '">' + b + '</span>'
    ).join('');
    storyCards += '<a class="story' + (i === 0 ? ' top' : '') + '" href="' + s.link + '" target="_blank" rel="noopener">' +
      '<div class="story-accent" style="background:' + c + '"></div>' +
      '<div class="story-count" style="background:' + c + '">' + s.count + '</div>' +
      '<div class="story-badges">' + badges + '</div>' +
      '<div class="story-headline">' + koTitle + '</div>' +
      '<div class="story-orig">' + s.title + '</div>' +
      '<span class="story-link">↗</span></a>';
  }

  let otherCards = '';
  for (const o of others) {
    const dot = o.country === 'us' ? '#185FA5' : '#BA7517';
    const koTitle = await translate(o.title);
    otherCards += '<a class="other" href="' + o.link + '" target="_blank" rel="noopener">' +
      '<div class="other-dot" style="background:' + dot + '"></div>' +
      '<div><div class="other-text">' + koTitle + '</div>' +
      '<div class="other-orig">' + o.title + '</div>' +
      '<div class="other-src">' + o.source + ' ↗</div></div></a>';
  }

  const updatedTime = new Date().toLocaleString('ko-KR');

  return '<!DOCTYPE html>' +
'<html lang="ko"><head>' +
'<meta charset="UTF-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>홍이의 세계 뉴스 브리핑 — ' + today + '</title>' +
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
'.story-headline{font-size:12px;font-weight:600;color:#1a1a18;line-height:1.4;margin-bottom:2px;padding-right:26px}' +
'.story-orig{font-size:10px;color:#9c9a92;line-height:1.4;margin-bottom:3px;font-style:italic}' +
'.story-link{position:absolute;bottom:8px;right:10px;font-size:10px;color:#9c9a92}' +
'.others{display:grid;grid-template-columns:1fr 1fr;gap:6px}' +
'.other{display:flex;align-items:flex-start;gap:7px;background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:10px;padding:8px 11px;text-decoration:none;transition:opacity .15s}' +
'.other:hover{opacity:.75}' +
'.other-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:4px}' +
'.other-text{font-size:11px;color:#1a1a18;line-height:1.4}' +
'.other-orig{font-size:9px;color:#9c9a92;margin-top:1px;font-style:italic}' +
'.other-src{font-size:9px;color:#9c9a92;margin-top:2px}' +
'.legend{display:flex;gap:12px;justify-content:center;margin-top:1.5rem;flex-wrap:wrap}' +
'.legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:#6b6b67}' +
'.legend-dot{width:7px;height:7px;border-radius:50%}' +
'.updated{text-align:center;font-size:11px;color:#9c9a92;margin-top:1rem}' +
'@media(max-width:540px){.stories,.others{grid-template-columns:1fr}.story.top{grid-column:1}}' +
'</style></head><body>' +
'<div class="page">' +
'<div class="header">' +
'<div class="hd">' + today + ' · 홍이의 세계 뉴스 브리핑</div>' +
'<div class="ht">홍이의 세계 뉴스 브리핑</div>' +
'<div class="hs">CNN · Fox News · NBC News · BBC · Sky News — 5개 채널 RSS 실시간 수집 · MyMemory 번역</div>' +
'</div>' +
'<div class="channels">' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>CNN</div>' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>Fox News</div>' +
'<div class="ch ch-us"><span class="ch-dot us-dot"></span>NBC News</div>' +
'<div class="ch ch-uk"><span class="ch-dot uk-dot"></span>BBC News</div>' +
'<div class="ch ch-uk"><span class="ch-dot uk-dot"></span>Sky News</div>' +
'</div>' +
'<div class="sec"><div class="sec-line"></div><div class="sec-label">중복 보도 통합</div><div class="sec-line"></div></div>' +
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

// ── 5. GitHub 업로드 ──
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

  console.log('🔍 중복 분석 중...');
  const { stories, others } = analyzeStories(items);
  console.log('중복 뉴스:', stories.length + '개, 단독:', others.length + '개');

  console.log('🌐 번역 및 HTML 생성 중...');
  const html = await buildHTML(stories, others);

  console.log('📤 GitHub 업로드 중...');
  await uploadToGitHub(html);
})();
