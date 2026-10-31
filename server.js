'use strict';

/**
 * VidGrab — 影片下載器後端
 * 以 yt-dlp 為核心，提供 /api/info、/api/download、/api/job/:id、/api/file/:id
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES = process.env.YTDLP_COOKIES || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const JOB_TTL_MS = 30 * 60 * 1000;
const INFO_TIMEOUT_MS = 90 * 1000;

const TMP_ROOT = path.join(os.tmpdir(), 'vidgrab');
fs.mkdirSync(TMP_ROOT, { recursive: true });

/* ------------------------------------------------------------------ */
/* 允許的平台                                                          */
/* ------------------------------------------------------------------ */

const ALLOWED_PATTERNS = [
  /^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i,
  /^https?:\/\/youtu\.be\//i,
  /^https?:\/\/(?:www\.|m\.)?instagram\.com\//i,
  /^https?:\/\/instagr\.am\//i,
  /^https?:\/\/(?:www\.|m\.|web\.|mbasic\.)?facebook\.com\//i,
  /^https?:\/\/fb\.watch\//i,
  /^https?:\/\/fb\.me\//i,
];

function isAllowedUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return ALLOWED_PATTERNS.some((re) => re.test(url.href));
}

/* ------------------------------------------------------------------ */
/* yt-dlp 參數                                                         */
/* ------------------------------------------------------------------ */

function baseArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', '20',
    '--retries', '3',
    '--no-cache-dir',
  ];
  if (COOKIES && fs.existsSync(COOKIES)) args.push('--cookies', COOKIES);
  if (process.env.INSECURE === '1') args.push('--no-check-certificates');
  return args;
}

/**
 * 依使用者選擇組出 -f 參數
 */
function buildFormat({ type, height }) {
  if (type === 'audio') {
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
  const h = Number(height);
  if (Number.isFinite(h) && h > 0) {
    return [
      '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '--merge-output-format', 'mp4',
    ];
  }
  return ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', '--merge-output-format', 'mp4'];
}

/* ------------------------------------------------------------------ */
/* 任務表                                                              */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const jobs = new Map();

function createJob(url, opts) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    url,
    dir,
    status: 'queued', // queued | running | done | error
    progress: 0,
    speed: '',
    eta: '',
    title: '',
    filename: '',
    file: '',
    size: 0,
    error: '',
    createdAt: Date.now(),
    finishedAt: 0,
    proc: null,
    type: opts.type || 'video',
    height: opts.height || null,
  };
  jobs.set(id, job);
  return job;
}

function runningCount() {
  return [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    filename: job.filename,
    size: job.size,
    error: job.error,
    type: job.type,
    height: job.height,
  };
}

/* ------------------------------------------------------------------ */
/* 錯誤訊息翻譯                                                        */
/* ------------------------------------------------------------------ */

function friendlyError(stderr, platform) {
  const s = (stderr || '').toLowerCase();
  if (s.includes('sign in to confirm') || s.includes('confirm you’re not a bot') || s.includes('confirm you') && s.includes('bot')) {
    return 'YouTube 要求驗證（反機器人檢查）。請設定 cookies（YTDLP_COOKIES）後重試。';
  }
  if (s.includes('login required') || s.includes('login_required')) {
    return platform === 'instagram'
      ? 'Instagram 要求登入。請提供 cookies（見 README 的 cookies 設定）後重試。'
      : '此內容需要登入才能存取。請提供 cookies 後重試。';
  }
  if (s.includes('private')) return '這是私人內容，無法下載。';
  if (s.includes('age') && s.includes('restrict')) return '此內容有年齡限制，需要登入 cookies。';
  if (s.includes('not available in your country') || s.includes('geo')) return '此內容受到地區限制。';
  if (s.includes('unsupported url')) return '不支援這個連結，請確認是影片頁面網址。';
  if (s.includes('video unavailable') || s.includes('does not exist')) return '影片不存在或已被移除。';
  if (s.includes('requested format is not available')) return '找不到所選畫質，請改選其他畫質。';
  if (s.includes('403')) return '平台拒絕了請求（403），通常需要更新 cookies 或更新 yt-dlp。';
  if (s.includes('429') || s.includes('rate')) return '請求過於頻繁，請稍後再試。';
  return '下載失敗，請確認連結是否公開可用，或稍後再試。';
}

function platformOf(url) {
  if (/youtu\.?be/i.test(url)) return 'youtube';
  if (/instagram|instagr\.am/i.test(url)) return 'instagram';
  if (/facebook|fb\.watch|fb\.me/i.test(url)) return 'facebook';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* 應用程式                                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'vidgrab', uptime: Math.round(process.uptime()) });
});

/* ---------- 取得影片資訊 ---------- */

