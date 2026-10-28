'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const ICONS = {
  play: '<svg class="ico" viewBox="0 0 24 24"><path class="fill" d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 24 24"><path class="fill" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  download: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
  list: '<svg class="ico" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  trash: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  external: '<svg class="ico" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
const NO_COVER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#f6c945"/>' +
  '<path d="M20 32a4 4 0 1 1-2-3.46V14l14-3v16a4 4 0 1 1-2-3.46V15.4l-10 2.14z" fill="#1a1a1a"/></svg>');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const str = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');
const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const parseLength = (v) => {
  if (v == null) return 0;
  if (String(v).includes(':')) return String(v).split(':').reduce((a, n) => a * 60 + Number(n), 0);
  return Number(v) || 0;
};
// A API do YouTube devolve títulos com entidades HTML (&amp;, &#39;…).
const decodeHtml = (s) => { const t = document.createElement('textarea'); t.innerHTML = s ?? ''; return t.value; };
const ytWatchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const ytSearchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

/* ---------- Configurações ---------- */
const settings = (() => {
  const defaults = { jamendoId: '', youtubeKey: '', theme: 'auto' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('mmp3-settings') || '{}') }; }
  catch { return defaults; }
})();
function saveSettings() {
  try { localStorage.setItem('mmp3-settings', JSON.stringify(settings)); } catch { /* modo privado */ }
}
function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}
applyTheme();

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

/* ---------- IndexedDB (biblioteca offline e playlists) ---------- */
const DB = (() => {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('musicamp3', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const storeApi = (store) => ({
    all: () => run(store, 'readonly', (s) => s.getAll()),
    keys: () => run(store, 'readonly', (s) => s.getAllKeys()),
    get: (id) => run(store, 'readonly', (s) => s.get(id)),
    put: (v) => run(store, 'readwrite', (s) => s.put(v)),
    del: (id) => run(store, 'readwrite', (s) => s.delete(id)),
    clear: () => run(store, 'readwrite', (s) => s.clear()),
  });
  return { ...storeApi('tracks'), playlists: storeApi('playlists') };
})();
let savedIds = new Set();
DB.keys().then((k) => { savedIds = new Set(k); }).catch(() => {});

/* ---------- Fontes ---------- */
// Só conteúdo com licença livre: Creative Commons, netlabels e shows ao vivo liberados (etree).
const IA_FILTER = '(licenseurl:(*creativecommons*) OR collection:(netlabels) OR collection:(etree))';

async function searchArchive(q, page = 1) {
  const params = new URLSearchParams({ q: `(${q}) AND mediatype:(audio) AND ${IA_FILTER}`, rows: '20', page: String(page), output: 'json' });
  ['identifier', 'title', 'creator', 'licenseurl'].forEach((f) => params.append('fl[]', f));
  params.append('sort[]', 'downloads desc');
  const res = await fetch(`https://archive.org/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Archive: HTTP ${res.status}`);
  const data = await res.json();
  const shown = page * 20;
  return {
    items: data.response.docs.map((d) => ({
      kind: 'album',
      source: 'archive',
      identifier: d.identifier,
      title: str(d.title) || d.identifier,
      artist: str(d.creator) || 'Internet Archive',
      cover: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      license: d.licenseurl || `https://archive.org/details/${d.identifier}`,
    })),
    more: shown < data.response.numFound ? () => searchArchive(q, page + 1) : null,
  };
}

async function archiveTracks(album) {
  if (album.tracks) return album.tracks;
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(album.identifier)}`);
  if (!res.ok) throw new Error(`Archive: HTTP ${res.status}`);
  const data = await res.json();
  let files = (data.files || []).filter((f) => /\.mp3$/i.test(f.name));
  // Evita duplicar a mesma faixa em versões de baixa qualidade.
  const full = files.filter((f) => !/_(32|64)kb\.mp3$/i.test(f.name));
  if (full.length) files = full;
  files.sort((a, b) => (parseInt(a.track) || 0) - (parseInt(b.track) || 0) || a.name.localeCompare(b.name));
  const path = (name) => name.split('/').map(encodeURIComponent).join('/');
  album.tracks = files.slice(0, 150).map((f) => ({
    id: `ia:${album.identifier}/${f.name}`,
    source: 'archive',
    title: f.title || f.name.replace(/^.*\//, '').replace(/\.mp3$/i, ''),
    artist: str(f.creator || f.artist) || album.artist,
    album: album.title,
    cover: album.cover,
    src: `https://archive.org/download/${encodeURIComponent(album.identifier)}/${path(f.name)}`,
    duration: parseLength(f.length),
    license: album.license,
  }));
  return album.tracks;
}

