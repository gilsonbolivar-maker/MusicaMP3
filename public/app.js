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

/* ---------- Configurações ---------- */
const settings = (() => {
  const defaults = { jamendoId: '', theme: 'auto' };
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

/* ---------- IndexedDB (biblioteca offline) ---------- */
const DB = (() => {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('musicamp3', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', mode);
      const req = fn(tx.objectStore('tracks'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    all: () => run('readonly', (s) => s.getAll()),
    keys: () => run('readonly', (s) => s.getAllKeys()),
    put: (v) => run('readwrite', (s) => s.put(v)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
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
  return {
    total: data.response.numFound,
    items: data.response.docs.map((d) => ({
      kind: 'album',
      source: 'archive',
      identifier: d.identifier,
      title: str(d.title) || d.identifier,
      artist: str(d.creator) || 'Internet Archive',
      cover: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      license: d.licenseurl || `https://archive.org/details/${d.identifier}`,
    })),
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
  return {
    total: data.headers.results_fullcount ?? data.results.length,
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
  };
}

/* ---------- Busca ---------- */
let source = 'all';
let lastQuery = '';
let pages = { archive: 1, jamendo: 1 };

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
  pages = { archive: 1, jamendo: 1 };
  document.body.classList.add('has-results');
  const box = $('#results');
  box.innerHTML = '<p class="status">Buscando…</p>';
  const wantJm = source !== 'archive';
  const wantIa = source !== 'jamendo';
  const [jm, ia] = await Promise.allSettled([
    wantJm ? searchJamendo(q) : null,
    wantIa ? searchArchive(q) : null,
  ]);
  if (q !== lastQuery) return; // busca mais nova já começou
  box.innerHTML = '';

  if (wantJm) {
    if (jm.status === 'rejected') box.append(notice(`Falha no Jamendo: ${jm.reason.message}`));
    else if (jm.value.needsKey) {
      if (source === 'jamendo') box.append(notice('Para buscar no Jamendo, adicione seu <b>Client ID</b> em <b>Configurações</b>.', true));
    } else renderSection(box, 'Jamendo', jm.value, 'jamendo');
  }
  if (wantIa) {
    if (ia.status === 'rejected') box.append(notice(`Falha no Internet Archive: ${ia.reason.message}`));
    else renderSection(box, 'Internet Archive', ia.value, 'archive');
  }
  if (!box.children.length) box.innerHTML = '<p class="status">Nenhum resultado.</p>';
}

function notice(html, isHtml) {
  const div = document.createElement('div');
  div.className = 'notice';
  if (isHtml) div.innerHTML = html; else div.textContent = html;
  return div;
}

function renderSection(box, title, result, src) {
  const sec = document.createElement('section');
  sec.innerHTML = `<h3 class="section-title">${esc(title)}</h3><ul class="list"></ul>`;
  const list = $('ul', sec);
  appendItems(list, result.items);
  if (!result.items.length) list.innerHTML = '<li class="status">Nenhum resultado.</li>';
  addMoreButton(sec, list, result, src);
  box.append(sec);
}

function addMoreButton(sec, list, result, src) {
  if (list.children.length >= result.total) return;
  const more = document.createElement('button');
  more.className = 'btn more-btn';
  more.textContent = 'Carregar mais';
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = 'Carregando…';
    try {
      pages[src] += 1;
      const next = await (src === 'archive' ? searchArchive : searchJamendo)(lastQuery, pages[src]);
      appendItems(list, next.items);
      more.remove();
      if (next.items.length) addMoreButton(sec, list, result, src);
    } catch (err) {
      toast(err.message);
      more.disabled = false;
      more.textContent = 'Carregar mais';
    }
  };
  sec.append(more);
}

function appendItems(list, items) {
  const tracks = items.filter((i) => i.kind === 'track');
  for (const item of items) {
    list.append(item.kind === 'album' ? albumRow(item) : trackRow(item, tracks));
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
  li.innerHTML = `
    <button class="meta"><b>${esc(track.title)}</b><small>${esc(track.artist)}${dur}</small></button>
    <button class="icon-btn play" aria-label="Tocar">${ICONS.play}</button>
    <button class="icon-btn dl" aria-label="Baixar">${savedIds.has(track.id) ? ICONS.check : ICONS.download}</button>`;
  li.prepend(coverImg(track.cover));
  if (savedIds.has(track.id)) $('.dl', li).classList.add('done');
  const play = () => Player.play(queue, queue.indexOf(track));
  $('.meta', li).onclick = play;
  $('.play', li).onclick = play;
  $('.dl', li).onclick = (e) => downloadTrack(track, e.currentTarget);
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

async function renderLibrary() {
  try { library = await DB.all(); }
  catch { library = []; toast('Armazenamento indisponível neste navegador'); }
  library.sort((a, b) => b.addedAt - a.addedAt);
  savedIds = new Set(library.map((t) => t.id));
  const term = $('#lib-filter').value.trim().toLowerCase();
  const shown = term ? library.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(term)) : library;
  const list = $('#library');
  list.innerHTML = '';
  $('#lib-empty').hidden = library.length > 0;
  for (const t of shown) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = t.id;
    const label = { archive: 'archive', jamendo: 'jamendo', local: 'local' }[t.source] || t.source;
    li.innerHTML = `
      <button class="meta"><b>${esc(t.title)}</b><small><span class="badge">${esc(label)}</span>${esc(t.artist)}</small></button>
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

/* ---------- Player ---------- */
const audio = $('#audio');
const Player = {
  queue: [], index: -1, shuffle: false, repeat: 'off', // off | all | one
  srcUrl: null, coverUrl: null,
  get current() { return this.queue[this.index] || null; },

  play(queue, index) {
    this.queue = queue.slice();
    this.index = index;
    this.load(true);
  },

  load(autoplay) {
    const t = this.current;
    if (!t) return;
    if (this.srcUrl) URL.revokeObjectURL(this.srcUrl);
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.srcUrl = t.blob ? URL.createObjectURL(t.blob) : null;
    this.coverUrl = t.coverBlob ? URL.createObjectURL(t.coverBlob) : null;
    audio.src = this.srcUrl || t.src;
    if (autoplay) audio.play().catch(() => {});
    this.render();
  },

  toggle() {
    if (!this.current) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    if (this.shuffle && this.queue.length > 1) {
      let i;
      do i = Math.floor(Math.random() * this.queue.length); while (i === this.index);
      this.index = i;
    } else if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else return;
    this.load(true);
  },

  prev() {
    if (audio.currentTime > 3 || this.index <= 0) { audio.currentTime = 0; return; }
    this.index--;
    this.load(true);
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
    if (t.license) lic.href = t.license;
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
    const icon = audio.paused ? ICONS.play : ICONS.pause;
    $('#mini-play').innerHTML = icon;
    $('#btn-play').innerHTML = icon;
    $('#btn-shuffle').classList.toggle('on', this.shuffle);
    $('#btn-repeat').classList.toggle('on', this.repeat !== 'off');
    $('#repeat-one').hidden = this.repeat !== 'one';
  },
};

audio.addEventListener('play', () => Player.renderState());
audio.addEventListener('pause', () => Player.renderState());
audio.addEventListener('ended', () => Player.next(true));
audio.addEventListener('error', () => {
  if (!Player.current) return;
  toast('Não foi possível tocar esta faixa');
});
audio.addEventListener('timeupdate', () => {
  const d = audio.duration;
  const pct = d ? audio.currentTime / d : 0;
  $('#mini-bar').style.width = `${pct * 100}%`;
  if (!seeking) $('#seek').value = Math.round(pct * 1000);
  $('#t-cur').textContent = fmt(audio.currentTime);
  $('#t-dur').textContent = fmt(d);
});

let seeking = false;
$('#seek').addEventListener('input', () => { seeking = true; $('#t-cur').textContent = fmt((($('#seek').value) / 1000) * audio.duration); });
$('#seek').addEventListener('change', () => {
  if (audio.duration) audio.currentTime = ($('#seek').value / 1000) * audio.duration;
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
$('#mini-open').onclick = () => { $('#full').hidden = false; };
$('#full-close').onclick = () => { $('#full').hidden = true; };

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', () => Player.prev());
  ms.setActionHandler('nexttrack', () => Player.next());
  try { ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; }); } catch { /* sem suporte */ }
}

/* ---------- Navegação ---------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$$('.nav').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));

/* ---------- Tela de configurações ---------- */
async function renderSettings() {
  $('#jamendo-id').value = settings.jamendoId;
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
