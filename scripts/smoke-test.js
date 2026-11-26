"use strict";

/* Smoke test backend tanpa browser. Jalankan saat server aktif:
 * node scripts/smoke-test.js */

const fs = require("fs");
const path = require("path");
const BASE = process.env.BASE_URL || "http://localhost:3000";

function check(nama, kondisi, detail = "") {
  console.log(`[${kondisi ? "LULUS" : "GAGAL"}] ${nama}${detail ? " — " + detail : ""}`);
  if (!kondisi) process.exitCode = 1;
}

(async () => {
  try {
    const healthRes = await fetch(BASE + "/api/health");
    const health = await healthRes.json();
    check("GET /api/health", healthRes.status === 200 && health.ok === true, JSON.stringify(health));

    const tools = ["catat_tugas", "atur_pengingat", "buat_catatan", "cari_web", "hitung", "info_waktu"];
    check("Enam tool terdaftar", tools.every((t) => (health.tools || []).includes(t)), (health.tools || []).join(", "));

    const page = await fetch(BASE + "/");
    const html = await page.text();
    check("GET / mengembalikan UI", page.status === 200 && html.includes("Asisten AI"));

    for (const file of ["/manifest.json", "/sw.js", "/app.js", "/styles.css", "/config.js"]) {
      const res = await fetch(BASE + file);
      const isi = await res.text();
      check(`GET ${file}`, res.status === 200 && isi.length > 20);
    }

    for (const ukuran of [192, 512]) {
      const res = await fetch(`${BASE}/icons/icon-${ukuran}.png`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const lebar = buffer.readUInt32BE(16);
      const tinggi = buffer.readUInt32BE(20);
      check(`GET /icons/icon-${ukuran}.png`, res.status === 200 && png && lebar === ukuran && tinggi === ukuran, `${lebar}x${tinggi}`);
    }

    // Validasi pesan dikirim server sebagai SSE error (bukan JSON).
    const invalid = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", content: "halo" }] }),
    });
    const isiInvalid = await invalid.text();
    check(
      "Validasi peran pesan",
      invalid.status === 200 && /event: error/.test(isiInvalid) && /Pesan terakhir/.test(isiInvalid),
      isiInvalid.trim().split("\n").slice(0, 2).join(" ")
    );

    const panjang = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "a".repeat(4001) }] }),
    });
    const isiPanjang = await panjang.text();
    check("Validasi panjang pesan", /terlalu panjang/.test(isiPanjang));

    const konfirmasi = await fetch(BASE + "/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "tidak-ada", approved: true }),
    });
    check("Konfirmasi tanpa id ditolak", konfirmasi.status === 400);

    // Kunci API tidak boleh ikut ter-bundel ke file frontend.
    const publicDir = path.join(__dirname, "..", "public");
    const bocor = fs.readdirSync(publicDir)
      .filter((nama) => /\.(js|css|html|json)$/.test(nama))
      .filter((nama) => /LLM_API_KEY|sk-ant-|sk-or-v1-|gsk_/.test(fs.readFileSync(path.join(publicDir, nama), "utf8")));
    check("Tidak ada kunci API di folder public", bocor.length === 0, bocor.join(", "));

    console.log("\nSelesai. Untuk menguji jawaban asli: tanya \"siapa kamu?\" lalu \"catat tugas tes\" di browser.");
  } catch (error) {
    console.error("Smoke test gagal:", error.message);
    process.exitCode = 1;
  }
})();
