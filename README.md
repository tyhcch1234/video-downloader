# VidGrab · 影片下載器

貼上連結即可下載 **YouTube / Instagram / Facebook** 影片的網頁工具。

前端是純靜態頁面（可放 GitHub Pages），後端用 `yt-dlp` 處理實際下載。

---

## 為什麼需要後端？

瀏覽器基於 CORS 與同源政策，**無法**直接向 YouTube / Instagram / Facebook 取得影片串流位址；
YouTube 還有簽章驗證、IG/FB 需要登入狀態。這些都必須由伺服器完成。

所以架構是：

```
瀏覽器 (GitHub Pages / 任意靜態空間)
        │  fetch /api/*
        ▼
Node.js 後端 (Docker + yt-dlp + ffmpeg)
        │  yt-dlp
        ▼
YouTube / Instagram / Facebook
```

---

## 專案結構

```
video-downloader/
├── public/              前端（可直接丟 GitHub Pages）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server.js            後端 API
├── package.json
├── Dockerfile           含 yt-dlp + ffmpeg
├── render.yaml          Render 一鍵部署設定
└── README.md
```

---

## 本機執行

需要先安裝 `yt-dlp` 與 `ffmpeg`。

```bash
# macOS
brew install yt-dlp ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg python3-pip
sudo pip3 install -U yt-dlp
```

然後：

```bash
npm install
npm start
# 開啟 http://localhost:8080
```

---

## 部署後端（免費方案：Render）

1. 用 GitHub 帳號登入 [Render](https://render.com)。
2. **New → Blueprint**，選擇這個 repo，Render 會自動讀取 `render.yaml`。
3. 等建置完成，取得網址，例如 `https://vidgrab-xxxx.onrender.com`。
4. 開啟該網址，前端與 API 同源，直接可用。

> Render 免費方案閒置一段時間會休眠，第一次開啟需等約 30 秒喚醒。

其他平台（Railway / Fly.io / 自己的 VPS）也可用，重點是**執行環境要有 `yt-dlp` 與 `ffmpeg`**。

---

## 部署前端（GitHub Pages）

若後端部署在別的地方，前端可用 GitHub Pages：

1. Repo → **Settings → Pages**
2. **Source** 選 `Deploy from a branch`，Branch 選 `main`，Folder 選 **`/public`**
3. 開啟 `https://<你的帳號>.github.io/video-downloader/`
4. 點右上角 ⚙️，把 **API 網址** 填成後端網址（例如 `https://vidgrab-xxxx.onrender.com`）
5. 儲存後即可使用（設定存在瀏覽器 localStorage）

---

## API

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/api/health` | 健康檢查 |
| `POST` | `/api/info` | `{ url }` → 標題、縮圖、長度、可用畫質 |
| `POST` | `/api/download` | `{ url, type, height }` → 建立任務，回傳 `jobId` |
| `GET` | `/api/job/:id` | 查詢進度（百分比、速度、剩餘時間） |
| `GET` | `/api/file/:id` | 下載完成的檔案 |

`type` 為 `video` 或 `audio`；`height` 為 `1080`、`720` 等，`null` 表示最佳畫質。

---

## Instagram / Facebook 需要登入時

IG 與 FB 多數內容要求登入。匯出 cookies 後掛載給後端：

1. 用瀏覽器擴充套件（例如 *Get cookies.txt LOCALLY*）登入後匯出 `cookies.txt`
2. 把檔案放到伺服器，設定環境變數：

```bash
YTDLP_COOKIES=/app/cookies.txt
```

Docker 部署時可用 volume 掛載，或把 cookies 內容存成 Secret 再寫入檔案。

> ⚠️ cookies 等於你的登入憑證，**切勿 commit 到 repo**（`.gitignore` 已排除）。

---

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8080` | 監聽埠 |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp 執行檔路徑 |
| `YTDLP_COOKIES` | — | cookies.txt 路徑 |
| `CORS_ORIGIN` | `*` | 允許的前端來源，多個用逗號分隔 |
| `MAX_CONCURRENT` | `4` | 同時下載任務上限 |
| `INSECURE` | — | 設 `1` 可略過憑證檢查（不建議） |

---

## 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| `Sign in to confirm you're not a bot` | YouTube 反機器人驗證，需設定 cookies，或更新 yt-dlp |
| `Unable to extract` / 突然全部失敗 | 平台改版，執行 `yt-dlp -U` 或重新 build image |
| IG 貼文下載失敗 | 需要登入 cookies，且只支援公開內容 |
| 只有畫面沒有聲音 | 缺少 ffmpeg，裝上即可自動合併 |
| Render 首次很慢 | 免費方案冷啟動，屬正常 |

---

## 免責聲明

本工具僅供下載**你擁有著作權**或**已獲授權**的內容（例如自己的作品、公眾領域素材、平台明確允許下載的影片）。
請遵守各平台的服務條款與當地著作權法規。使用者需自行承擔使用責任。