async function searchJamendo(q, page = 1) {
  if (!settings.jamendoId) return { needsKey: true, items: [] };
  const params = new URLSearchParams({
    client_id: settings.jamendoId, format: 'json', limit: '20', offset: String((page - 1) * 20),
    search: q, audioformat: 'mp32', audiodlformat: 'mp32', order: 'popularity_total', fullcount: 'true',
  });
  const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params}`);
  if (!res.ok) throw new Error(`Jamendo: HTTP ${res.status}`);
  const data = await res.json();
  if (data.headers?.status !== 'success') throw new Error(`Jamendo: ${data.headers?.error_message || 'erro'}`);
  const total = data.headers.results_fullcount ?? data.results.length;
  return {
    items: data.results.map((t) => ({
      kind: 'track',
      id: `jm:${t.id}`,
      source: 'jamendo',
      title: t.name,
      artist: t.artist_name,
      album: t.album_name,
      cover: t.image || t.album_image || '',
      src: t.audio,
      download: t.audiodownload_allowed ? t.audiodownload : null,
      duration: t.duration,
      license: t.license_ccurl,
    })),
    more: page * 20 < total ? () => searchJamendo(q, page + 1) : null,
  };
}

async function searchYouTube(q, { pageToken = '', max = 20 } = {}) {
  if (!settings.youtubeKey) return { needsKey: true, items: [] };
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: String(max),
    q, key: settings.youtubeKey, regionCode: 'BR',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') throw new Error('YouTube: cota diária esgotada, tente amanhã');
    throw new Error(`YouTube: ${data.error?.message || `HTTP ${res.status}`}`);
  }
  return {
    items: (data.items || []).map((it) => ({
      kind: 'track',
      id: `yt:${it.id.videoId}`,
      source: 'youtube',
      youtube: it.id.videoId,
      title: decodeHtml(it.snippet.title),
      artist: decodeHtml(it.snippet.channelTitle),
      cover: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '',
      license: ytWatchUrl(it.id.videoId),
    })),
    more: data.nextPageToken ? () => searchYouTube(q, { pageToken: data.nextPageToken, max }) : null,
  };
}

/* ---------- Busca ---------- */
let source = 'all';
let lastQuery = '';

$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  source = tab.dataset.source;
  if (lastQuery) runSearch(lastQuery);
}));

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  runSearch(q);
});

async function runSearch(q) {
  lastQuery = q;
  document.body.classList.add('has-results');
  const box = $('#results');
  box.innerHTML = '<p class="status">Buscando…</p>';
  const want = (s) => source === 'all' || source === s;
  const [yt, jm, ia] = await Promise.allSettled([
    want('youtube') ? searchYouTube(q) : null,
    want('jamendo') ? searchJamendo(q) : null,
    want('archive') ? searchArchive(q) : null,
  ]);
  if (q !== lastQuery) return; // busca mais nova já começou
  box.innerHTML = '';

  if (want('youtube')) {
    if (yt.status === 'rejected') box.append(notice(yt.reason.message));
    else if (yt.value.needsKey) {
      box.append(notice(`Para tocar o YouTube aqui, adicione a <b>chave de API</b> em <b>Configurações</b>. Ou <a href="${esc(ytSearchUrl(q))}" target="_blank" rel="noopener">abra a busca no YouTube ↗</a>`, true));
    } else renderSection(box, 'YouTube', yt.value);
  }
  if (want('jamendo')) {
    if (jm.status === 'rejected') box.append(notice(`Falha no Jamendo: ${jm.reason.message}`));
    else if (jm.value.needsKey) {
      if (source === 'jamendo') box.append(notice('Para buscar no Jamendo, adicione seu <b>Client ID</b> em <b>Configurações</b>.', true));
    } else renderSection(box, 'Jamendo', jm.value);
  }
  if (want('archive')) {
    if (ia.status === 'rejected') box.append(notice(`Falha no Internet Archive: ${ia.reason.message}`));
    else renderSection(box, 'Internet Archive', ia.value);
  }
  if (!box.children.length) box.innerHTML = '<p class="status">Nenhum resultado.</p>';
}

function notice(html, isHtml) {
  const div = document.createElement('div');
  div.className = 'notice';
  if (isHtml) div.innerHTML = html; else div.textContent = html;
  return div;
}

function renderSection(box, title, result) {
  const sec = document.createElement('section');
  sec.innerHTML = `<h3 class="section-title">${esc(title)}</h3><ul class="list"></ul>`;
  const list = $('ul', sec);
  const queue = [];
  appendItems(list, result.items, queue);
  if (!result.items.length) list.innerHTML = '<li class="status">Nenhum resultado.</li>';
  addMoreButton(sec, list, result.more, queue);
  box.append(sec);
}

function addMoreButton(sec, list, more, queue) {
  if (!more) return;
  const btn = document.createElement('button');
  btn.className = 'btn more-btn';
  btn.textContent = 'Carregar mais';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Carregando…';
    try {
      const next = await more();
      appendItems(list, next.items, queue);
      btn.remove();
      if (next.items.length) addMoreButton(sec, list, next.more, queue);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Carregar mais';
    }
  };
  sec.append(btn);
}

// `queue` é compartilhada pela seção, para "Carregar mais" continuar a mesma fila.
function appendItems(list, items, queue) {
  for (const item of items) {
    if (item.kind === 'album') list.append(albumRow(item));
    else { queue.push(item); list.append(trackRow(item, queue)); }
  }
}

function coverImg(url) {
  const img = document.createElement('img');
  img.className = 'cover';
  img.loading = 'lazy';
  img.alt = '';
  img.src = url || NO_COVER;
  img.onerror = () => { img.onerror = null; img.src = NO_COVER; };
  return img;
}

function trackRow(track, queue) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.id = track.id;
  const dur = track.duration ? ` · ${fmt(track.duration)}` : '';
  const action = track.youtube
    ? `<a class="icon-btn" href="${esc(ytWatchUrl(track.youtube))}" target="_blank" rel="noopener" aria-label="Abrir no YouTube">${ICONS.external}</a>`
    : `<button class="icon-btn dl" aria-label="Baixar">${savedIds.has(track.id) ? ICONS.check : ICONS.download}</button>`;
  li.innerHTML = `
    <button class="meta"><b>${esc(track.title)}</b><small>${track.youtube ? '<span class="badge">youtube</span>' : ''}${esc(track.artist)}${dur}</small></button>
    <button class="icon-btn play" aria-label="Tocar">${ICONS.play}</button>
    ${action}`;
  li.prepend(coverImg(track.cover));
  const play = () => Player.play(queue, queue.indexOf(track));
  $('.meta', li).onclick = play;
  $('.play', li).onclick = play;
  const dl = $('.dl', li);
  if (dl) {
    if (savedIds.has(track.id)) dl.classList.add('done');
    dl.onclick = (e) => downloadTrack(track, e.currentTarget);
  }
  if (Player.current?.id === track.id) li.classList.add('playing');
  return li;
}

function albumRow(album) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'item';
  row.innerHTML = `
    <button class="meta"><b>${esc(album.title)}</b><small><span class="badge">álbum</span>${esc(album.artist)}</small></button>
    <button class="icon-btn play" aria-label="Tocar álbum">${ICONS.play}</button>
    <button class="icon-btn toggle" aria-label="Ver faixas">${ICONS.list}</button>`;
  row.prepend(coverImg(album.cover));
  const tracksEl = document.createElement('ul');
  tracksEl.className = 'tracks';
  tracksEl.hidden = true;
  li.append(row, tracksEl);

  const load = async () => {
    try { return await archiveTracks(album); }
    catch (err) { toast(err.message); return null; }
  };
  const toggle = async () => {
    if (!tracksEl.hidden) { tracksEl.hidden = true; return; }
    tracksEl.hidden = false;
    if (!tracksEl.children.length) {
      tracksEl.innerHTML = '<li class="status">Carregando faixas…</li>';
      const tracks = await load();
      tracksEl.innerHTML = '';
      if (!tracks?.length) { tracksEl.innerHTML = '<li class="status">Sem faixas MP3.</li>'; return; }
      tracks.forEach((t) => tracksEl.append(trackRow(t, tracks)));
    }
  };
  $('.meta', row).onclick = toggle;
  $('.toggle', row).onclick = toggle;
  $('.play', row).onclick = async () => {
    const tracks = await load();
    if (tracks?.length) Player.play(tracks, 0);
    else if (tracks) toast('Este item não tem faixas MP3.');
  };
  return li;
}

/* ---------- Download ---------- */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.round((got / total) * 100));
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
}

const downloading = new Set();
async function downloadTrack(track, btn) {
  if (savedIds.has(track.id)) { toast('Já está em Reproduzir'); return; }
  if (downloading.has(track.id)) return;
  const url = track.download || track.src;
  if (!url) { toast('Download não permitido para esta faixa'); return; }
  downloading.add(track.id);
  btn.innerHTML = '<span class="dl-progress">0%</span>';
  try {
    const blob = await fetchWithProgress(url, (p) => { btn.innerHTML = `<span class="dl-progress">${p}%</span>`; });
    if (blob.size < 1024) throw new Error('arquivo inválido');
    let coverBlob = null;
    try {
      if (track.cover) {
        const r = await fetch(track.cover);
        if (r.ok) coverBlob = await r.blob();
      }
    } catch { /* capa é opcional */ }
    await DB.put({
      id: track.id, title: track.title, artist: track.artist, album: track.album || '',
      source: track.source, license: track.license || '', duration: track.duration || 0,
      blob: new Blob([blob], { type: 'audio/mpeg' }), coverBlob, addedAt: Date.now(),
    });
    savedIds.add(track.id);
    btn.innerHTML = ICONS.check;
    btn.classList.add('done');
    toast('Salvo em Reproduzir');
  } catch (err) {
    btn.innerHTML = ICONS.download;
    // Alguns servidores não permitem download direto pelo navegador (CORS).
    toast('Download direto bloqueado. Abrindo o arquivo…');
    const a = document.createElement('a');
    a.href = url; a.download = ''; a.target = '_blank'; a.rel = 'noopener';
    a.click();
  } finally {
    downloading.delete(track.id);
  }
}

/* ---------- Biblioteca ---------- */
let library = [];

async function loadLibrary() {
  try { library = await DB.all(); }
  catch { library = []; toast('Armazenamento indisponível neste navegador'); }
  library.sort((a, b) => b.addedAt - a.addedAt);
  savedIds = new Set(library.map((t) => t.id));
  return library;
}

async function renderLibrary() {
  await loadLibrary();
  renderPlaylists();
  const term = $('#lib-filter').value.trim().toLowerCase();
  const shown = term ? library.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(term)) : library;
  const list = $('#library');
  list.innerHTML = '';
  $('#lib-empty').hidden = library.length > 0;
  for (const t of shown) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="meta"><b>${esc(t.title)}</b><small><span class="badge">${esc(t.source)}</span>${esc(t.artist)}</small></button>
      <button class="icon-btn del" aria-label="Apagar">${ICONS.trash}</button>`;
    const img = coverImg(null);
    if (t.coverBlob) {
      const u = URL.createObjectURL(t.coverBlob);
      img.src = u;
      img.onload = () => URL.revokeObjectURL(u);
    }
    li.prepend(img);
    $('.meta', li).onclick = () => Player.play(shown, shown.indexOf(t));
    $('.del', li).onclick = async () => {
      if (!confirm(`Apagar "${t.title}"?`)) return;
      await DB.del(t.id);
      renderLibrary();
    };
    if (Player.current?.id === t.id) li.classList.add('playing');
    list.append(li);
  }
}
$('#lib-filter').addEventListener('input', renderLibrary);

