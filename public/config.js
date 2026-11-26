/*
 * Konfigurasi sisi browser. AMAN untuk dibaca publik: tidak boleh ada API key di sini.
 *
 * - Saat dijalankan lokal (localhost), apiBase kosong → memakai origin yang sama.
 * - Saat dibuka dari GitHub Pages, otomatis memakai backend HTTPS di Render.
 * - Untuk APK/hosting lain, ganti nilai BACKEND_URL di bawah.
 */
const BACKEND_URL = "https://asisten-ai-backend.onrender.com";

window.APP_CONFIG = {
  apiBase: /github\.io$/i.test(location.hostname) ? BACKEND_URL.replace(/\/+$/, "") : "",
  appName: "Asisten AI",
};
