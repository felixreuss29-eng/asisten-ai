# Asisten AI Suara & Teks (Model Open Source)

Asisten AI pribadi yang bisa diajak ngobrol lewat **teks** maupun **suara**, dan **benar-benar mengerjakan perintah** lewat tool calling. Semua jawaban berasal dari model open source melalui panggilan API sungguhan — **tidak ada jawaban dummy / hardcoded**.

Backend memakai format API yang kompatibel dengan OpenAI (`/v1/chat/completions`), jadi penyedia bisa diganti hanya dengan mengubah `.env` tanpa mengubah kode.

---

## Fitur

- **Suara**: Web Speech API (`id-ID`) untuk input, `speechSynthesis` untuk membacakan jawaban, tombol mati/nyala dan berhenti.
- **Ngobrol Terus**: mikrofon otomatis aktif lagi setelah AI selesai bicara.
- **Sapaan otomatis** sesuai waktu (pagi/siang/sore/malam) saat aplikasi dibuka.
- **Streaming**: jawaban muncul bertahap seperti diketik, dengan indikator "sedang berpikir" dan tombol berhenti.
- **Riwayat** dikirim ke model untuk konteks, dipotong ke 16 pesan terakhir agar muat di context window, disimpan di `localStorage`.
- **Markdown**: daftar, tebal, miring, tautan, blok kode dengan tombol **Salin**.
- **Tema gelap/terang**, **Percakapan Baru**, **Hapus Riwayat**, dan pemulihan percakapan lama.
- **Tool calling** dengan validasi argumen, pesan error untuk model agar bisa mencoba lagi, serta fallback teks bila tool gagal. Maksimal 5 putaran.

### Tool yang tersedia

| Tool | Fungsi | Penyimpanan |
|---|---|---|
| `catat_tugas` | Tambah/lihat/selesaikan/hapus tugas + deadline | SQLite |
| `atur_pengingat` | Pengingat waktu tertentu | SQLite + notifikasi browser |
| `buat_catatan` | Simpan & cari catatan | SQLite |
| `cari_web` | Cari info via DuckDuckGo/SearXNG lalu rangkum | Tanpa API key |
| `hitung` | Kalkulator & konversi satuan | — |
| `info_waktu` | Tanggal/jam Asia/Jakarta (WIB) | — |

Aksi **hapus** selalu meminta konfirmasi lewat dialog di layar sebelum dijalankan.

---

## Struktur folder

```
asisten-ai/
├── .env.example              ← template konfigurasi (Ollama / Groq / OpenRouter)
├── .env                      ← konfigurasi aktif (jangan di-commit)
├── .gitignore
├── package.json
├── package-lock.json
├── server.js                 ← Express, proxy SSE, tool loop, SQLite, rate limit
├── README.md
├── scripts/
│   ├── generate-icons.js     ← generator ikon PNG 192 & 512
│   └── smoke-test.js         ← test otomatis backend
├── data/
│   └── asisten.db            ← dibuat otomatis saat server pertama jalan
└── public/
    ├── index.html
    ├── styles.css
    ├── app.js                ← SSE, suara, markdown, localStorage, PWA
    ├── config.js             ← apiBase untuk deploy/APK (aman untuk browser)
    ├── manifest.json
    ├── sw.js
    └── icons/
        ├── icon-192.png
        └── icon-512.png
```

---

## Instalasi cepat — Ollama lokal (GRATIS)

### 1. Pasang Ollama

- Windows/macOS: unduh dari **https://ollama.com/download**
- Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Cek terpasang:

```bash
ollama --version
```

### 2. Unduh model open source

```bash
ollama pull qwen2.5:7b-instruct
```

Model ini mendukung tool calling dan ukurannya ±4,7 GB. Kalau RAM terbatas, pakai varian lebih kecil:

```bash
ollama pull qwen2.5:3b-instruct
```