$('#import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '');
    const [artist, title] = base.includes(' - ') ? base.split(/ - (.+)/) : ['Arquivo local', base];
    try {
      await DB.put({
        id: `local:${f.name}:${f.size}:${f.lastModified}`, title: title.trim(), artist: artist.trim(),
        source: 'local', license: '', duration: 0, blob: f, coverBlob: null, addedAt: Date.now(),
      });
    } catch { toast(`Não foi possível importar ${f.name}`); }
  }
  e.target.value = '';
  if (files.length) toast(`${files.length} arquivo(s) importado(s)`);
  renderLibrary();
});

/* ---------- Lista de músicas ---------- */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);

// "12- Capital inicial - Não olhe pra trás." → { artist: "Capital inicial", title: "Não olhe pra trás" }
function parseLine(line) {
  const s = line.replace(/^\s*\d+\s*[-.)º°]+\s*/, '').replace(/[\s.;,]+$/, '').trim();
  const m = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  return m ? { line: s, artist: m[1].trim(), title: m[2].trim() } : { line: s, artist: '', title: s };
}

// Procura a música entre os arquivos baixados/importados, tolerando acentos e pontuação.
function findInLibrary(entry) {
  const wantTitle = tokens(entry.title);
  const wantArtist = tokens(entry.artist);
  if (!wantTitle.length) return null;
  const coverage = (want, have) => want.filter((w) => have.has(w)).length / want.length;
  let best = null;
  let bestScore = 0;
  for (const t of library) {
    const have = new Set(tokens(`${t.title} ${t.artist}`));
    const tc = coverage(wantTitle, have);
    const ac = wantArtist.length ? coverage(wantArtist, have) : 1;
    const ok = (tc >= 0.75 && ac >= 0.5) || (tc === 1 && wantTitle.length >= 2);
    const score = tc * 2 + ac;
    if (ok && score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// Cache das buscas no YouTube, para economizar a cota diária.
const ytCache = (() => {
  let map = {};
  try { map = JSON.parse(localStorage.getItem('mmp3-ytcache') || '{}'); } catch { /* sem cache */ }
  return {
    get: (q) => map[q],
    set(q, v) {
      map[q] = v;
      const keys = Object.keys(map);
      if (keys.length > 500) delete map[keys[0]];
      try { localStorage.setItem('mmp3-ytcache', JSON.stringify(map)); } catch { /* cheio */ }
    },
  };
})();

let listEntries = [];

async function resolveEntry(entry) {
  const local = findInLibrary(entry);
  if (local) return { ...entry, match: local };
  if (!settings.youtubeKey) return { ...entry, match: null };
  const q = `${entry.artist} ${entry.title}`.trim();
  let hit = ytCache.get(norm(q));
  if (hit === undefined) {
    const res = await searchYouTube(q, { max: 1 });
    hit = res.items[0] || null;
    ytCache.set(norm(q), hit);
  }
  return { ...entry, match: hit };
}

async function runList() {
  const lines = $('#list-input').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { toast('Cole pelo menos uma música'); return; }
  const btn = $('#list-run');
  btn.disabled = true;
  await loadLibrary();
  listEntries = lines.map(parseLine);
  $('#list-summary').textContent = `Procurando… 0/${listEntries.length}`;
  renderListResults();
  let done = 0;
  let failure = null;
  // 4 buscas por vez, atualizando a tela conforme chegam.
  const queue = listEntries.map((_, i) => i);
  const worker = async () => {
    while (queue.length && !failure) {
      const i = queue.shift();
      try { listEntries[i] = await resolveEntry(listEntries[i]); }
      catch (err) { failure = err; listEntries[i] = { ...listEntries[i], match: null }; }
      listEntries[i].checked = true;
      done++;
      $('#list-summary').textContent = `Procurando… ${done}/${listEntries.length}`;
      renderListResults();
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  btn.disabled = false;
  if (failure) toast(failure.message);
  renderListResults();
}

function listQueue() {
  return listEntries.map((e) => e.match).filter(Boolean);
}

function renderListResults() {
  const ul = $('#list-results');
  ul.innerHTML = '';
  const queue = listQueue();
  listEntries.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'item';
    const q = `${e.artist} ${e.title}`.trim();
    let status;
    if (!e.checked && !e.match) status = '<small>procurando…</small>';
    else if (!e.match) status = '<small class="missing">não encontrada</small>';
    else if (e.match.youtube) status = `<small class="found">YouTube: ${esc(e.match.title)}</small>`;
    else status = '<small class="found">na sua biblioteca</small>';
    li.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="meta"><b>${esc(e.line)}</b>${status}</div>
      ${e.match ? `<button class="icon-btn play" aria-label="Tocar">${ICONS.play}</button>` : ''}
      <a class="icon-btn" href="${esc(ytSearchUrl(q))}" target="_blank" rel="noopener" aria-label="Buscar no YouTube">${ICONS.external}</a>`;
    if (e.match) {
      li.dataset.id = e.match.id;
      $('.play', li).onclick = () => Player.play(queue, queue.indexOf(e.match));
      if (Player.current?.id === e.match.id) li.classList.add('playing');
    }
    ul.append(li);
  });

  const checked = listEntries.filter((e) => e.checked || e.match).length;
  if (checked === listEntries.length && listEntries.length) {
    const found = queue.length;
    let txt = `${found} de ${listEntries.length} encontradas.`;
    if (!settings.youtubeKey && found < listEntries.length) txt += ' Adicione a chave do YouTube em Configurações para achar as outras automaticamente.';
    $('#list-summary').textContent = txt;
  }
  const ytIds = queue.filter((t) => t.youtube).map((t) => t.youtube).slice(0, 50);
  $('#list-actions').hidden = !queue.length;
  $('#list-yt').hidden = !ytIds.length;
  $('#list-yt').href = `https://www.youtube.com/watch_videos?video_ids=${ytIds.join(',')}`;
}

$('#open-list').onclick = () => showView('list');
$('#list-back').onclick = () => showView('search');
$('#list-run').onclick = runList;
$('#list-clear').onclick = () => {
  $('#list-input').value = '';
  listEntries = [];
  $('#list-summary').textContent = '';
  renderListResults();
};
$('#list-play').onclick = () => {
  const queue = listQueue();
  if (queue.length) Player.play(queue, 0);
};
$('#list-save').onclick = async () => {
  const name = prompt('Nome da playlist:', 'Minha lista');
  if (!name) return;
  // Músicas da biblioteca são salvas só pelo id (o arquivo já está guardado).
  const items = listEntries.map((e) => ({
    line: e.line, artist: e.artist, title: e.title,
    match: !e.match ? null : e.match.youtube
      ? { id: e.match.id, source: 'youtube', youtube: e.match.youtube, title: e.match.title, artist: e.match.artist, cover: e.match.cover, license: e.match.license }
      : { id: e.match.id, source: 'library' },
  }));
  await DB.playlists.put({ id: `pl:${Date.now()}`, name: name.trim(), items, createdAt: Date.now() });
  toast('Playlist salva em Reproduzir');
};

/* ---------- Playlists ---------- */
async function playlistEntries(pl) {
  await loadLibrary();
  const byId = new Map(library.map((t) => [t.id, t]));
  return pl.items.map((it) => ({
    line: it.line, artist: it.artist, title: it.title, checked: true,
    match: !it.match ? null : it.match.source === 'library' ? byId.get(it.match.id) || null : it.match,
  }));
}

async function renderPlaylists() {
  let pls = [];
  try { pls = await DB.playlists.all(); } catch { /* sem armazenamento */ }
  pls.sort((a, b) => b.createdAt - a.createdAt);
  $('#playlists-box').hidden = !pls.length;
  const ul = $('#playlists');
  ul.innerHTML = '';
  for (const pl of pls) {
    const li = document.createElement('li');
    li.className = 'item';
    const found = pl.items.filter((i) => i.match).length;
    li.innerHTML = `
      <button class="meta"><b>${esc(pl.name)}</b><small>${found} de ${pl.items.length} músicas</small></button>
      <button class="icon-btn play" aria-label="Tocar playlist">${ICONS.play}</button>
      <button class="icon-btn del" aria-label="Apagar playlist">${ICONS.trash}</button>`;
    li.prepend(coverImg(null));
    $('.meta', li).onclick = async () => {
      listEntries = await playlistEntries(pl);
      $('#list-input').value = pl.items.map((i) => i.line).join('\n');
      showView('list');
      renderListResults();
    };
    $('.play', li).onclick = async () => {
      const queue = (await playlistEntries(pl)).map((e) => e.match).filter(Boolean);
      if (queue.length) Player.play(queue, 0); else toast('Nenhuma música encontrada nesta playlist');
    };
    $('.del', li).onclick = async () => {
      if (!confirm(`Apagar a playlist "${pl.name}"?`)) return;
      await DB.playlists.del(pl.id);
      renderPlaylists();
    };
    ul.append(li);
  }
}

/* ---------- YouTube (player oficial embutido) ---------- */
const yt = { api: null, creating: null, player: null, errors: 0 };

function loadYouTubeApi() {
  return yt.api ||= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { yt.api = null; reject(new Error('Não foi possível carregar o YouTube')); };
    document.head.append(s);
  });
}

async function ytPlay(videoId) {
  const YT = await loadYouTubeApi();
  yt.creating ||= new Promise((resolve) => {
    const p = new YT.Player('yt-player', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: () => { yt.player = p; resolve(p); },
        onStateChange: onYtState,
        onError: onYtError,
      },
    });
  });
  const p = await yt.creating;
  if (Player.current?.youtube === videoId) p.loadVideoById(videoId);
}

function onYtState(e) {
  if (e.data === 1) yt.errors = 0;
  if (e.data === 0 && Player.isYt) Player.next(true);
  Player.renderState();
}

function onYtError() {
  // 101/150: o dono do vídeo não permite tocar fora do YouTube.
  yt.errors++;
  if (yt.errors > Player.queue.length) { toast('Nenhum vídeo da fila pode tocar aqui'); return; }
  toast('Este vídeo não pode tocar fora do YouTube. Pulando…');
  setTimeout(() => Player.next(true), 1200);
}

/* ---------- Player ---------- */
const audio = $('#audio');
const Player = {
  queue: [], index: -1, shuffle: false, repeat: 'off', // off | all | one
  srcUrl: null, coverUrl: null,
  get current() { return this.queue[this.index] || null; },
  get isYt() { return !!this.current?.youtube; },

  get paused() {
    if (!this.isYt) return audio.paused;
    const state = yt.player?.getPlayerState?.();
    return state !== 1 && state !== 3; // 1 = tocando, 3 = carregando
  },
  get time() { return this.isYt ? yt.player?.getCurrentTime?.() || 0 : audio.currentTime; },
  get duration() { return this.isYt ? yt.player?.getDuration?.() || 0 : audio.duration; },
  seek(sec) { if (this.isYt) yt.player?.seekTo?.(sec, true); else audio.currentTime = sec; },
  resume() { if (this.isYt) yt.player?.playVideo?.(); else audio.play().catch(() => {}); },
  pause() { if (this.isYt) yt.player?.pauseVideo?.(); else audio.pause(); },

  play(queue, index) {
    this.queue = queue.slice();
    this.index = index;
    yt.errors = 0;
    this.load();
  },

  load() {
    const t = this.current;
    if (!t) return;
    if (this.srcUrl) URL.revokeObjectURL(this.srcUrl);
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.srcUrl = null;
    this.coverUrl = t.coverBlob ? URL.createObjectURL(t.coverBlob) : null;
    if (t.youtube) {
      audio.pause();
      document.body.classList.add('yt-active');
      ytPlay(t.youtube).catch((err) => toast(err.message));
    } else {
      yt.player?.stopVideo?.();
      document.body.classList.remove('yt-active');
      this.srcUrl = t.blob ? URL.createObjectURL(t.blob) : null;
      audio.src = this.srcUrl || t.src;
      audio.play().catch(() => {});
    }
    this.render();
  },

  toggle() {
    if (!this.current) return;
    if (this.paused) this.resume(); else this.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { this.seek(0); this.resume(); return; }
    if (this.shuffle && this.queue.length > 1) {
      let i;
      do i = Math.floor(Math.random() * this.queue.length); while (i === this.index);
      this.index = i;
    } else if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else return;
    this.load();
  },

  prev() {
    if (this.time > 3 || this.index <= 0) { this.seek(0); return; }
    this.index--;
    this.load();
  },

  render() {
    const t = this.current;
    $('#mini').hidden = !t;
    if (!t) return;
    const cover = this.coverUrl || t.cover || NO_COVER;
    for (const id of ['#mini-cover', '#full-cover']) {
      const img = $(id);
      img.onerror = () => { img.onerror = null; img.src = NO_COVER; };
      img.src = cover;
    }
    $('#mini-title').textContent = $('#full-title').textContent = t.title;
    $('#mini-artist').textContent = $('#full-artist').textContent = t.artist;
    const lic = $('#full-license');
    lic.hidden = !t.license;
    if (t.license) {
      lic.href = t.license;
      lic.textContent = t.youtube ? 'Abrir no YouTube' : 'Ver licença';
    }
    $$('.item[data-id]').forEach((el) => el.classList.toggle('playing', el.dataset.id === t.id));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album || '',
        artwork: [{ src: cover, sizes: '512x512' }],
      });
    }
    this.renderState();
  },

  renderState() {
    const icon = this.paused ? ICONS.play : ICONS.pause;
    $('#mini-play').innerHTML = icon;
    $('#btn-play').innerHTML = icon;
    $('#btn-shuffle').classList.toggle('on', this.shuffle);
    $('#btn-repeat').classList.toggle('on', this.repeat !== 'off');
    $('#repeat-one').hidden = this.repeat !== 'one';
  },
};

