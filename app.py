#!/usr/bin/env python3
"""
Video Downloader — Flask + yt-dlp backend.

Serves the single-page frontend (index.html) and a small JSON API:

  GET  /api/health              -> server capability probe
  POST /api/info   {url}        -> metadata + available quality options
  POST /api/download {url, selector, audio_only}
                                -> {job_id}
  GET  /api/progress/<job_id>   -> {status, percent, speed, eta, filename, error}
  GET  /api/file/<job_id>       -> the finished file (attachment)

Run locally:
    pip install -r requirements.txt
    python app.py            # http://localhost:8000

Environment:
    PORT            port to bind (default 8000)
    COOKIES_FILE    optional path to a Netscape cookies.txt (needed for many
                    Instagram / Facebook / age-restricted YouTube posts)
    ALLOW_ORIGIN    CORS origin for the API (default "*")
"""

import os
import re
import shutil
import threading
import time
import uuid
import glob

from flask import Flask, jsonify, request, send_file, send_from_directory

import yt_dlp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORK_ROOT = os.path.join(BASE_DIR, ".downloads")
os.makedirs(WORK_ROOT, exist_ok=True)

COOKIES_FILE = os.environ.get("COOKIES_FILE", "").strip()
ALLOW_ORIGIN = os.environ.get("ALLOW_ORIGIN", "*")
FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    # optional convenience: `pip install static-ffmpeg` ships a bundled binary
    try:
        import static_ffmpeg  # type: ignore
        static_ffmpeg.add_paths()
        FFMPEG = shutil.which("ffmpeg")
    except Exception:  # noqa: BLE001
        FFMPEG = None

app = Flask(__name__, static_folder=None)

JOBS = {}
JOBS_LOCK = threading.Lock()
JOB_TTL = 60 * 60 * 2  # keep finished jobs for 2 hours


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = ALLOW_ORIGIN
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.after_request
def _after(resp):
    return cors(resp)


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def _preflight(_any):
    return ("", 204)


def base_opts():
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "nocheckcertificate": True,
        "extract_flat": False,
        "socket_timeout": 20,
        "retries": 3,
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        opts["cookiefile"] = COOKIES_FILE
    return opts


def human_size(num):
    if not num:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.1f} {unit}"
        num /= 1024.0
    return ""


def pick_best(formats, height=None, audio=False):
    """Best matching format dict, used only for size estimation."""
    best = None
    for f in formats:
        if f.get("ext") == "mhtml":
            continue
        if audio:
            if f.get("acodec") in (None, "none") or f.get("vcodec") not in (None, "none"):
                continue
        else:
            if f.get("vcodec") in (None, "none"):
                continue
            if height and f.get("height") != height:
                continue
        size = f.get("filesize") or f.get("filesize_approx") or 0
        score = (size, f.get("tbr") or 0)
        if best is None or score > (best[0], best[1]):
            best = (score[0], score[1], f)
    return best[2] if best else None


def build_options(info):
    formats = info.get("formats") or []
    heights = sorted(
        {f.get("height") for f in formats
         if f.get("vcodec") not in (None, "none") and f.get("height")},
        reverse=True,
    )
    options = []

    # progressive / best single-file first — always works, no ffmpeg needed
    options.append({
        "selector": "b/bv*+ba" if FFMPEG else "b",
        "label": "最佳畫質（自動）",
        "kind": "video",
        "note": "single file" if not FFMPEG else "best video + audio",
    })

    seen = set()
    for h in heights:
        if h in seen:
            continue
        seen.add(h)
        if h < 360:
            continue
        v = pick_best(formats, height=h)
        a = pick_best(formats, audio=True)
        size = 0
        if v:
            size += v.get("filesize") or v.get("filesize_approx") or 0
        if a:
            size += a.get("filesize") or a.get("filesize_approx") or 0
        options.append({
            "selector": (f"bv*[height<={h}]+ba/b[height<={h}]" if FFMPEG
                         else f"b[height<={h}]/b"),
            "label": f"{h}p MP4",
            "kind": "video",
            "note": human_size(size) if size else "",
        })

    opts_audio = []
    if FFMPEG:
        opts_audio.append({
            "selector": "bestaudio/best",
            "label": "MP3 音檔（320k）",
            "kind": "audio",
            "note": "extract audio",
        })
    opts_audio.append({
        "selector": "bestaudio[ext=m4a]/bestaudio/best",
        "label": "M4A 音檔",
        "kind": "audio",
        "note": "original audio stream",
    })

    # de-dupe by label
    out, labels = [], set()
    for o in options + opts_audio:
        if o["label"] in labels:
            continue
        labels.add(o["label"])
        out.append(o)
    return out


def fmt_duration(sec):
    try:
        sec = int(sec or 0)
    except Exception:
        return ""
    if not sec:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def cleanup_old_jobs():
    now = time.time()
    with JOBS_LOCK:
        dead = [k for k, v in JOBS.items() if now - v.get("created", now) > JOB_TTL]
        for k in dead:
            job = JOBS.pop(k)
            shutil.rmtree(job.get("dir", ""), ignore_errors=True)


def valid_url(u):
    return bool(re.match(r"^https?://[^\s/$.?#][^\s]*$", u or ""))


def safe_name(name, fallback="video"):
    name = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", name or "").strip(" ._")
    return (name[:120] or fallback)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "yt_dlp": yt_dlp.version.__version__,
        "ffmpeg": bool(FFMPEG),
        "cookies": bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
    })


