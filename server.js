"use strict";

/*
 * ASISTEN AI — backend Express.
 * Bertugas sebagai perantara aman ke penyedia model open source yang
 * kompatibel dengan format API OpenAI (/v1/chat/completions).
 * API key hanya ada di sisi server dan tidak pernah dikirim ke browser.
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite"); // SQLite bawaan Node >= 22.5

// ---------------------------------------------------------------------------
// KONFIGURASI
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const API_KEY = process.env.LLM_API_KEY || "ollama";
const MODEL = process.env.LLM_MODEL || "qwen2.5:7b-instruct";
const MAX_ROUNDS = 5; // batas putaran tool calling agar tidak loop tak berujung
const MAX_MESSAGES = 16; // potong riwayat lama supaya muat di context window
const MAX_CHARS = 4000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30);
const SEARCH_ENGINE = String(process.env.SEARCH_ENGINE || "ddg").toLowerCase();
const SEARXNG_URL = String(process.env.SEARXNG_URL || "").replace(/\/+$/, "");

const SYSTEM_PROMPT =
  "Kamu adalah asisten AI pribadi yang ramah, hangat, dan sigap. Sapa pengguna sesuai waktu (pagi/siang/sore/malam). Jawab dalam bahasa Indonesia kecuali pengguna memakai bahasa lain. Jawab singkat dan natural karena akan dibacakan dengan suara. Jika permintaan bisa dikerjakan dengan tool yang tersedia, langsung kerjakan lalu konfirmasi hasilnya. Jika tidak tahu, akui dengan jujur.";

// ---------------------------------------------------------------------------
// DATABASE SQLITE
// ---------------------------------------------------------------------------
const DB_FILE = path.resolve(process.env.SQLITE_FILE || "./data/asisten.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judul TEXT NOT NULL,
    deadline TEXT,
    selesai INTEGER NOT NULL DEFAULT 0,
    dibuat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judul TEXT,
    isi TEXT NOT NULL,
    dibuat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pesan TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    dibuat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---------------------------------------------------------------------------
// DEFINISI TOOL (format function calling OpenAI)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "catat_tugas",
      description:
        "Kelola daftar tugas pengguna. Bisa menambah tugas (termasuk deadline), melihat tugas, menandai selesai, atau menghapus tugas. Simpan di database SQLite.",
      parameters: {
        type: "object",
        properties: {
          aksi: { type: "string", enum: ["tambah", "lihat", "selesaikan", "hapus"] },
          judul: { type: "string", description: "Nama tugas. Wajib untuk aksi tambah." },
          deadline: { type: "string", description: "Contoh: 'besok pukul 09:00' atau '2026-12-01'." },
          id: { type: "integer", description: "ID tugas untuk selesaikan/hapus." },
          status: { type: "string", enum: ["aktif", "semua", "selesai"], description: "Filter untuk aksi lihat." },
        },
        required: ["aksi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atur_pengingat",
      description:
        "Buat pengingat dengan waktu tertentu. Hasilnya dikirim ke browser untuk ditampilkan sebagai notifikasi.",
      parameters: {
        type: "object",
        properties: {
          pesan: { type: "string", description: "Isi pengingat, contoh: 'Minum obat'." },
          waktu: { type: "string", description: "Format HH:mm atau tanggal ISO. Contoh '15:30'." },
          delay_menit: { type: "number", description: "Alternatif: berapa menit dari sekarang." },
        },
        required: ["pesan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buat_catatan",
      description: "Simpan catatan baru atau cari catatan yang sudah tersimpan.",
      parameters: {
        type: "object",
        properties: {
          aksi: { type: "string", enum: ["simpan", "cari", "hapus"] },
          judul: { type: "string", description: "Judul catatan saat menyimpan." },
          isi: { type: "string", description: "Isi catatan saat menyimpan." },
          kueri: { type: "string", description: "Kata kunci saat mencari atau menghapus." },
        },
        required: ["aksi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cari_web",
      description:
        "Cari informasi terbaru di web memakai DuckDuckGo atau SearXNG (tanpa API key), lalu kembalikan judul, URL, dan ringkasan singkat agar model bisa merangkum jawaban.",
      parameters: {
        type: "object",
        properties: {
          kueri: { type: "string", description: "Kata kunci pencarian." },
          mesin: { type: "string", enum: ["ddg", "searx"], description: "Mesin pencari. Default: ddg." },
        },
        required: ["kueri"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hitung",
      description:
        "Hitung ekspresi matematika atau konversi satuan (panjang, berat, suhu, data, waktu).",
      parameters: {
        type: "object",
        properties: {
          ekspresi: { type: "string", description: "Contoh: '(12*3)+5' atau '2^8'." },
          nilai: { type: "number", description: "Nilai untuk konversi satuan." },
          dari: { type: "string", description: "Satuan asal, contoh: 'cm' atau 'C'." },
          ke: { type: "string", description: "Satuan tujuan, contoh: 'm' atau 'F'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info_waktu",
      description: "Ambil tanggal, hari, dan jam saat ini di zona waktu Asia/Jakarta (WIB).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

const TOOL_LABELS = {
  catat_tugas: "Mengelola tugas",
  atur_pengingat: "Mengatur pengingat",
  buat_catatan: "Mengelola catatan",
  cari_web: "Mencari di web",
  hitung: "Menghitung",
  info_waktu: "Mengecek waktu",
};

// Aksi yang menghapus data wajib dikonfirmasi pengguna lewat UI.
const DESTRUCTIVE = {
  catat_tugas: (a) => (a.aksi === "hapus" ? `Hapus tugas "${a.judul || "#" + a.id}"?` : null),
  buat_catatan: (a) => (a.aksi === "hapus" ? `Hapus catatan yang cocok dengan "${a.kueri}"?` : null),
};

// ---------------------------------------------------------------------------
// VALIDASI ARGUMEN TOOL
// Model kecil kadang salah argumen; kirim pesan error yang jelas agar bisa retry.
// ---------------------------------------------------------------------------
const bad = (error) => ({ ok: false, error });

function cleanString(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validateToolArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return bad("argumen harus berupa objek JSON");
  }

  switch (name) {
    case "catat_tugas": {
      const aksi = cleanString(args.aksi, 30).toLowerCase();
      if (!["tambah", "lihat", "selesaikan", "hapus"].includes(aksi)) {
        return bad("aksi harus salah satu: tambah, lihat, selesaikan, hapus");
      }
      const out = { aksi };
      if (aksi === "tambah") {
        out.judul = cleanString(args.judul, 200);
        if (!out.judul) return bad("judul wajib diisi untuk menambah tugas");
        out.deadline = cleanString(args.deadline, 120);
      } else if (aksi === "lihat") {
        out.status = cleanString(args.status, 20).toLowerCase() || "aktif";
        if (!["aktif", "semua", "selesai"].includes(out.status)) out.status = "aktif";
      } else {
        if (args.id != null) {
          const id = Number(args.id);
          if (!Number.isInteger(id) || id <= 0) return bad("id harus bilangan bulat positif");
          out.id = id;
        }
        out.judul = cleanString(args.judul, 200);
        if (!out.id && !out.judul) return bad("berikan id atau judul tugas");
      }
      return { ok: true, value: out };
    }

    case "atur_pengingat": {
      const pesan = cleanString(args.pesan, 200);
      if (!pesan) return bad("pesan pengingat wajib diisi");
      let remindAt = null;
      if (args.waktu != null && String(args.waktu).trim()) {
        const s = String(args.waktu).trim();
        if (/^\d{1,2}:\d{2}$/.test(s)) {
          const [jam, menit] = s.split(":").map(Number);
          if (jam > 23 || menit > 59) return bad("format HH:mm tidak valid");
          const d = new Date();
          d.setHours(jam, menit, 0, 0);
          if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // besok kalau sudah lewat
          remindAt = d.getTime();
        } else {
          const d = new Date(s);
          if (Number.isNaN(d.getTime())) return bad("waktu tidak dikenali. Pakai HH:mm atau tanggal ISO");
          remindAt = d.getTime();
          if (remindAt <= Date.now()) return bad("waktu pengingat harus di masa depan");
        }
      } else if (args.delay_menit != null) {
        const n = Number(args.delay_menit);
        if (!Number.isFinite(n) || n < 0 || n > 10080) return bad("delay_menit harus antara 0 sampai 10080");
        remindAt = Date.now() + n * 60_000;
      } else {
        return bad("berikan waktu (HH:mm atau ISO) atau delay_menit");
      }
      return { ok: true, value: { pesan, remindAt } };
    }

    case "buat_catatan": {
      const aksi = cleanString(args.aksi, 30).toLowerCase();
      if (!["simpan", "cari", "hapus"].includes(aksi)) {
        return bad("aksi harus salah satu: simpan, cari, hapus");
      }
      const out = { aksi };
      if (aksi === "simpan") {
        out.isi = cleanString(args.isi, 5000);
        if (!out.isi) return bad("isi catatan wajib diisi");
        out.judul = cleanString(args.judul, 200);
      } else {
        out.kueri = cleanString(args.kueri, 200);
        if (!out.kueri) return bad("kueri wajib diisi untuk mencari atau menghapus catatan");
      }
      return { ok: true, value: out };
    }

    case "cari_web": {
      const kueri = cleanString(args.kueri, 200);
      if (!kueri) return bad("kueri pencarian wajib diisi");
      const mesin = cleanString(args.mesin, 10).toLowerCase() || "ddg";
      return { ok: true, value: { kueri, mesin: ["ddg", "searx"].includes(mesin) ? mesin : "ddg" } };
    }

    case "hitung": {
      if (args.ekspresi != null && String(args.ekspresi).trim()) {
        const ekspresi = String(args.ekspresi).trim().slice(0, 200);
        // Hanya digit dan operator matematika. Tidak ada eval bebas / akses variabel.
        if (!/^[\d\s+\-*/().%]+$/.test(ekspresi)) {
          return bad("ekspresi hanya boleh angka dan operator + - * / % ( )");
        }
        return { ok: true, value: { mode: "ekspresi", ekspresi } };
      }
      if (args.nilai != null && args.dari && args.ke) {
        const nilai = Number(args.nilai);
        if (!Number.isFinite(nilai)) return bad("nilai harus berupa angka");
        return {
          ok: true,
          value: { mode: "konversi", nilai, dari: cleanString(args.dari, 20), ke: cleanString(args.ke, 20) },
        };
      }
      return bad("berikan ekspresi, atau nilai + dari + ke untuk konversi satuan");
    }

    case "info_waktu":
      return { ok: true, value: {} };

    default:
      return bad(`tool "${name}" tidak dikenali`);
  }
}