let seeking = false;
function updateProgress() {
  const d = Player.duration;
  const cur = Player.time;
  const pct = d ? cur / d : 0;
  $('#mini-bar').style.width = `${pct * 100}%`;
  if (!seeking) {
    $('#seek').value = Math.round(pct * 1000);
    $('#t-cur').textContent = fmt(cur);
  }
  $('#t-dur').textContent = fmt(d);
}
// O player do YouTube não emite eventos de tempo; consultamos a cada meio segundo.
setInterval(() => { if (Player.isYt && yt.player) updateProgress(); }, 500);

audio.addEventListener('play', () => Player.renderState());
audio.addEventListener('pause', () => Player.renderState());
audio.addEventListener('ended', () => { if (!Player.isYt) Player.next(true); });
audio.addEventListener('error', () => {
  if (!Player.current || Player.isYt) return;
  toast('Não foi possível tocar esta faixa');
});
audio.addEventListener('timeupdate', () => { if (!Player.isYt) updateProgress(); });

$('#seek').addEventListener('input', () => { seeking = true; $('#t-cur').textContent = fmt(($('#seek').value / 1000) * Player.duration); });
$('#seek').addEventListener('change', () => {
  if (Player.duration) Player.seek(($('#seek').value / 1000) * Player.duration);
  seeking = false;
});