app.post('/api/info', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ ok: false, error: '請貼上 YouTube、Instagram 或 Facebook 的影片連結。' });
  }

  const args = [...baseArgs(), '-J', '--no-check-formats', url];
  const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  let done = false;

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    proc.kill('SIGKILL');
    res.status(504).json({ ok: false, error: '解析逾時，請稍後再試。' });
  }, INFO_TIMEOUT_MS);

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('error', (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const msg = err.code === 'ENOENT'
      ? '伺服器未安裝 yt-dlp，請先安裝（見 README）。'
      : `無法啟動下載程序：${err.message}`;
    res.status(500).json({ ok: false, error: msg });
  });

  proc.on('close', (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);

    if (code !== 0 || !stdout) {
      return res.status(422).json({ ok: false, error: friendlyError(stderr, platformOf(url)) });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return res.status(502).json({ ok: false, error: '解析回應格式失敗。' });
    }

    const formats = (data.formats || []).filter((f) => f.height && f.vcodec && f.vcodec !== 'none');
    const heights = [...new Set(formats.map((f) => f.height))]
      .filter((h) => h >= 144 && h <= 4320)
      .sort((a, b) => b - a)
      .slice(0, 8);

    const video = (data.entries && data.entries[0]) || data;

    res.json({
      ok: true,
      platform: platformOf(url),
      id: video.id || '',
      title: video.title || '未命名影片',
      uploader: video.uploader || video.channel || '',
      duration: video.duration || 0,
      thumbnail: video.thumbnail || '',
      webpage_url: video.webpage_url || url,
      is_live: !!video.is_live,
      heights,
      needsLogin: /instagram|instagr\.am/i.test(url) && !heights.length,
    });
  });
});

/* ---------- 建立下載任務 ---------- */

app.post('/api/download', (req, res) => {
  const url = String(req.body?.url || '').trim();
  const type = req.body?.type === 'audio' ? 'audio' : 'video';
  const height = Number(req.body?.height) || null;

  if (!isAllowedUrl(url)) {
    return res.status(400).json({ ok: false, error: '連結無效。' });
  }
  if (runningCount() >= MAX_CONCURRENT) {
    return res.status(429).json({ ok: false, error: '目前下載任務太多，請稍後再試。' });
  }

  const job = createJob(url, { type, height });
  const outTemplate = path.join(job.dir, '%(title).80B.%(ext)s');

  const args = [
    ...baseArgs(),
    ...buildFormat({ type, height }),
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--no-mtime',
    '-o', outTemplate,
    url,
  ];

  const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;
  job.status = 'running';

  let stderr = '';
  let buffer = '';

  const onLine = (line) => {
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)(?:\s+at\s+([\d.]+\s*[KMG]?i?B\/s))?(?:\s+ETA\s+([\d:]+))?/);
    if (m) {
      job.progress = Math.min(100, Math.round(parseFloat(m[1]) * 10) / 10);
      if (m[3]) job.speed = m[3].replace(/\s+/g, '');
      if (m[4]) job.eta = m[4];
    }
    const t = line.match(/\[download\] Destination:\s*(.+)$/);
    if (t) job.filename = path.basename(t[1].trim());
  };

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n|\r/);
    buffer = parts.pop() || '';
    parts.forEach(onLine);
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  proc.on('error', (err) => {
    job.status = 'error';
    job.error = err.code === 'ENOENT'
      ? '伺服器未安裝 yt-dlp。'
      : `無法啟動下載：${err.message}`;
    job.finishedAt = Date.now();
  });

  proc.on('close', async (code) => {
    if (code !== 0) {
      if (job.status !== 'error') {
        job.status = 'error';
        job.error = friendlyError(stderr, platformOf(url));
      }
      job.finishedAt = Date.now();
      return;
    }

    try {
      const files = await fsp.readdir(job.dir);
      const usable = [];
      for (const f of files) {
        if (f.endsWith('.part') || f.endsWith('.ytdl') || f.startsWith('.')) continue;
        const full = path.join(job.dir, f);
        const st = await fsp.stat(full);
        if (st.isFile()) usable.push({ full, name: f, size: st.size });
      }
      if (!usable.length) throw new Error('empty');
      usable.sort((a, b) => b.size - a.size);
      job.file = usable[0].full;
      job.filename = usable[0].name;
      job.size = usable[0].size;
      job.progress = 100;
      job.status = 'done';
    } catch {
      job.status = 'error';
      job.error = '下載完成但找不到輸出檔案。';
    }
    job.finishedAt = Date.now();
  });

  res.json({ ok: true, job: publicJob(job) });
});

/* ---------- 查詢任務 ---------- */

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '任務不存在或已過期。' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, job: publicJob(job) });
});

/* ---------- 取回檔案 ---------- */

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file) {
    return res.status(404).json({ ok: false, error: '檔案不存在或已過期。' });
  }
  res.download(job.file, job.filename, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

/* ---------- 清理 ---------- */

async function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const stamp = job.finishedAt || job.createdAt;
    if (now - stamp < JOB_TTL_MS) continue;
    if (job.status === 'running' || job.status === 'queued') continue;
    jobs.delete(id);
    await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }
}
setInterval(sweep, 5 * 60 * 1000).unref();

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`VidGrab listening on :${PORT}`);
});

module.exports = { app, isAllowedUrl, buildFormat };