// ---------------------------------------------------------------------------
// IMPLEMENTASI TOOL
// ---------------------------------------------------------------------------
function formatWIB(date = new Date()) {
  const tanggal = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const jam = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${tanggal}, ${jam} WIB`;
}

function executeCatatTugas(a) {
  if (a.aksi === "tambah") {
    const r = db
      .prepare("INSERT INTO tasks (judul, deadline) VALUES (?, ?)")
      .run(a.judul, a.deadline || null);
    return {
      label: "Menyimpan tugas...",
      detail: `Tugas #${r.lastInsertRowid} tersimpan`,
      result: {
        sukses: true,
        id: Number(r.lastInsertRowid),
        judul: a.judul,
        deadline: a.deadline || null,
        pesan: `Tugas "${a.judul}" berhasil dicatat${a.deadline ? ` dengan deadline ${a.deadline}` : ""}.`,
      },
    };
  }

  if (a.aksi === "lihat") {
    let sql = "SELECT id, judul, deadline, selesai FROM tasks";
    if (a.status === "aktif") sql += " WHERE selesai = 0";
    if (a.status === "selesai") sql += " WHERE selesai = 1";
    sql += " ORDER BY id DESC LIMIT 30";
    const rows = db.prepare(sql).all();
    if (!rows.length) {
      return { label: "Melihat tugas...", detail: "Belum ada tugas", result: { sukses: true, tugas: [], pesan: "Belum ada tugas yang tersimpan." } };
    }
    const daftar = rows.map((r) => `#${r.id} ${r.judul}${r.deadline ? ` (deadline: ${r.deadline})` : ""}${r.selesai ? " [selesai]" : ""}`);
    return {
      label: "Melihat daftar tugas...",
      detail: `${rows.length} tugas ditemukan`,
      result: { sukses: true, tugas: rows, pesan: `Daftar tugas:\n- ${daftar.join("\n- ")}` },
    };
  }

  let sql;
  const param = a.id != null ? a.id : `%${a.judul}%`;
  if (a.id != null) sql = a.aksi === "selesaikan" ? "UPDATE tasks SET selesai=1 WHERE id=?" : "DELETE FROM tasks WHERE id=?";
  else sql = a.aksi === "selesaikan" ? "UPDATE tasks SET selesai=1 WHERE judul LIKE ?" : "DELETE FROM tasks WHERE judul LIKE ?";
  const r = db.prepare(sql).run(param);
  const kata = a.aksi === "selesaikan" ? "diselesaikan" : "dihapus";
  return {
    label: a.aksi === "selesaikan" ? "Menandai tugas selesai..." : "Menghapus tugas...",
    detail: `${r.changes} tugas ${kata}`,
    result: {
      sukses: r.changes > 0,
      jumlah: r.changes,
      pesan: r.changes > 0 ? `${r.changes} tugas berhasil ${kata}.` : "Tugas tidak ditemukan, jadi tidak ada yang diubah.",
    },
  };
}

