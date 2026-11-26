"use strict";

/*
 * ASISTEN AI — frontend murni.
 * Menangani SSE streaming, tool action, speech recognition/synthesis,
 * markdown, riwayat localStorage, PWA, dan konfirmasi akses hapus.
 */

const API_BASE = String((window.APP_CONFIG && window.APP_CONFIG.apiBase) || "").replace(/\/+$/, "");

const KEY_CURRENT = "asisten-ai:current";
const KEY_SESSIONS = "asisten-ai:sessions";
const KEY_PREFS = "asisten-ai:prefs";
const KEY_REMINDERS = "asisten-ai:reminders";

const el = (id) => document.getElementById(id);
const ui = {
  modelInfo: el("modelInfo"),
  banner: el("banner"),
  chatArea: el("chatArea"),
  emptyState: el("emptyState"),
  greeting: el("greeting"),
  greetingSub: el("greetingSub"),
  messages: el("messages"),
  thinking: el("thinking"),
  actionsPanel: el("actionsPanel"),
  form: el("chatForm"),
  input: el("messageInput"),
  sendBtn: el("sendBtn"),
  stopBtn: el("stopBtn"),
  micBtn: el("micBtn"),
  ttsBtn: el("ttsBtn"),
  continuousBtn: el("continuousBtn"),
  stopVoiceBtn: el("stopVoiceBtn"),
  themeBtn: el("themeBtn"),
  newChatBtn: el("newChatBtn"),
  clearBtn: el("clearBtn"),
  historySelect: el("historySelect"),
  installBtn: el("installBtn"),
  confirmDialog: el("confirmDialog"),
  confirmText: el("confirmText"),
  confirmDetail: el("confirmDetail"),
  toast: el("toast"),
};

const prefsAwal = readJSON(KEY_PREFS, { theme: "dark", tts: true, continuous: false });
const state = {
  messages: readJSON(KEY_CURRENT, []),
  sessions: readJSON(KEY_SESSIONS, []),
  reminders: readJSON(KEY_REMINDERS, []),
  prefs: prefsAwal,
  controller: null,
  busy: false,
  recognition: null,
  listening: false,
  tts: prefsAwal.tts !== false,
  continuous: prefsAwal.continuous === true,
  speechUtter: null,
  toastTimer: null,
  reminderTimers: [],
  actionRows: new Map(),
};

// ---------------------------------------------------------------------------
// UTILITAS UMUM
// ---------------------------------------------------------------------------
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    /* localStorage penuh atau diblokir: abaikan, chat tetap jalan */
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jamJakarta() {
  return Number(
    new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
}

function sapaanWaktu() {
  const jam = jamJakarta();
  if (jam < 11) return "Selamat pagi";
  if (jam < 15) return "Selamat siang";
  if (jam < 18) return "Selamat sore";
  return "Selamat malam";
}

function showBanner(message, isError = false) {
  ui.banner.textContent = message;
  ui.banner.classList.toggle("error", isError);
  ui.banner.hidden = !message;
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 3500);
}

function dekatBawah() {
  return ui.chatArea.scrollHeight - ui.chatArea.scrollTop - ui.chatArea.clientHeight < 140;
}

function scrollBawah(paksa = false) {
  if (paksa || dekatBawah()) ui.chatArea.scrollTop = ui.chatArea.scrollHeight;
}

