# 影片下載器 · Video Downloader

貼上連結即可下載 YouTube、Instagram、Facebook、TikTok、X 等網站影片或音檔的網頁工具。

前端是一個純靜態單頁（`index.html`），後端是一個以 `yt-dlp` 執行下載的小型 Flask 服務（`app.py`）。

---

## ⚠️ 先讀這段：為什麼不能只有 GitHub Pages

GitHub Pages 只寄存靜態檔案，**不能執行伺服器程式**。而抓取 YouTube / Instagram / Facebook 的影片需要伺服器端解碼（YouTube 的簽名、IG/FB 的登入 session），瀏覽器端做不到（CORS + 反爬 + 需要 cookies）。

所以架構是：

```
瀏覽器 (GitHub Pages 上的 index.html)
        │  POST /api/info, /api/download
        ▼
Flask + yt-dlp 後端（本機 / Render / 任何 VPS）
        │
        ▼
   影片檔（串流回瀏覽器下載）
```

部署一次後端後，把它的網址填入網頁右上角齒輪（存在 localStorage），這頁就能在任何裝置使用。

---

## 快速開始（本機，最快）

需要 Python 3.9+。

```bash
pip install -r requirements.txt
python app.py
```

開啟 <http://localhost:8000> —— 這個網址由後端直接提供頁面，前後端同源，不用任何設定就能用。

`requirements.txt` 已包含 `static-ffmpeg`，會自動帶一個 ffmpeg binary，用於合併高畫質影片＋音軌及抽取 MP3。若系統已安裝 ffmpeg 則優先使用系統版本。

---

## 部署後端（讓 GitHub Pages 上的頁面可用）

### 選項 A：Render（免費方案即可）

1. 在 Render 建立 **New → Web Service**，選 **Deploy from a Git repository**，指向本 repo。
2. Runtime 選 **Docker**（會讀 `Dockerfile`，內含 ffmpeg）。或選 Python，Build Command `pip install -r requirements.txt`、Start Command `python app.py`。
3. 部署完成後得到類似 `https://video-downloader-xxxx.onrender.com` 的網址。
4. 回到網頁右上角齒輪，貼上該網址 → 儲存。

也可以用一鍵部署：`https://render.com/deploy?repo=https://github.com/tyhcch1234/video-downloader`

> Render 免費方案的容器會休眠，第一次請求要等 30–60 秒喚醒。

### 選項 B：自己的 VPS / Docker

```bash
docker build -t video-downloader .
docker run -d -p 8000:8000 --name vd video-downloader
```

放在反向代理（Caddy / Nginx）後面並啟用 HTTPS，因為 GitHub Pages 是 https，瀏覽器不允許它呼叫 http 後端（mixed content）。

### 選項 C：Cloudflare Workers / Vercel

不建議：兩者的執行時間與檔案大小限制不適合執行 yt-dlp。

---

## 啟用 GitHub Pages（前端）

Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → Save。

網址會是 `https://tyhcch1234.github.io/video-downloader/`。

---

## Instagram / Facebook / 私人影片

IG 與 FB 幾乎所有貼文都需要登入 session，YouTube 有時會要求「確認你不是機器人」。做法：

1. 用瀏覽器擴充套件（例如 *Get cookies.txt LOCALLY*）匯出 `cookies.txt`（Netscape 格式）。
2. 把檔案放到伺服器，啟動時指定：

```bash
COOKIES_FILE=/path/to/cookies.txt python app.py
```

Render 上可把 `cookies.txt` 放進 repo 的私有分支或使用 Secret File，並設定環境變數 `COOKIES_FILE`。cookie 等同帳號憑證，**不要提交到公開 repo**（`.gitignore` 已排除）。

---

## API

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/health` | `{ok, yt_dlp, ffmpeg, cookies}` |
| POST | `/api/info` | body `{url}` → 標題、縮圖、長度、可選畫質 |
| POST | `/api/download` | body `{url, selector, audio_only}` → `{job_id}` |
| GET | `/api/progress/<job_id>` | `{status, percent, speed, eta, filename, error}` |
| GET | `/api/file/<job_id>` | 下載完成的檔案（attachment） |

環境變數：`PORT`（預設 8000）、`COOKIES_FILE`、`ALLOW_ORIGIN`（預設 `*`，可限定為你的 Pages 網域）。

---

## 已知限制

- 下載任務存在記憶體與暫存目錄，**重啟後消失**；暫存檔 2 小時後自動清除。不適合當長期雲端硬碟。
- 單一 worker 即可，但同時大量下載會受頻寬限制；Render 免費方案 CPU 較弱，4K 合併會慢。
- 只支援單一影片 URL；播放清單只會取第一條。
- 網站改版可能令 yt-dlp 失效，定期 `pip install -U yt-dlp`。

---

## 免責聲明

本工具僅供下載你有權使用的內容（自己的作品、CC 授權、已取得授權的素材）。下載受版權保護的內容可能違反該網站服務條款及當地法律，請自行判斷並承擔責任。