function executeBuatCatatan(a) {
  if (a.aksi === "simpan") {
    const r = db.prepare("INSERT INTO notes (judul, isi) VALUES (?, ?)").run(a.judul || null, a.isi);
    return {
      label: "Menyimpan catatan...",
      detail: `Catatan #${r.lastInsertRowid} tersimpan`,
      result: { sukses: true, id: Number(r.lastInsertRowid), pesan: `Catatan tersimpan dengan ID ${r.lastInsertRowid}.` },
    };
  }
  const like = `%${a.kueri}%`;
  if (a.aksi === "cari") {
    const rows = db
      .prepare("SELECT id, judul, isi, dibuat FROM notes WHERE isi LIKE ? OR judul LIKE ? ORDER BY id DESC LIMIT 5")
      .all(like, like);
    if (!rows.length) {
      return { label: "Mencari catatan...", detail: "Tidak ada hasil", result: { sukses: true, catatan: [], pesan: "Tidak ada catatan yang cocok." } };
    }
    return {
      label: "Mencari catatan...",
      detail: `${rows.length} catatan ditemukan`,
      result: { sukses: true, catatan: rows, pesan: rows.map((r) => `#${r.id} ${r.judul || "Catatan"}: ${r.isi.slice(0, 200)}`).join("\n") },
    };
  }
  const r = db.prepare("DELETE FROM notes WHERE isi LIKE ? OR judul LIKE ?").run(like, like);
  return {
    label: "Menghapus catatan...",
    detail: `${r.changes} catatan dihapus`,
    result: { sukses: r.changes > 0, jumlah: r.changes, pesan: r.changes > 0 ? `${r.changes} catatan dihapus.` : "Catatan tidak ditemukan." },
  };
}