@app.post("/api/info")
def api_info():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "請貼上影片網址"}), 400
    if not valid_url(url):
        return jsonify({"ok": False, "error": "網址格式不正確，需以 http:// 或 https:// 開頭"}), 400

    opts = base_opts()
    opts.update({"skip_download": True})
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"ok": False, "error": clean_err(str(e))}), 200
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"解析失敗：{e}"}), 200

    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]

    formats = info.get("formats") or []
    has_video = any(f.get("vcodec") not in (None, "none") for f in formats)

    return jsonify({
        "ok": True,
        "data": {
            "title": info.get("title") or "Untitled",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "duration": fmt_duration(info.get("duration")),
            "thumbnail": info.get("thumbnail")
            or (f"https://i.ytimg.com/vi/{info.get('id')}/hqdefault.jpg" if info.get("id") else ""),
            "extractor": (info.get("extractor_key") or info.get("extractor") or "").lower(),
            "webpage_url": info.get("webpage_url") or url,
            "is_video": has_video,
            "options": build_options(info) if has_video else [],
            "direct": None if has_video else (info.get("url") or ""),
            "ext": info.get("ext") or "jpg",
        },
    })


def clean_err(msg):
    msg = msg.replace("ERROR: ", "").strip()
    low = msg.lower()
    if "ffmpeg is not installed" in low:
        return "伺服器缺少 ffmpeg，無法合併影片與音軌。請改用「最佳畫質（自動）」，或在伺服器安裝 ffmpeg。"
    if "sign in to confirm" in low or "not a bot" in low or "confirm you" in low:
        return "YouTube 要求驗證（機器人檢查）。請在伺服器設定 COOKIES_FILE（匯出的 cookies.txt）後再試。"
    if "login" in low or "cookies" in low or "rate-limit" in low or "sign in" in low:
        return "這個連結需要登入（私人 / 受限內容）。請設定伺服器的 COOKIES_FILE 後再試。"
    if "private" in low:
        return "這是私人內容，無法下載。"
    if "unsupported url" in low:
        return "不支援這個網址。"
    if "not available" in low or "unavailable" in low:
        return "內容不可用（可能已刪除或有地區限制）。"
    return msg[:300]


@app.post("/api/download")
def api_download():
    cleanup_old_jobs()
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    selector = (data.get("selector") or "best").strip()
    audio_only = bool(data.get("audio_only")) or "音檔" in str(data.get("label", ""))
    if not url:
        return jsonify({"ok": False, "error": "缺少網址"}), 400
    if not valid_url(url):
        return jsonify({"ok": False, "error": "網址格式不正確"}), 400

    job_id = uuid.uuid4().hex[:12]
    job_dir = os.path.join(WORK_ROOT, job_id)
    os.makedirs(job_dir, exist_ok=True)
    job = {
        "id": job_id,
        "dir": job_dir,
        "created": time.time(),
        "status": "queued",
        "percent": 0.0,
        "speed": "",
        "eta": "",
        "filename": "",
        "path": "",
        "error": "",
        "url": url,
        "selector": selector,
        "audio_only": audio_only,
    }
    with JOBS_LOCK:
        JOBS[job_id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return jsonify({"ok": True, "job_id": job_id})


def run_job(job):
    job["status"] = "running"

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                job["percent"] = round(min(done / total * 100, 99.5), 1)
            sp = d.get("speed")
            if sp:
                job["speed"] = human_size(sp) + "/s"
            eta = d.get("eta")
            if eta:
                job["eta"] = f"{int(eta)} 秒"
        elif d.get("status") == "finished":
            job["percent"] = 99.5
            job["speed"] = ""

    opts = base_opts()
    opts.update({
        "outtmpl": os.path.join(job["dir"], "%(title).100s.%(ext)s"),
        "format": job["selector"],
        "progress_hooks": [hook],
        "concurrent_fragment_downloads": 4,
        "windowsfilenames": True,
    })
    if FFMPEG:
        opts["merge_output_format"] = "mp4"
        if job["audio_only"]:
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320",
            }]
    else:
        # no ffmpeg -> never ask for a merge-only selector
        sel = job["selector"]
        if "+" in sel:
            heights = re.findall(r"height<=(\d+)", sel)
            opts["format"] = f"b[height<={heights[0]}]/b" if heights else "b"

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([job["url"]])

        files = [
            p for p in glob.glob(os.path.join(job["dir"], "*"))
            if os.path.isfile(p) and not p.endswith((".part", ".ytdl", ".tmp"))
        ]
        if not files:
            raise RuntimeError("下載完成但找不到檔案")
        files.sort(key=os.path.getsize, reverse=True)
        path = files[0]
        job["path"] = path
        job["filename"] = os.path.basename(path)
        job["percent"] = 100.0
        job["status"] = "done"
    except yt_dlp.utils.DownloadError as e:
        job["status"] = "error"
        job["error"] = clean_err(str(e))
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(e)[:300]


@app.get("/api/progress/<job_id>")
def api_progress(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"ok": False, "error": "任務不存在或已過期"}), 404
    return jsonify({
        "ok": True,
        "status": job["status"],
        "percent": job["percent"],
        "speed": job["speed"],
        "eta": job["eta"],
        "filename": job["filename"],
        "error": job["error"],
    })


@app.get("/api/file/<job_id>")
def api_file(job_id):
    job = JOBS.get(job_id)
    if not job or job["status"] != "done" or not os.path.exists(job.get("path", "")):
        return jsonify({"ok": False, "error": "檔案未就緒"}), 404
    resp = send_file(
        job["path"],
        as_attachment=True,
        download_name=job["filename"],
        conditional=True,
    )
    return cors(resp)


# --------------------------------------------------------------------------- #
# static frontend
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:name>")
def static_files(name):
    return send_from_directory(BASE_DIR, name)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"[video-downloader] yt-dlp {yt_dlp.version.__version__} | ffmpeg={FFMPEG or 'missing'}")
    print(f"[video-downloader] http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, threaded=True)