// ---------------------------------------------------------------------------
// MARKDOWN RINGAN + TOMBOL SALIN
// ---------------------------------------------------------------------------
function renderMarkdown(raw) {
  let text = String(raw || "").replace(/\r\n/g, "\n");
  // Saat streaming, blok kode bisa belum ditutup: tutup sementara.
  if ((text.match(/```/g) || []).length % 2 === 1) text += "\n```";

  const blok = [];
  text = text.replace(/```([\w+#.-]*)\n([\s\S]*?)```/g, (_m, bahasa, kode) => {
    const token = "\u0000CODE" + blok.length + "\u0000";
    blok.push(
      '<div class="code-block">' +
        '<button type="button" class="copy-code" data-copy-code>Salin</button>' +
        `<pre><code class="language-${escapeHtml(bahasa)}">${escapeHtml(kode.replace(/\n$/, ""))}</code></pre>` +
        "</div>"
    );
    return token;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, (_m, kode) => `<code>${kode}</code>`);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const aman = /^(https?:\/\/|mailto:)/i.test(url) ? url : "#";
    return `<a href="${aman}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const baris = text.split("\n");
  const hasil = [];
  let paragraf = [];
  let daftar = null;

  const tutupParagraf = () => {
    if (paragraf.length) {
      hasil.push("<p>" + paragraf.join("<br>") + "</p>");
      paragraf = [];
    }
  };
  const tutupDaftar = () => {
    if (daftar) {
      hasil.push(`<${daftar.jenis}>` + daftar.items.map((item) => `<li>${item}</li>`).join("") + `</${daftar.jenis}>`);
      daftar = null;
    }
  };

  for (const barisAsli of baris) {
    const bar = barisAsli.trim();
    const ul = bar.match(/^[-*+]\s+(.*)$/);
    const ol = bar.match(/^\d+[.)]\s+(.*)$/);

    if (ul) {
      tutupParagraf();
      if (!daftar || daftar.jenis !== "ul") {
        tutupDaftar();
        daftar = { jenis: "ul", items: [] };
      }
      daftar.items.push(ul[1]);
      continue;
    }
    if (ol) {
      tutupParagraf();
      if (!daftar || daftar.jenis !== "ol") {
        tutupDaftar();
        daftar = { jenis: "ol", items: [] };
      }
      daftar.items.push(ol[1]);
      continue;
    }
    if (!bar) {
      tutupParagraf();
      tutupDaftar();
      continue;
    }
    tutupDaftar();
    paragraf.push(bar);
  }
  tutupParagraf();
  tutupDaftar();

  let html = hasil.join("");
  blok.forEach((potongan, i) => {
    html = html.replace("\u0000CODE" + i + "\u0000", potongan);
  });
  return html;
}

function pasangTombolSalin(root) {
  root.querySelectorAll("[data-copy-code]").forEach((tombol) => {
    if (tombol.dataset.bound) return;
    tombol.dataset.bound = "1";
    tombol.addEventListener("click", async () => {
      const kode = tombol.parentElement.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(kode);
        tombol.textContent = "Tersalin";
      } catch (_error) {
        tombol.textContent = "Gagal";
      }
      setTimeout(() => {
        tombol.textContent = "Salin";
      }, 1600);
    });
  });
}

function bersihkanUntukSuara(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " kode. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|__|\*|_|#|>/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// PESAN & RIWAYAT
// ---------------------------------------------------------------------------
function buatElemenPesan(pesan) {
  const grup = document.createElement("div");
  grup.className = "message-group " + pesan.role + (pesan.error ? " is-error" : "");

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = pesan.role === "user" ? "K" : "✦";

  const gelembung = document.createElement("div");
  gelembung.className = "bubble";

  const isi = document.createElement("div");
  isi.className = "markdown";
  isi.innerHTML = renderMarkdown(pesan.content);

  const waktu = document.createElement("span");
  waktu.className = "meta-time";
  waktu.textContent = new Date(pesan.time || Date.now()).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });

  gelembung.append(isi, waktu);
  grup.append(avatar, gelembung);
  pasangTombolSalin(grup);
  return grup;
}

function tambahPesan(role, content, opsi = {}) {
  const pesan = { role, content, time: Date.now(), ...(opsi.error ? { error: true } : {}) };
  state.messages.push(pesan);
  simpanSekarang();
  if (!opsi.skipRender) {
    ui.emptyState.hidden = true;
    ui.messages.append(buatElemenPesan(pesan));
    scrollBawah(true);
  }
  return pesan;
}

function simpanSekarang() {
  writeJSON(KEY_CURRENT, state.messages);
}

function muatUlangPesan() {
  ui.messages.innerHTML = "";
  if (!state.messages.length) {
    ui.emptyState.hidden = false;
    return;
  }
  ui.emptyState.hidden = true;
  for (const pesan of state.messages) ui.messages.append(buatElemenPesan(pesan));
  scrollBawah(true);
}

function perbaruiPilihanRiwayat() {
  ui.historySelect.innerHTML = '<option value="">Percakapan saat ini</option>';
  state.sessions.forEach((sesi, i) => {
    const opsi = document.createElement("option");
    opsi.value = String(i);
    opsi.textContent = sesi.judul || "Percakapan " + (i + 1);
    ui.historySelect.append(opsi);
  });
}

function percakapanBaru() {
  if (state.messages.length > 1) {
    state.sessions.unshift({
      judul: (state.messages.find((m) => m.role === "user")?.content || "Percakapan").slice(0, 42),
      messages: state.messages.slice(),
      time: Date.now(),
    });
    state.sessions = state.sessions.slice(0, 10);
    writeJSON(KEY_SESSIONS, state.sessions);
  }
  hentikanSemua();
  state.messages = [];
  simpanSekarang();
  muatUlangPesan();
  ui.actionsPanel.innerHTML = "";
  ui.actionsPanel.hidden = true;
  state.actionRows.clear();
  perbaruiPilihanRiwayat();
  showToast("Percakapan baru dimulai.");
}

function hapusSemuaRiwayat() {
  const yakin = window.confirm("Hapus semua riwayat chat, percakapan tersimpan, dan pengingat? Tindakan ini tidak bisa dibatalkan.");
  if (!yakin) return;
  hentikanSemua();
  state.messages = [];
  state.sessions = [];
  state.reminders.forEach((r) => clearTimeout(r.timer));
  state.reminders = [];
  [KEY_CURRENT, KEY_SESSIONS, KEY_REMINDERS].forEach((k) => {
    try { localStorage.removeItem(k); } catch (_e) { /* abaikan */ }
  });
  muatUlangPesan();
  ui.actionsPanel.innerHTML = "";
  ui.actionsPanel.hidden = true;
  perbaruiPilihanRiwayat();
  showToast("Riwayat dihapus.");
}

// ---------------------------------------------------------------------------
// AKSI TOOL DI LAYAR
// ---------------------------------------------------------------------------
function tambahBarisAksi(data) {
  ui.actionsPanel.hidden = false;
  const baris = document.createElement("div");
  baris.className = "action-row";
  baris.dataset.tool = data.tool || "";
  baris.innerHTML =
    '<span class="dot"></span>' +
    `<span class="action-label">${escapeHtml(data.label)}</span>` +
    `<span class="action-detail">${escapeHtml(data.detail || "")}</span>`;
  ui.actionsPanel.append(baris);
  if (data.status === "running") state.actionRows.set(data.tool, baris);
  else if (data.tool && state.actionRows.has(data.tool)) {
    const lama = state.actionRows.get(data.tool);
    lama.remove();
    state.actionRows.delete(data.tool);
  }
  if (data.status !== "running") baris.classList.add(data.status === "done" ? "done" : "error");
  while (ui.actionsPanel.children.length > 8) ui.actionsPanel.firstElementChild.remove();
  scrollBawah();
}

function tambahCatatanAksi(pesan) {
  ui.actionsPanel.hidden = false;
  const baris = document.createElement("div");
  baris.className = "action-row error";
  baris.innerHTML = `<span class="dot"></span><span class="action-label">${escapeHtml(pesan)}</span>`;
  ui.actionsPanel.append(baris);
  scrollBawah();
}

// ---------------------------------------------------------------------------
// SSE & KIRIM PESAN
// ---------------------------------------------------------------------------
async function konsumsiSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const proses = (blok) => {
    let event = "message";
    let data = "";
    for (const baris of blok.split("\n")) {
      if (baris.startsWith("event:")) event = baris.slice(6).trim();
      else if (baris.startsWith("data:")) data += (data ? "\n" : "") + baris.slice(5).trim();
    }
    if (data) onEvent(event, data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        proses(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer.trim()) proses(buffer);
  } finally {
    try { reader.releaseLock(); } catch (_e) { /* abaikan */ }
  }
}

async function kirimPesan(teks, opsi = {}) {
  const isi = String(teks || "").trim();
  if (!isi || state.busy) return;

  mintaIzinNotifikasi();
  ui.banner.hidden = true;
  if (!opsi.quiet) {
    ui.emptyState.hidden = true;
    tambahPesan("user", isi);
  } else {
    // Catatan hasil konfirmasi tetap masuk riwayat, tapi tidak digambar lagi.
    state.messages.push({ role: "user", content: isi, time: Date.now() });
    simpanSekarang();
  }

  state.busy = true;
  ui.thinking.hidden = false;
  ui.stopBtn.hidden = false;
  ui.sendBtn.hidden = true;
  ui.input.value = "";
  autoSizeInput();

  const controller = new AbortController();
  state.controller = controller;

  let pesanAI = null;
  let elemenAI = null;
  let teksAI = "";
  let selesai = false;

  const pastikanAI = () => {
    if (pesanAI) return pesanAI;
    pesanAI = { role: "assistant", content: "", time: Date.now() };
    state.messages.push(pesanAI);
    elemenAI = buatElemenPesan(pesanAI);
    ui.emptyState.hidden = true;
    ui.messages.append(elemenAI);
    simpanSekarang();
    return pesanAI;
  };

  const tulisToken = (potongan) => {
    pastikanAI();
    teksAI += potongan;
    pesanAI.content = teksAI;
    const markdown = elemenAI.querySelector(".markdown");
    if (markdown) markdown.innerHTML = renderMarkdown(teksAI) + '<span class="cursor">▋</span>';
    pasangTombolSalin(elemenAI);
    simpanSekarang();
    scrollBawah();
  };

  const akhiri = (alasan) => {
    if (selesai) return;
    selesai = true;
    state.busy = false;
    state.controller = null;
    ui.thinking.hidden = true;
    ui.stopBtn.hidden = true;
    ui.sendBtn.hidden = false;

    if (pesanAI) {
      const markdown = elemenAI.querySelector(".markdown");
      if (markdown) markdown.innerHTML = renderMarkdown(teksAI);
      pasangTombolSalin(elemenAI);
      simpanSekarang();
      if (teksAI.trim()) bicarakan(teksAI);
    }

    if (alasan === "need_confirm") {
      ui.thinking.hidden = true;
      showToast("Menunggu konfirmasi kamu.");
    }
    ui.input.focus();
  };

  try {
    const response = await fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404 && !API_BASE && /github\.io$/i.test(location.hostname)) {
        throw new Error("Backend belum terhubung. Isi apiBase di public/config.js dengan URL backend HTTPS dulu.");
      }
      let payload = null;
      try { payload = await response.json(); } catch (_e) { /* abaikan */ }
      throw new Error((payload && payload.error) || "Server merespons HTTP " + response.status + ".");
    }
    if (!response.body) throw new Error("Browser tidak mendukung streaming respons.");

    await konsumsiSSE(response, (event, data) => {
      let isi = null;
      try { isi = JSON.parse(data); } catch (_e) { return; }

      if (event === "meta") {
        ui.modelInfo.textContent = `${isi.model} · terhubung`;
        ui.modelInfo.classList.remove("offline");
      } else if (event === "token") {
        tulisToken(isi.text || "");
      } else if (event === "action") {
        tambahBarisAksi(isi);
      } else if (event === "reminder") {
        jadwalkanPengingat(isi);
      } else if (event === "notice") {
        showToast(isi.message || "");
        tambahCatatanAksi(isi.message || "Notifikasi");
      } else if (event === "confirm") {
        mintaKonfirmasi(isi);
      } else if (event === "done") {
        akhiri(isi.stopReason);
      } else if (event === "error") {
        showBanner(isi.message || "Terjadi kesalahan.", true);
        if (!pesanAI) {
          const galat = tambahPesan("assistant", "Maaf, " + (isi.message || "terjadi kesalahan."), { error: true });
          elemenAI = ui.messages.lastElementChild;
          bicarakan(galat.content);
        }
        akhiri("error");
      }
    });
    akhiri("done");
  } catch (error) {
    if (error.name === "AbortError") {
      showToast("Jawaban dihentikan.");
      if (pesanAI) {
        pesanAI.content = (teksAI || "_(dihentikan)_").trim();
        simpanSekarang();
      }
    } else {
      ui.modelInfo.textContent = "koneksi terputus";
      ui.modelInfo.classList.add("offline");
      showBanner(error.message || "Tidak bisa terhubung ke server.", true);
      if (!pesanAI) {
        const galat = tambahPesan("assistant", "Maaf, " + (error.message || "koneksi terputus."), { error: true });
        bicarakan(galat.content);
      }
    }
    akhiri("error");
  } finally {
    if (controller === state.controller) state.controller = null;
  }
}

// ---------------------------------------------------------------------------
// KONFIRMASI HAPUS
// ---------------------------------------------------------------------------
let konfirmasiAktif = null;

function mintaKonfirmasi(data) {
  konfirmasiAktif = data;
  ui.confirmText.textContent = data.description || "Yakin ingin melanjutkan aksi ini?";
  ui.confirmDetail.textContent = data.detail || "Data yang dihapus tidak bisa dikembalikan.";
  ui.confirmDialog.returnValue = "";
  ui.confirmDialog.showModal();
}

async function prosesKonfirmasi(approved) {
  if (!konfirmasiAktif) return;
  const data = konfirmasiAktif;
  konfirmasiAktif = null;
  try {
    const response = await fetch(API_BASE + "/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: data.id, approved }),
    });
    const hasil = await response.json();
    if (!response.ok || hasil.ok === false) throw new Error(hasil.error || "Konfirmasi gagal.");

    if (hasil.dibatalkan) {
      tambahBarisAksi({ tool: data.tool, label: "Aksi dibatalkan", detail: "Data tidak diubah", status: "error" });
      await kirimPesan("Pengguna membatalkan penghapusan. Jangan hapus data apa pun dan beri tahu dengan singkat.", { quiet: true });
    } else {
      tambahBarisAksi({
        tool: data.tool,
        label: hasil.label || "Aksi selesai",
        detail: hasil.detail || "",
        status: "done",
      });
      const pesan = (hasil.result && hasil.result.pesan) || "Aksi selesai.";
      await kirimPesan(`Aksi selesai: ${pesan} Konfirmasi hasilnya dengan singkat.`, { quiet: true });
    }
  } catch (error) {
    showBanner(error.message, true);
    tambahCatatanAksi(error.message);
  }
}

// ---------------------------------------------------------------------------
// PENGINGAT BROWSER
// ---------------------------------------------------------------------------
function mintaIzinNotifikasi() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

async function tampilkanNotifikasi(pesan) {
  showToast("⏰ " + pesan);
  bicarakan("Pengingat: " + pesan);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Pengingat Asisten AI", { body: pesan });
    } catch (_error) {
      /* beberapa browser mengharuskan service worker; toast tetap tampil */
    }
  }
}

function jadwalkanPengingat(data) {
  if (!data || !data.remindAt) return;
  const tunda = Number(data.remindAt) - Date.now();
  if (tunda <= 0) {
    tampilkanNotifikasi(data.pesan);
    return;
  }
  // setTimeout maksimal ~24.8 hari; pengingat lebih jauh dipesan ulang saat load.
  const aman = Math.min(tunda, 2_147_000_000);
  const timer = setTimeout(() => {
    tampilkanNotifikasi(data.pesan);
    state.reminders = state.reminders.filter((r) => r.id !== data.id);
    writeJSON(KEY_REMINDERS, state.reminders);
  }, aman);
  state.reminders.push({ id: data.id, pesan: data.pesan, remindAt: data.remindAt, timer });
  writeJSON(
    KEY_REMINDERS,
    state.reminders.map(({ id, pesan, remindAt }) => ({ id, pesan, remindAt }))
  );
  showToast(`Pengingat diatur untuk ${new Date(data.remindAt).toLocaleString("id-ID")}.`);
}

function pulihkanPengingat() {
  const sekarang = Date.now();
  state.reminders.forEach((r) => {
    if (r.remindAt <= sekarang) {
      tampilkanNotifikasi(r.pesan);
      return;
    }
    const timer = setTimeout(() => tampilkanNotifikasi(r.pesan), Math.min(r.remindAt - sekarang, 2_147_000_000));
    r.timer = timer;
  });
  state.reminders = state.reminders.filter((r) => r.remindAt > sekarang);
  writeJSON(KEY_REMINDERS, state.reminders);
}

// ---------------------------------------------------------------------------
// BICARA & MENDENGAR
// ---------------------------------------------------------------------------
function bicarakan(teks) {
  const bersih = bersihkanUntukSuara(teks);
  if (!state.tts || !bersih || !("speechSynthesis" in window)) {
    if (state.continuous) setTimeout(mulaiMendengar, 250);
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const ucapan = new SpeechSynthesisUtterance(bersih.slice(0, 900));
    ucapan.lang = "id-ID";
    ucapan.rate = 1;
    ucapan.pitch = 1;
    const suara = window.speechSynthesis.getVoices().find((v) => /^id(-|_)/i.test(v.lang)) ||
      window.speechSynthesis.getVoices().find((v) => /indonesia/i.test(v.name));
    if (suara) ucapan.voice = suara;
    const selesaiBicara = () => {
      ui.stopVoiceBtn.hidden = true;
      if (state.continuous) setTimeout(mulaiMendengar, 300);
    };
    ucapan.onend = selesaiBicara;
    ucapan.onerror = selesaiBicara;
    state.speechUtter = ucapan;
    ui.stopVoiceBtn.hidden = false;
    window.speechSynthesis.speak(ucapan);
  } catch (_error) {
    ui.stopVoiceBtn.hidden = true;
    if (state.continuous) setTimeout(mulaiMendengar, 300);
  }
}

function hentikanBicara() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.speechUtter = null;
  ui.stopVoiceBtn.hidden = true;
}

function mulaiMendengar() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showBanner("Browser ini belum mendukung pengenalan suara. Coba Chrome atau Edge, atau tetap ketik pesan ya.", true);
    return;
  }
  if (state.busy || state.listening) return;
  mintaIzinNotifikasi();

  const rec = new SpeechRecognition();
  rec.lang = "id-ID";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  state.recognition = rec;

  rec.onstart = () => {
    state.listening = true;
    ui.micBtn.classList.add("listening");
    ui.micBtn.setAttribute("aria-label", "Berhenti mendengar");
  };

  rec.onresult = (event) => {
    let sementara = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const teks = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) final += teks;
      else sementara += teks;
    }
    if (final) {
      ui.input.value = final;
      autoSizeInput();
      rec.onend = null; // sudah ada hasil, jangan aktifkan mic lagi otomatis
      setTimeout(() => kirimPesan(final), 60);
    } else if (sementara) {
      ui.input.value = sementara;
      autoSizeInput();
    }
  };

  rec.onerror = (event) => {
    const pesan = {
      "not-allowed": "Izin mikrofon ditolak. Buka pengaturan browser, izinkan mikrofon untuk situs ini, lalu coba lagi.",
      "service-not-allowed": "Layanan mikrofon diblokir browser. Periksa izin situs, ya.",
      "no-speech": "Aku tidak mendengar suara. Tekan mikrofon lagi dan bicara sedikit lebih dekat.",
      network: "Koneksi jaringan gangguan saat mengenali suara. Coba lagi.",
      aborted: "",
    }[event.error] || "Pengenalan suara gagal. Kamu tetap bisa mengetik pesan, ya.";
    if (pesan) showBanner(pesan, true);
  };

  rec.onend = () => {
    state.listening = false;
    ui.micBtn.classList.remove("listening");
    ui.micBtn.setAttribute("aria-label", "Mulai berbicara");
    state.recognition = null;
  };

  try {
    rec.start();
  } catch (error) {
    showBanner("Mikrofon sedang dipakai. Coba beberapa detik lagi, ya.", true);
  }
}

function hentikanMendengar() {
  if (state.recognition) {
    state.recognition.onend = null;
    try { state.recognition.stop(); } catch (_e) { /* abaikan */ }
  }
  state.listening = false;
  ui.micBtn.classList.remove("listening");
}

function hentikanSemua() {
  hentikanBicara();
  hentikanMendengar();
  if (state.controller) state.controller.abort();
  state.busy = false;
  ui.thinking.hidden = true;
  ui.stopBtn.hidden = true;
  ui.sendBtn.hidden = false;
}

// ---------------------------------------------------------------------------
// EVENT UI
// ---------------------------------------------------------------------------
function autoSizeInput() {
  ui.input.style.height = "auto";
  ui.input.style.height = Math.min(ui.input.scrollHeight, 130) + "px";
}

function terapkanTema() {
  document.documentElement.dataset.theme = state.prefs.theme === "light" ? "light" : "dark";
  ui.themeBtn.textContent = state.prefs.theme === "light" ? "🌙" : "☀️";
}

function simpanPrefs() {
  state.prefs.theme = document.documentElement.dataset.theme;
  state.prefs.tts = state.tts;
  state.prefs.continuous = state.continuous;
  writeJSON(KEY_PREFS, state.prefs);
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const teks = ui.input.value.trim();
  if (!teks) return;
  if (state.busy) {
    showToast("Tunggu jawaban sebelumnya selesai, ya.");
    return;
  }
  kirimPesan(teks);
});

ui.input.addEventListener("input", autoSizeInput);
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});

ui.micBtn.addEventListener("click", () => {
  if (state.listening) hentikanMendengar();
  else mulaiMendengar();
});

ui.stopBtn.addEventListener("click", () => {
  if (state.controller) state.controller.abort();
});

ui.stopVoiceBtn.addEventListener("click", hentikanBicara);

ui.ttsBtn.addEventListener("click", () => {
  state.tts = !state.tts;
  ui.ttsBtn.setAttribute("aria-pressed", String(state.tts));
  ui.ttsBtn.querySelector("span").textContent = state.tts ? "Suara menyala" : "Suara mati";
  if (!state.tts) hentikanBicara();
  simpanPrefs();
  showToast(state.tts ? "Bacakan suara menyala." : "Bacakan suara dimatikan.");
});

ui.continuousBtn.addEventListener("click", () => {
  state.continuous = !state.continuous;
  ui.continuousBtn.setAttribute("aria-pressed", String(state.continuous));
  ui.continuousBtn.querySelector("span").textContent = state.continuous ? "Ngobrol Terus aktif" : "Ngobrol Terus";
  simpanPrefs();
  showToast(state.continuous ? "Mode ngobrol terus aktif. Mikrofon menyala setelah AI selesai bicara." : "Mode ngobrol terus dimatikan.");
  if (state.continuous && !state.busy && !state.listening) setTimeout(mulaiMendengar, 250);
});

ui.themeBtn.addEventListener("click", () => {
  state.prefs.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  terapkanTema();
  simpanPrefs();
});

ui.newChatBtn.addEventListener("click", percakapanBaru);
ui.clearBtn.addEventListener("click", hapusSemuaRiwayat);

ui.historySelect.addEventListener("change", () => {
  const index = Number(ui.historySelect.value);
  if (!Number.isInteger(index) || index < 0 || !state.sessions[index]) return;
  hentikanSemua();
  const sesi = state.sessions.splice(index, 1)[0];
  state.messages = sesi.messages.slice();
  simpanSekarang();
  writeJSON(KEY_SESSIONS, state.sessions);
  muatUlangPesan();
  perbaruiPilihanRiwayat();
  showToast("Percakapan dimuat.");
});

el("chips").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-prompt]");
  if (chip) kirimPesan(chip.dataset.prompt);
});

ui.confirmDialog.addEventListener("close", () => {
  prosesKonfirmasi(ui.confirmDialog.returnValue === "setuju");
});

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
async function cekKoneksi() {
  try {
    const response = await fetch(API_BASE + "/api/health", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Server belum siap.");
    ui.modelInfo.textContent = `${data.model} · terhubung`;
    ui.modelInfo.classList.remove("offline");
  } catch (_error) {
    ui.modelInfo.textContent = "model belum jalan";
    ui.modelInfo.classList.add("offline");
    if (!API_BASE && /github\.io$/i.test(location.hostname)) {
      showBanner("Ini baru tampilan web-nya. Isi apiBase di public/config.js dengan URL backend HTTPS agar AI bisa menjawab.", true);
    } else {
      showBanner("Belum bisa terhubung ke backend. Jalankan server dengan \"node server.js\" dan pastikan model open source sudah aktif.", true);
    }
  }
}

async function init() {
  terapkanTema();
  ui.ttsBtn.setAttribute("aria-pressed", String(state.tts));
  ui.ttsBtn.querySelector("span").textContent = state.tts ? "Suara menyala" : "Suara mati";
  ui.continuousBtn.setAttribute("aria-pressed", String(state.continuous));
  ui.continuousBtn.querySelector("span").textContent = state.continuous ? "Ngobrol Terus aktif" : "Ngobrol Terus";

  ui.greeting.textContent = sapaanWaktu() + "!";
  ui.greetingSub.textContent = "Aku asisten AI kamu. Ketik pesan atau tekan mikrofon untuk bicara.";
  muatUlangPesan();
  perbaruiPilihanRiwayat();
  autoSizeInput();
  cekKoneksi();
  pulihkanPengingat();

  // Sapaan otomatis: tampil di layar, tanpa masuk riwayat model.
  if (!state.messages.length) {
    const sapaan = `${sapaanWaktu()}! Aku asisten AI kamu. Ada yang bisa kubantu hari ini?`;
    ui.messages.append(buatElemenPesan({ role: "assistant", content: sapaan, time: Date.now() }));
    ui.emptyState.hidden = true;
    setTimeout(() => bicarakan(sapaan), 500);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    ui.installBtn.hidden = false;
    ui.installBtn.addEventListener("click", async () => {
      event.prompt();
      await event.userChoice;
      ui.installBtn.hidden = true;
    }, { once: true });
  });

  if ("speechSynthesis" in window) {
    // Paksa daftar suara termuat di beberapa browser.
    window.speechSynthesis.getVoices();
  }
}

init();