function executeAturPengingat(a) {
  const id = db.prepare("INSERT INTO reminders (pesan, remind_at) VALUES (?, ?)").run(a.pesan, a.remindAt).lastInsertRowid;
  const when = formatWIB(new Date(a.remindAt));
  return {
    label: "Mengatur pengingat...",
    detail: `Pengingat untuk ${when}`,
    result: { sukses: true, id: Number(id), pesan: `Pengingat "${a.pesan}" diatur untuk ${when}.`, remindAt: a.remindAt },
    reminder: { id: Number(id), pesan: a.pesan, remindAt: a.remindAt },
  };
}

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decodeHtml(String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

async function fetchWithTimeout(url, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AsistenAI/1.0)", Accept: "text/html,application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function executeCariWeb(a) {
  let html = "";
  let source = a.mesin;
  try {
    if (a.mesin === "searx" && SEARXNG_URL) {
      const res = await fetchWithTimeout(`${SEARXNG_URL}/search?q=${encodeURIComponent(a.kueri)}&format=json`, 9000);
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
      const data = await res.json();
      const hasil = (data.results || []).slice(0, 5).map((r) => ({
        judul: stripTags(r.title),
        url: r.url,
        ringkasan: stripTags(r.content || "").slice(0, 300),
      }));
      return {
        label: "Mencari di web...",
        detail: `${hasil.length} hasil dari SearXNG`,
        result: { sukses: true, kueri: a.kueri, hasil, pesan: hasil.map((h, i) => `${i + 1}. ${h.judul} — ${h.url}\n   ${h.ringkasan}`).join("\n") || "Tidak ada hasil." },
      };
    }
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.kueri)}`;
    const res = await fetchWithTimeout(url, 9000);
    html = await res.text();
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  } catch (error) {
    // Fallback ke endpoint lite bila HTML diblokir.
    try {
      const res = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(a.kueri)}`, 9000);
      html = await res.text();
      source = "ddg-lite";
    } catch (_fallbackError) {
      throw new Error(`Pencarian gagal: ${error.message}. Periksa koneksi internet server.`);
    }
  }

  const hasil = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = re.exec(html)) && hasil.length < 5) {
    let url = decodeHtml(match[1]);
    if (url.includes("uddg=")) {
      try {
        url = decodeURIComponent(new URL("https://duckduckgo.com" + url).searchParams.get("uddg") || url);
      } catch (_e) {
        /* biarkan apa adanya */
      }
    }
    const judul = stripTags(match[2]);
    const after = html.slice(match.index, match.index + 1400);
    const snip = after.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    hasil.push({ judul, url, ringkasan: snip ? stripTags(snip[1]).slice(0, 300) : "" });
  }

  if (!hasil.length) {
    const liteRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = liteRe.exec(html)) && hasil.length < 5) {
      hasil.push({ judul: stripTags(match[2]), url: decodeHtml(match[1]), ringkasan: "" });
    }
  }

  return {
    label: "Mencari di web...",
    detail: `${hasil.length} hasil dari ${source}`,
    result: {
      sukses: hasil.length > 0,
      kueri: a.kueri,
      hasil,
      pesan: hasil.length
        ? hasil.map((h, i) => `${i + 1}. ${h.judul} — ${h.url}\n   ${h.ringkasan}`).join("\n")
        : "Pencarian selesai tetapi tidak ada hasil yang bisa diambil.",
    },
  };
}