Lalu set `LLM_MODEL=qwen2.5:3b-instruct` di `.env`.

### 3. Jalankan Ollama

```bash
ollama serve
```

Biarkan jendela/terminal ini tetap terbuka.

### 4. Siapkan proyek

```powershell
cd "C:\Users\faisal akbar\OneDrive\Dokumen\UI UX SM 5\asisten ai web\asisten-ai"
copy .env.example .env
cmd /c npm install
```

> `npm install` dipanggil lewat `cmd /c` karena PowerShell sering memblokir `npm.ps1`. Setelah dependensi terpasang, `npm start` bisa dipanggil langsung.

### 5. Jalankan aplikasi

```powershell
node server.js
```

Buka **http://localhost:3000**.

---

## Konfigurasi `.env`

### Ollama (default, lokal, gratis)

```env
PORT=3000
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b-instruct
```

Ollama lokal tidak memeriksa API key, jadi nilai `ollama` boleh apa saja.

### Groq (cepat, ada free tier)

```env
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_api_key_kamu_di_sini
LLM_MODEL=llama-3.3-70b-versatile
```

Daftar gratis di https://console.groq.com/keys.

### OpenRouter (banyak model open source, ada opsi `:free`)

```env
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-api_key_kamu_di_sini
LLM_MODEL=qwen/qwen-2.5-72b-instruct:free
```

Daftar di https://openrouter.ai/keys.

### Opsi lain

```env
SEARCH_ENGINE=ddg              # ddg atau searx
SEARXNG_URL=                   # isi kalau pakai SearXNG sendiri
SQLITE_FILE=./data/asisten.db
RATE_LIMIT=30                  # permintaan/menit/IP
```

> **Keamanan:** kunci API hanya dibaca di `server.js`. Tidak ada satu pun file di folder `public/` yang berisi kunci.

---

## Cara mengetes bahwa AI benar-benar terhubung

### Uji cepat lewat browser

1. Buka http://localhost:3000
2. Header harus berubah menjadi `qwen2.5:7b-instruct · terhubung` (titik hijau).
3. Ketik **"siapa kamu?"** → jawaban muncul **bertahap**, bukan teks statis.
4. Ketik **"catat tugas tes belajar besok pukul 09:00"**
   → akan tampil baris aksi "Menyimpan tugas...", lalu AI mengonfirmasi hasilnya.
5. Ketik **"lihat tugas saya"** → tugas tes harus muncul kembali.
6. Cek database langsung:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('./data/asisten.db'); console.log(d.prepare('SELECT * FROM tasks').all());"
```

### Contoh perintah lain

```
jam berapa sekarang?
hitung 125 * 8 + 17
konversi 100 cm ke meter
cari info terbaru tentang eclipse 2026
catat catatan: ide judul podcast tentang AI
cari catatan podcast
ingatkan aku minum obat 5 menit lagi
selesaikan tugas nomor 1
hapus tugas nomor 2        ← akan muncul dialog konfirmasi
```

### Smoke test otomatis

```powershell
node scripts/smoke-test.js
```

Semua baris harus bertuliskan `[LULUS]`. Skrip mengecek health endpoint, seluruh aset PWA, ukuran ikon, validasi input, konfirmasi, dan memastikan tidak ada kunci API di folder `public/`.

### Uji tool calling langsung lewat terminal

```powershell
node -e "fetch('http://localhost:3000/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'catat tugas cek API pukul 08:00'}]})}).then(r=>r.text()).then(console.log)"
```

Kalau koneksi ke model bermasalah, stream akan berisi `event: error` dengan pesan dalam bahasa Indonesia.

---

## Pemecahan masalah

| Gejala | Penyebab | Solusi |
|---|---|---|
| `model belum jalan` di header | Backend/Ollama mati | Jalankan `ollama serve`, lalu `node server.js` |
| `Model "... tidak ditemukan"` | Model belum diunduh | `ollama pull qwen2.5:7b-instruct` |
| `Kunci API LLM tidak valid` | Key salah di `.env` | Perbaiki `LLM_API_KEY`, restart server |
| `Kuota ... habis (429)` | Free tier habis | Tunggu atau ganti model/provider |
| Mikrofon tidak merespons | Izin ditolak / bukan Chrome-Edge | Izinkan mikrofon di browser, pakai Chrome/Edge, akses via `localhost` atau HTTPS |
| Suara tidak keluar | Autoplay diblokir browser | Klik tombol **Suara** dulu, atau interaksi apa pun di halaman |
| Notifikasi tidak muncul | Izin notifikasi belum diberi | Klik mikrofon/kirim pesan sekali untuk meminta izin |
| Tugas tidak muncul | Model tidak memanggil tool | Ulangi dengan kalimat lebih eksplisit: "catat tugas ..." |

---

## Deploy backend

Contoh Render / Railway / Fly.io:

1. Push folder proyek ke Git (jangan sertakan `.env` dan `data/`).
2. Buat Web Service, set **Build Command**: `npm install`, **Start Command**: `npm start`.
3. Tambahkan environment variable sama seperti `.env`:
   `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `PORT`, `RATE_LIMIT`, dll.