$('#mini-play').onclick = () => Player.toggle();
$('#btn-play').onclick = () => Player.toggle();
$('#mini-next').onclick = () => Player.next();
$('#btn-next').onclick = () => Player.next();
$('#btn-prev').onclick = () => Player.prev();
$('#btn-shuffle').onclick = () => { Player.shuffle = !Player.shuffle; Player.renderState(); };
$('#btn-repeat').onclick = () => {
  Player.repeat = { off: 'all', all: 'one', one: 'off' }[Player.repeat];
  Player.renderState();
};
$('#mini-open').onclick = () => { $('#full').hidden = false; document.body.classList.add('full-open'); };
$('#full-close').onclick = () => { $('#full').hidden = true; document.body.classList.remove('full-open'); };

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => Player.resume());
  ms.setActionHandler('pause', () => Player.pause());
  ms.setActionHandler('previoustrack', () => Player.prev());
  ms.setActionHandler('nexttrack', () => Player.next());
  try { ms.setActionHandler('seekto', (d) => Player.seek(d.seekTime)); } catch { /* sem suporte */ }
}

/* ---------- Navegação ---------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const tab = name === 'list' ? 'search' : name;
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === tab));
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$$('.nav').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));

/* ---------- Tela de configurações ---------- */
async function renderSettings() {
  $('#jamendo-id').value = settings.jamendoId;
  $('#youtube-key').value = settings.youtubeKey;
  $('#theme').value = settings.theme;
  const info = $('#storage-info');
  try {
    const n = (await DB.keys()).length;
    let txt = `${n} música(s) salva(s).`;
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      txt += ` Usando ${(usage / 1048576).toFixed(1)} MB de ${(quota / 1073741824).toFixed(1)} GB disponíveis.`;
    }
    info.textContent = txt;
  } catch { info.textContent = 'Armazenamento indisponível.'; }
}
$('#jamendo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  settings.jamendoId = $('#jamendo-id').value.trim();
  saveSettings();
  toast(settings.jamendoId ? 'Client ID salvo' : 'Client ID removido');
});
$('#youtube-form').addEventListener('submit', (e) => {
  e.preventDefault();
  settings.youtubeKey = $('#youtube-key').value.trim();
  saveSettings();
  toast(settings.youtubeKey ? 'Chave do YouTube salva' : 'Chave do YouTube removida');
});
$('#theme').addEventListener('change', (e) => {
  settings.theme = e.target.value;
  saveSettings();
  applyTheme();
});
$('#clear-lib').addEventListener('click', async () => {
  if (!confirm('Apagar todas as músicas salvas?')) return;
  await DB.clear();
  savedIds.clear();
  toast('Biblioteca apagada');
  renderSettings();
});

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Pede ao navegador para não apagar a biblioteca offline.
navigator.storage?.persist?.().catch(() => {});