const SATUAN = {
  mm: ["panjang", 0.001], cm: ["panjang", 0.01], m: ["panjang", 1], km: ["panjang", 1000],
  inci: ["panjang", 0.0254], kaki: ["panjang", 0.3048],
  mg: ["berat", 0.000001], g: ["berat", 0.001], kg: ["berat", 1], ton: ["berat", 1000],
  byte: ["data", 1], kb: ["data", 1024], mb: ["data", 1024 ** 2], gb: ["data", 1024 ** 3], tb: ["data", 1024 ** 4],
  detik: ["waktu", 1], menit: ["waktu", 60], jam: ["waktu", 3600], hari: ["waktu", 86400],
};

function konversiSatuan(nilai, dari, ke) {
  const d = dari.toLowerCase().trim();
  const k = ke.toLowerCase().trim();
  if ((d === "c" || d === "celcius" || d === "celsius") && ["f", "fahrenheit"].includes(k)) {
    return nilai * 9 / 5 + 32;
  }
  if ((d === "f" || d === "fahrenheit") && ["c", "celsius", "celcius"].includes(k)) {
    return (nilai - 32) * 5 / 9;
  }
  if (["c", "celsius", "f", "fahrenheit"].includes(d) && k === "k") {
    const c = d.startsWith("f") ? (nilai - 32) * 5 / 9 : nilai;
    return c + 273.15;
  }
  if (d === "k" && ["c", "celsius"].includes(k)) return nilai - 273.15;
  if (d === "k" && ["f", "fahrenheit"].includes(k)) return (nilai - 273.15) * 9 / 5 + 32;

  const a = SATUAN[d];
  const b = SATUAN[k];
  if (!a || !b) throw new Error(`satuan "${dari}" atau "${ke}" tidak dikenali`);
  if (a[0] !== b[0]) throw new Error(`tidak bisa mengonversi ${dari} ke ${ke} (jenis satuan berbeda)`);
  return (nilai * a[1]) / b[1];
}