4. Untuk backend jarak jauh, pakai provider LLM berbasis HTTPS (Groq/OpenRouter) atau Ollama yang diekspos dengan aman — jangan kirim API key Ollama publik tanpa proteksi.
5. Catat URL HTTPS hasil deploy, misalnya `https://asisten-ai.onrender.com`.

### Mengarahkan frontend ke backend deploy

Edit `public/config.js`:

```js
window.APP_CONFIG = {
  apiBase: "https://asisten-ai.onrender.com",
  appName: "Asisten AI",
};
```

Lalu deploy ulang / build ulang PWA. Untuk development biarkan `apiBase: ""` agar memakai origin yang sama.

---

## Membuat APK

### Cara 1 — PWABuilder (paling mudah)

1. Deploy backend + frontend ke HTTPS.
2. Pastikan `/manifest.json`, `/sw.js`, dan ikon 192/512 bisa diakses.
3. Buka **https://www.pwabuilder.com**
4. Masukkan URL aplikasi → pilih **Android** → unduh **APK/AAB**.
5. Tanda tangan APK/AAB sebelum upload ke Play Store.

### Cara 2 — Capacitor

```powershell
cmd /c npm install @capacitor/core @capacitor/cli @capacitor/android
cmd /c npx cap init "Asisten AI" id.com.namakamu.asistenai --web-dir=public
cmd /c npx cap add android
```

Set `apiBase` di `public/config.js` ke URL backend HTTPS dulu, lalu:

```powershell
cmd /c npx cap sync
cmd /c npx cap open android
```

Build **Signed APK/AAB** dari Android Studio.

> Untuk perangkat Android, Web Speech API dan `speechSynthesis` umumnya tersedia lewat WebView, tetapi izin **RECORD_AUDIO** harus ditambahkan di `android/app/src/main/AndroidManifest.xml` bila memakai Capacitor.

---

## Catatan teknis

- Node.js **>= 22.5** diperlukan karena memakai modul SQLite bawaan `node:sqlite`.
- Riwayat dipotong ke 16 pesan terakhir; tiap pesan maksimal 4000 karakter.
- Rate limit default 30 request/menit/IP (bisa diubah lewat `RATE_LIMIT`).
- Service worker hanya menyimpan shell aplikasi; endpoint `/api/` **tidak pernah** dicache.
- Tool loop dibatasi 5 putaran. Jika gagal, model diminta menjawab dengan teks biasa.
- Ikon bisa dibuat ulang dengan `node scripts/generate-icons.js`.

Semua jawaban datang langsung dari model yang dikonfigurasi di `.env`. Tidak ada fallback berupa jawaban palsu.
