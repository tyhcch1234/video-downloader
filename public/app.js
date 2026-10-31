/* VidGrab 前端邏輯 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    url: $('urlInput'),
    paste: $('pasteBtn'),
    fetch: $('fetchBtn'),
    hint: $('hint'),
    chips: $('chips'),
    banner: $('setupBanner'),
    bannerSettings: $('bannerSettings'),
    result: $('resultCard'),
    thumb: $('thumb'),
    dur: $('dur'),
    title: $('title'),
    uploader: $('uploader'),
    pills: $('qualityPills'),
    download: $('downloadBtn'),
    progressCard: $('progressCard'),
    progStatus: $('progStatus'),
    progPct: $('progPct'),
    barFill: $('barFill'),
    progFoot: $('progFoot'),
    toast: $('toast'),
    settingsBtn: $('settingsBtn'),
    dialog: $('settingsDialog'),
    apiInput: $('apiInput'),
    saveSettings: $('saveSettings'),
  };

  const STORE_KEY = 'vidgrab_api_base';
  const HOSTED_STATIC = /(^|\.)(github\.io|gitlab\.io|netlify\.app|vercel\.app|pages\.dev)$/i;

  let current = null;       // { url, platform, heights }
  let selected = null;      // { type, height }
  let polling = null;

  /* ---------------- API base ---------------- */

  function apiBase() {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) return stored.replace(/\/+$/, '');
    if (HOSTED_STATIC.test(location.hostname)) return '';
    return location.origin;
  }

  function api(path) {
    const base = apiBase();
    return (base || '') + path;
  }

  function missingBackend() {
    return !apiBase();
  }

  /* ---------------- helpers ---------------- */

  function toast(msg, ok = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('ok', ok);
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 5200);
  }

  function fmtDur(sec) {
    if (!sec || !isFinite(sec)) return '';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function detectPlatform(url) {
    if (/youtu\.?be/i.test(url)) return 'youtube';
    if (/instagram|instagr\.am/i.test(url)) return 'instagram';
    if (/facebook|fb\.watch|fb\.me/i.test(url)) return 'facebook';
    return '';
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle('loading', busy);
  }

  function highlightChips(platform) {
    [...els.chips.children].forEach((c) => {
      c.classList.toggle('active', c.dataset.plat === platform);
    });
  }

  /* ---------------- info ---------------- */

  async function fetchInfo() {
    const url = els.url.value.trim();
    if (!url) return toast('請先貼上影片連結。');
    if (missingBackend()) {
      els.banner.hidden = false;
      return toast('尚未連接後端，請先設定 API 網址。');
    }

    setBusy(els.fetch, true);
    els.result.hidden = true;
    els.progressCard.hidden = true;

    try {
      const res = await fetch(api('/api/info'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '無法取得影片資訊。');

      current = {
        url,
        platform: data.platform,
        heights: data.heights || [],
      };
      highlightChips(data.platform);

      els.title.textContent = data.title;
      els.uploader.textContent = [data.uploader, data.is_live ? '直播中' : '']
        .filter(Boolean).join(' · ');
      els.dur.textContent = fmtDur(data.duration);

      if (data.thumbnail) {
        els.thumb.src = data.thumbnail;
        els.thumb.style.display = '';
      } else {
        els.thumb.removeAttribute('src');
        els.thumb.style.display = 'none';
      }

      renderPills(data.heights || []);
      els.result.hidden = false;
      els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      toast(err.message || '發生錯誤。');
    } finally {
      setBusy(els.fetch, false);
    }
  }

  function renderPills(heights) {
    els.pills.innerHTML = '';
    const list = [];

    const top = heights[0];
    if (top) list.push({ label: `最佳 ${top}p`, type: 'video', height: top });

    heights.slice(0, 5).forEach((h) => {
      list.push({ label: `${h}p`, type: 'video', height: h });
    });

    list.push({ label: '僅音訊 MP3', type: 'audio', height: null });

    // 去重（最佳 == 第一項時只保留一次）
    const seen = new Set();
    const unique = list.filter((o) => {
      const k = `${o.type}-${o.height}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    unique.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill' + (i === 0 ? ' active' : '');
      b.textContent = o.label;
      b.onclick = () => {
        [...els.pills.children].forEach((p) => p.classList.remove('active'));
        b.classList.add('active');
        selected = { type: o.type, height: o.height };
      };
      els.pills.appendChild(b);
    });

    selected = unique[0] ? { type: unique[0].type, height: unique[0].height } : { type: 'video', height: null };
  }

  /* ---------------- download ---------------- */

  async function startDownload() {
    if (!current) return;
    if (missingBackend()) return toast('尚未連接後端。');

    setBusy(els.download, true);
    els.progressCard.hidden = false;
    els.progStatus.textContent = '建立下載任務…';
    els.progPct.textContent = '0%';
    els.barFill.style.width = '0%';
    els.progFoot.textContent = '';

    try {
      const res = await fetch(api('/api/download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: current.url,
          type: selected?.type || 'video',
          height: selected?.height || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '無法開始下載。');

      poll(data.job.id);
    } catch (err) {
      toast(err.message || '發生錯誤。');
      setBusy(els.download, false);
      els.progressCard.hidden = true;
    }
  }

  function poll(jobId) {
    clearInterval(polling);
    let fails = 0;

    const tick = async () => {
      try {
        const res = await fetch(api(`/api/job/${jobId}`), { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '任務失效。');
        fails = 0;

        const job = data.job;
        const pct = Math.max(0, Math.min(100, job.progress || 0));
        els.barFill.style.width = `${pct}%`;
        els.progPct.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;

        if (job.status === 'running') {
          els.progStatus.textContent = job.type === 'audio' ? '轉換音訊中…' : '下載中…';
          els.progFoot.textContent = [
            job.speed ? `${job.speed}` : '',
            job.eta ? `剩餘 ${job.eta}` : '',
          ].filter(Boolean).join(' · ');
        }

        if (job.status === 'done') {
          clearInterval(polling);
          els.progStatus.textContent = '完成，開始儲存…';
          els.barFill.style.width = '100%';
          els.progPct.textContent = '100%';
          els.progFoot.textContent = [job.filename, fmtSize(job.size)].filter(Boolean).join(' · ');

          const a = document.createElement('a');
          a.href = api(`/api/file/${job.id}`);
          a.download = job.filename || '';
          document.body.appendChild(a);
          a.click();
          a.remove();

          setTimeout(() => {
            setBusy(els.download, false);
            els.progressCard.hidden = true;
          }, 2600);
        }

        if (job.status === 'error') {
          clearInterval(polling);
          setBusy(els.download, false);
          els.progStatus.textContent = '下載失敗';
          els.barFill.style.width = '0%';
          els.progFoot.textContent = '';
          toast(job.error || '下載失敗。');
        }
      } catch (err) {
        if (++fails >= 4) {
          clearInterval(polling);
          setBusy(els.download, false);
          toast(err.message || '連線中斷。');
        }
      }
    };

    tick();
    polling = setInterval(tick, 900);
  }

  /* ---------------- events ---------------- */

  els.paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        els.url.value = text.trim();
        highlightChips(detectPlatform(text));
        els.url.focus();
      } else {
        els.url.focus();
      }
    } catch {
      els.url.focus();
      toast('瀏覽器不允許讀取剪貼板，請長按輸入框貼上。');
    }
  });

  els.url.addEventListener('input', () => {
    highlightChips(detectPlatform(els.url.value));
  });

  els.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fetchInfo(); }
  });

  els.fetch.addEventListener('click', fetchInfo);
  els.download.addEventListener('click', startDownload);

  els.settingsBtn.addEventListener('click', () => {
    els.apiInput.value = localStorage.getItem(STORE_KEY) || '';
    els.dialog.showModal();
  });
  els.bannerSettings.addEventListener('click', () => {
    els.apiInput.value = localStorage.getItem(STORE_KEY) || '';
    els.dialog.showModal();
  });

  els.dialog.addEventListener('close', () => {
    if (els.dialog.returnValue !== 'save') return;
    const v = els.apiInput.value.trim().replace(/\/+$/, '');
    if (v) localStorage.setItem(STORE_KEY, v);
    else localStorage.removeItem(STORE_KEY);
    els.banner.hidden = !missingBackend();
    toast(v ? '已儲存後端網址。' : '已重設為目前網域。', true);
  });

  // 初始化
  if (missingBackend()) els.banner.hidden = false;

  // 若後端可用，顯示各平台提示
  (async () => {
    if (missingBackend()) return;
    try {
      const r = await fetch(api('/api/health'), { cache: 'no-store' });
      if (r.ok) els.hint.textContent = '後端已連線 · 支援 YouTube、Instagram、Facebook。';
    } catch {
      els.hint.textContent = '無法連線後端，請檢查右上角設定。';
    }
  })();
})();