function executeHitung(a) {
  if (a.mode === "ekspresi") {
    // Whitelist sudah dicek di validasi; Function di sini hanya menerima operator.
    const hasil = Function('"use strict"; return (' + a.ekspresi + ");")();
    if (!Number.isFinite(hasil)) throw new Error("hasil perhitungan tidak valid (mungkin dibagi nol)");
    return {
      label: "Menghitung...",
      detail: `${a.ekspresi} = ${hasil}`,
      result: { sukses: true, ekspresi: a.ekspresi, hasil, pesan: `Hasil ${a.ekspresi} = ${hasil}.` },
    };
  }
  const hasil = konversiSatuan(a.nilai, a.dari, a.ke);
  const angka = Number(hasil.toPrecision(10));
  return {
    label: "Mengonversi satuan...",
    detail: `${a.nilai} ${a.dari} = ${angka} ${a.ke}`,
    result: { sukses: true, nilai: angka, dari: a.dari, ke: a.ke, pesan: `${a.nilai} ${a.dari} = ${angka} ${a.ke}.` },
  };
}

async function executeTool(name, args) {
  switch (name) {
    case "catat_tugas": return executeCatatTugas(args);
    case "atur_pengingat": return executeAturPengingat(args);
    case "buat_catatan": return executeBuatCatatan(args);
    case "cari_web": return await executeCariWeb(args);
    case "hitung": return executeHitung(args);
    case "info_waktu": {
      const waktu = formatWIB();
      return {
        label: "Mengecek waktu...",
        detail: waktu,
        result: { sukses: true, waktu, pesan: `Sekarang ${waktu}.` },
      };
    }
    default: throw new Error(`tool "${name}" tidak dikenali`);
  }
}

// ---------------------------------------------------------------------------
// PEMANGGILAN MODEL OPENAI-COMPATIBLE (streaming SSE)
// ---------------------------------------------------------------------------
function mapUpstreamError(status, text) {
  const isi = String(text || "").slice(0, 300);
  if (status === 401 || status === 403) {
    return "Kunci API LLM tidak valid (401/403). Periksa LLM_API_KEY di file .env, lalu restart server.";
  }
  if (status === 404) {
    return `Model "${MODEL}" tidak ditemukan di ${BASE_URL}. Kalau pakai Ollama: jalankan "ollama pull ${MODEL}".`;
  }
  if (status === 429) {
    return "Kuota atau batas permintaan provider habis (429). Tunggu sebentar atau ganti model/provider.";
  }
  return `Provider LLM merespons HTTP ${status}. ${isi}`.trim();
}

function networkError(error) {
  if (error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
    return "Provider LLM terlalu lama merespons. Cek koneksi atau status server model.";
  }
  return `Tidak bisa terhubung ke LLM di ${BASE_URL}. Kalau pakai Ollama, jalankan "ollama serve" dulu. (${error.message})`;
}

async function readUpstreamSSE(response, onData) {
  if (!response.body) throw new Error("Provider tidak mengirim stream SSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleBlock = (block) => {
    const dataLines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (dataLines.length) onData(dataLines.join("\n"));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        handleBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer.trim()) handleBlock(buffer);
  } finally {
    try { await reader.cancel(); } catch (_e) { /* stream sudah tertutup */ }
  }
}

async function callModel(messages, { send, signal, useTools = true }) {
  const payload = {
    model: MODEL,
    messages,
    temperature: 0.6,
    stream: true,
  };
  if (useTools) {
    payload.tools = TOOLS;
    payload.tool_choice = "auto";
  }

  let response;
  try {
    const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000);
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });
  } catch (error) {
    throw new Error(networkError(error));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(mapUpstreamError(response.status, text));
  }

  // Beberapa provider mengabaikan stream:true dan balas JSON biasa.
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("event-stream")) {
    const data = await response.json().catch(() => ({}));
    const message = data.choices?.[0]?.message || {};
    const text = typeof message.content === "string" ? message.content : "";
    for (let i = 0; i < text.length; i += 24) {
      send("token", { text: text.slice(i, i + 24) }); // tetap terasa streaming di UI
    }
    return {
      text,
      toolCalls: (message.tool_calls || []).map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name || "",
        args: parseArgs(tc.function?.arguments),
      })),
      finishReason: data.choices?.[0]?.finish_reason || "stop",
    };
  }

  let text = "";
  let finishReason = null;
  const calls = new Map(); // index -> tool call yang sedang dirakit dari delta

  await readUpstreamSSE(response, (data) => {
    if (data === "[DONE]") return;
    let json;
    try { json = JSON.parse(data); } catch (_e) { return; }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      send("token", { text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        const cur = calls.get(index) || { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) {
          // Umumnya string bertahap; beberapa provider mengirim objek sekaligus.
          if (typeof tc.function.arguments === "string") cur.arguments += tc.function.arguments;
          else cur.arguments = JSON.stringify(tc.function.arguments);
        }
        calls.set(index, cur);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  return {
    text,
    toolCalls: [...calls.values()].map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      args: parseArgs(c.arguments),
    })),
    finishReason: finishReason || "stop",
  };
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (_e) { return { __parse_error: String(raw).slice(0, 300) }; }
}

function systemMessage() {
  return `${SYSTEM_PROMPT}\n\nInformasi saat ini: ${formatWIB()}. Gunakan informasi ini untuk menyapa sesuai waktu.`;
}

function toolResultMessage(id, name, payload) {
  return {
    role: "tool",
    tool_call_id: id,
    name,
    content: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// RATE LIMIT SEDERHANA
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function checkRate(req, res) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 60_000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({
      error: `Terlalu banyak permintaan. Batas ${RATE_LIMIT} pesan per menit. Tunggu sebentar ya.`,
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// KONFIRMASI AKSI HAPUS
// ---------------------------------------------------------------------------
const pendingConfirms = new Map(); // id -> { name, args, expires }
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of pendingConfirms) if (item.expires < now) pendingConfirms.delete(id);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// VALIDASI PESAN CHAT
// ---------------------------------------------------------------------------
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return { ok: false, error: "Riwayat pesan kosong atau terlalu banyak." };
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || !["user", "assistant"].includes(m.role)) {
      return { ok: false, error: `Pesan ke-${i + 1} memiliki peran yang tidak diizinkan.` };
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      return { ok: false, error: `Pesan ke-${i + 1} kosong.` };
    }
    if (m.content.length > MAX_CHARS) {
      return { ok: false, error: `Pesan ke-${i + 1} terlalu panjang. Maksimal ${MAX_CHARS} karakter.` };
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return { ok: false, error: "Pesan terakhir harus berasal dari pengguna." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");

// Frontend bisa di-host di domain lain (GitHub Pages / APK), jadi izinkan CORS.
// Tidak ada kredensial browser yang dikirim, aman untuk origin mana pun.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    baseUrl: BASE_URL,
    ready: true,
    tools: TOOLS.map((t) => t.function.name),
    waktu: formatWIB(),
  });
});

app.post("/api/chat", async (req, res) => {
  if (!checkRate(req, res)) return;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  let clientClosed = false;
  // Catatan: req.on("close") di Node modern fired saat body selesai dibaca,
  // bukan saat klien putus. Pakai response "close" untuk membatalkan stream.
  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });

  try {
    const cek = validateMessages(req.body?.messages);
    if (!cek.ok) {
      send("error", { message: cek.error });
      return res.end();
    }

    // Potong riwayat lama: system + N pesan terakhir.
    const riwayat = req.body.messages.slice(-MAX_MESSAGES).map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_CHARS),
    }));
    const messages = [{ role: "system", content: systemMessage() }, ...riwayat];

    send("meta", { model: MODEL, tools: TOOLS.length });

    let rounds = 0;
    while (rounds < MAX_ROUNDS) {
      if (clientClosed) return res.end();
      rounds += 1;

      const out = await callModel(messages, { send, signal: controller.signal, useTools: true });
      const adaTool = Array.isArray(out.toolCalls) && out.toolCalls.length > 0;

      if (!adaTool) {
        send("done", { stopReason: out.finishReason || "stop", rounds, jawaban: out.text });
        return res.end();
      }

      // Simpan pesan asisten berisi tool_calls agar model paham konteksnya.
      messages.push({
        role: "assistant",
        content: out.text || null,
        tool_calls: out.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      let adaExecusiGagal = false;

      for (const tc of out.toolCalls) {
        const label = TOOL_LABELS[tc.name] || tc.name;
        send("action", { label: `Menjalankan ${label.toLowerCase()}...`, status: "running", tool: tc.name });

        const validasi = validateToolArgs(tc.name, tc.args);
        if (!validasi.ok) {
          const pesanError = `Argumen tidak valid untuk ${tc.name}: ${validasi.error}. Perbaiki argumen dan panggil tool lagi, atau jawab dengan teks biasa.`;
          messages.push(toolResultMessage(tc.id, tc.name, { sukses: false, error: pesanError }));
          send("action", { label: `${label} gagal`, status: "error", detail: validasi.error, tool: tc.name });
          send("notice", { message: `Argumen ${tc.name} tidak valid: ${validasi.error}` });
          adaExecusiGagal = true;
          continue;
        }

        const args = validasi.value;
        const konfirmasi = DESTRUCTIVE[tc.name]?.(args);
        if (konfirmasi) {
          const id = randomUUID();
          pendingConfirms.set(id, { name: tc.name, args, expires: Date.now() + 180_000 });
          send("confirm", {
            id,
            tool: tc.name,
            description: konfirmasi,
            detail: "Aksi ini menghapus data. Konfirmasi dulu, ya.",
          });
          send("done", { stopReason: "need_confirm", rounds });
          return res.end();
        }

        try {
          const hasil = await executeTool(tc.name, args);
          messages.push(toolResultMessage(tc.id, tc.name, hasil.result));
          send("action", {
            label: hasil.label,
            status: "done",
            detail: hasil.detail,
            tool: tc.name,
            result: hasil.result,
          });
          if (hasil.reminder) send("reminder", hasil.reminder);
        } catch (error) {
          const pesanError = `Tool ${tc.name} gagal: ${error.message}. Coba lagi dengan argumen berbeda atau jawab dengan teks biasa.`;
          messages.push(toolResultMessage(tc.id, tc.name, { sukses: false, error: pesanError }));
          send("action", { label: `${label} gagal`, status: "error", detail: error.message, tool: tc.name });
          adaExecusiGagal = true;
        }
      }

      if (rounds >= MAX_ROUNDS) {
        send("notice", { message: "Batas 5 langkah tool tercapai. Saya rangkum hasilnya sekarang." });
        try {
          await callModel(
            [...messages, { role: "user", content: "Rangkum semua hasil tool di atas dengan singkat dan natural dalam bahasa Indonesia. Jangan panggil tool lagi." }],
            { send, signal: controller.signal, useTools: false }
          );
        } catch (_e) {
          const fallback = adaExecusiGagal
            ? "Tool belum berhasil, tapi saya sudah coba. Coba lagi dengan kalimat lain, ya."
            : "Saya sudah mengerjakan perintahmu, tapi batas langkah tercapai.";
          send("token", { text: fallback });
        }
        send("done", { stopReason: "max_rounds", rounds });
        return res.end();
      }
    }
  } catch (error) {
    if (!clientClosed) {
      send("error", { message: error.message || "Terjadi kesalahan pada server." });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post("/api/confirm", async (req, res) => {
  if (!checkRate(req, res)) return;
  const { id, approved } = req.body || {};
  const item = pendingConfirms.get(id);
  if (!item) {
    return res.status(400).json({ error: "Permintaan konfirmasi tidak ditemukan atau sudah kedaluwarsa." });
  }
  pendingConfirms.delete(id);
  if (!approved) {
    return res.json({ ok: true, dibatalkan: true, pesan: "Aksi dibatalkan. Data tidak diubah." });
  }
  try {
    const hasil = await executeTool(item.name, item.args);
    res.json({ ok: true, dibatalkan: false, tool: item.name, result: hasil.result, label: hasil.label, detail: hasil.detail });
  } catch (error) {
    res.status(500).json({ ok: false, error: `Gagal menjalankan aksi: ${error.message}` });
  }
});

// File statis dan fallback SPA (kecuali endpoint API).
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Asisten AI siap di http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Provider: ${BASE_URL}`);
  console.log(`Database: ${DB_FILE}`);
  if (API_KEY === "ollama" && BASE_URL.includes("localhost")) {
    console.log("Pastikan Ollama berjalan: ollama serve");
  }
});
