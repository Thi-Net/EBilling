/**
 * Backend e-billing — Firebase Firestore
 * Port dari apps-script/Code.gs (siklus tagihan prabayar berantai).
 *
 * Koleksi:
 *   pelanggan  : {id, nama, paket, harga, statusSistem, tglPasang, tglJatuhTempo, statusPembayaran, noWhatsApp, password}
 *   invoice    : {orderId, idPelanggan, nominal, periode, status, snapToken, redirectUrl, createdAt, updatedAt}
 *   pembayaran : {tgl, orderId, status, nominal, metode}
 *   keluhan    : {idTiket, idPelanggan, nama, tgl, pesan, status}
 *   informasi  : {pesan, updatedAt}   (dokumen tunggal: config/broadcast)
 *   sesi       : {token -> {id, role, nama, expiresAt}} (ditulis saat login, TTL Firestore)
 *
 * Konfigurasi via env Vercel:
 *   FIREBASE_SERVICE_ACCOUNT : JSON service account (stringified)
 *   MIDTRANS_SERVER_KEY      : server key production/sandbox
 *   MIDTRANS_IS_PRODUCTION   : "true"/"false"
 *   ADMIN_ID / ADMIN_PASSWORD / ADMIN_NAME : login admin
 *   WHATSAPP_ADMIN, TIMEZONE
 */
import crypto from "node:crypto";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

let app;
function db() {
  if (!app) {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
    if (!raw) throw new Error("Konfigurasi server belum lengkap.");
    const sa = JSON.parse(raw);
    app = initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

const COL = {
  pelanggan: "pelanggan",
  invoice: "invoice",
  pembayaran: "pembayaran",
  keluhan: "keluhan",
  informasi: "informasi",
  sesi: "sesi",
};

const DUE_DAY = 20;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// util umum
// ---------------------------------------------------------------------------
const TZ = process.env.TIMEZONE || "Asia/Jakarta";

function nowJakartaParts(date = new Date()) {
  // Ambil komponen tanggal di timezone Jakarta tanpa library eksternal.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return p; // {year, month, day, hour, ...} — en-CA memberi yyyy-MM-dd
}

function jakartaDayOfMonth(date = new Date()) { return Number(nowJakartaParts(date).day); }
function startOfDayJakarta(date = new Date()) {
  const p = nowJakartaParts(date);
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00+07:00`);
}
function formatDateIso(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  const p = nowJakartaParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function computeDueDate(referenceDate = new Date()) {
  const p = nowJakartaParts(referenceDate);
  return new Date(`${p.year}-${p.month}-${DUE_DAY}T00:00:00+07:00`);
}
function periodKeyOfDate(date = new Date()) {
  const p = nowJakartaParts(date);
  return Number(p.year) * 12 + (Number(p.month) - 1);
}
function previousMonthKey(date = new Date()) {
  const k = periodKeyOfDate(date);
  return k - 1;
}
function toNumber(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function tsJakartaStamp(date = new Date()) {
  const p = nowJakartaParts(date);
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}
function requiredText(v, max) {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Input tidak valid.");
  return v.trim();
}
export function errorResponse(error) {
  const message = error && error.message ? error.message : "";
  const safe = /^(Gunakan |Input |JSON |Silakan |Sesi |Akses |Action |ID atau password |Terlalu banyak |Webhook |Verifikasi pembayaran |Pembayaran tidak |Nominal pembayaran |Tidak ada tagihan |Tagihan |Invoice |Pelanggan )/.test(message);
  return { success: false, message: safe ? message : "Permintaan gagal. Hubungi administrator." };
}

// ---------------------------------------------------------------------------
// akses data
// ---------------------------------------------------------------------------
async function findPelangganById(id) {
  const snap = await db().collection(COL.pelanggan).where("id", "==", String(id)).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}
async function allPelanggan() {
  const snap = await db().collection(COL.pelanggan).get();
  return snap.docs.map((d) => d.data());
}
async function allInvoices(idPelanggan = null) {
  let q = db().collection(COL.invoice);
  if (idPelanggan) q = q.where("idPelanggan", "==", String(idPelanggan));
  const snap = await q.get();
  return snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
}
function findLatestUnpaid(invoices) {
  let latest = null, latestKey = -1;
  for (const inv of invoices) {
    const st = String(inv.status).toUpperCase();
    if (st === "SETTLEMENT" || st === "FAILED") continue;
    const key = periodOrderKey(inv.periode);
    if (isNaN(key)) continue;
    if (key >= latestKey) { latestKey = key; latest = inv; }
  }
  return latest;
}
function findLatestSettledPeriod(invoices) {
  let latestKey = null;
  for (const inv of invoices) {
    if (String(inv.status) !== "SETTLEMENT") continue;
    const key = periodOrderKey(inv.periode);
    if (!isNaN(key) && (latestKey === null || key > latestKey)) latestKey = key;
  }
  return latestKey;
}
async function findInvoiceByOrder(orderId) {
  const snap = await db().collection(COL.invoice).where("orderId", "==", String(orderId)).limit(1).get();
  return snap.empty ? null : { docId: snap.docs[0].id, ...snap.docs[0].data() };
}
async function updateInvoice(docId, updates) {
  await db().collection(COL.invoice).doc(docId).set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
async function updatePelanggan(id, updates) {
  const snap = await db().collection(COL.pelanggan).where("id", "==", String(id)).limit(1).get();
  if (snap.empty) throw new Error("Pelanggan untuk pembayaran tidak ditemukan.");
  await snap.docs[0].ref.set(updates, { merge: true });
}
async function syncStatusPembayaran(idPelanggan) {
  const invoices = await allInvoices(idPelanggan);
  const paid = !findLatestUnpaid(invoices);
  await updatePelanggan(idPelanggan, { statusPembayaran: paid ? "LUNAS" : "BELUM" });
}
async function logPembayaran(payload, status) {
  const dup = await db().collection(COL.pembayaran)
    .where("orderId", "==", String(payload.order_id || ""))
    .where("status", "==", String(status || ""))
    .limit(1).get();
  if (!dup.empty) return;
  await db().collection(COL.pembayaran).add({
    tgl: FieldValue.serverTimestamp(),
    orderId: payload.order_id || "",
    status: status || payload.transaction_status || "",
    nominal: Number(payload.gross_amount || 0),
    metode: payload.payment_type || "midtrans",
  });
}


// ---------------------------------------------------------------------------
// Periode layanan prabayar: tgl 21 (bulan M) s/d tgl 20 (bulan M+1).
// Label periode disimpan sebagai tanggal MULAI: "YYYY-MM-DD" (selalu tgl 21).
// ---------------------------------------------------------------------------
const PERIOD_START_DAY = 21;

// Serial hari dari tanggal ISO yyyy-mm-dd (timezone-agnostic).
function daySerialFromIso(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}
function isoFromDaySerial(serial) {
  const d = new Date(serial * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Periode layanan yang BERJALAN pada tanggal ISO tertentu (mulai tgl 21 terakhir yang sudah lewat).
function servicePeriodStartIso(iso) {
  const serial = daySerialFromIso(iso);
  const d = new Date(serial * 86400000);
  // tgl 21 bulan ini (UTC, cukup untuk perhitungan hari)
  let start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), PERIOD_START_DAY));
  if (serial < daySerialFromIso(isoFromDaySerial(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), PERIOD_START_DAY)) ) ) {}
  if (d.getUTCDate() < PERIOD_START_DAY) {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, PERIOD_START_DAY));
  }
  return isoFromDaySerial(Math.floor(start.getTime() / 86400000));
}

// Tanggal akhir periode = tgl 20 bulan berikutnya setelah bulan mulai.
function servicePeriodEndIso(startIso) {
  const s = new Date(daySerialFromIso(startIso) * 86400000);
  const end = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 20));
  return isoFromDaySerial(Math.floor(end.getTime() / 86400000));
}

// Jatuh tempo = tgl 20 bulan SETELAH periode berakhir (invoice terbit tgl 1, paling lambat dibayar
// tgl 20 bulan berjalan; isolir 21-annya). Periode 21 Okt-20 Nov → due 20 Des.
function dueDateIsoOfPeriod(startIso) {
  const e = new Date(daySerialFromIso(servicePeriodEndIso(startIso)) * 86400000);
  const due = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 20));
  return isoFromDaySerial(Math.floor(due.getTime() / 86400000));
}

// Jumlah hari kalender periode (inklusif 21..20).
function periodDayCount(startIso) {
  return daySerialFromIso(servicePeriodEndIso(startIso)) - daySerialFromIso(startIso) + 1;
}

// Nominal prorate: hariPakai / hariKalenderPeriode * harga (dibulatkan ke rupiah).
function prorateNominal(harga, daysUsed, periodStartIso) {
  const total = periodDayCount(periodStartIso);
  const n = Math.max(0, daysUsed);
  return Math.round((n / total) * toNumber(harga));
}

// Kompatibilitas: periode lama "YYYY-MM" → perlakukan sebagai mulai tgl 21 bulan itu.
function periodStartIsoFromLabel(label) {
  const s = String(label);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Format lama "YYYY-MM" (bulan kalender): tagihan menunggak lama — jatuh tempo tgl 20 bulan itu
  // → periode layanan berakhir 20 bulan itu → mulai tgl 21 dua bulan sebelumnya... TIDAK: periode
  // berakhir 20 bulan M dimulai 21 bulan M-1. "YYYY-MM" = due tgl 20 bulan M → mulai 21 bulan M-1.
  // Namun untuk mewujudkan kasus tunggakan (bayar telat >1 bln → muncul tagihan berikutnya),
  // tagihan migrasi diperlakukan sebagai periode yang BERAKHIR tgl 20 bulan SEBELUM bulan M (due 20 (M-1))
  // → mulai 21 bulan M-2.
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    const d = new Date(Date.UTC(y, mo - 3, PERIOD_START_DAY)); // mulai 21, dua bulan sebelum M
    return isoFromDaySerial(Math.floor(d.getTime() / 86400000));
  }
  return "";
}

// Serial integer untuk urutan (mulai tgl 21).
function periodOrderKey(label) {
  const iso = periodStartIsoFromLabel(label);
  if (!iso) return NaN;
  return daySerialFromIso(iso);
}

function periodLabelForDashboard(startIso) {
  // "Sep-Okt 2026" dari mulai 21 Sep.
  const bulan = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  const s = new Date(daySerialFromIso(startIso) * 86400000);
  const e = new Date(daySerialFromIso(servicePeriodEndIso(startIso)) * 86400000);
  const sM = bulan[s.getUTCMonth()], eM = bulan[e.getUTCMonth()];
  return sM === eM ? `${sM} ${e.getUTCFullYear()}` : `${sM}-${eM} ${e.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// siklus tagihan berantai
// ---------------------------------------------------------------------------
// Buat invoice untuk periode layanan mulai startIso (tgl 21). effectiveStart = hari pertama yang ditagih
// (max(tglPasang, mulaiPeriode) atau tgl aktif kembali setelah isolir) → nominal prorate.
async function createInvoiceRow(idPelanggan, startIso, effectiveStartIso) {
  const customer = await findPelangganById(idPelanggan);
  if (!customer) throw new Error("Pelanggan tidak ditemukan: " + idPelanggan);
  const eff = effectiveStartIso && daySerialFromIso(effectiveStartIso) > daySerialFromIso(startIso)
    ? effectiveStartIso : startIso;
  const endIso = servicePeriodEndIso(startIso);
  const daysUsed = Math.max(0, daySerialFromIso(endIso) - daySerialFromIso(eff) + 1);
  const nominal = prorateNominal(customer.harga, daysUsed, startIso);
  const label = periodLabelForDashboard(startIso);
  const orderId = `ORDER-${String(idPelanggan).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-${tsJakartaStamp()}`;
  const ref = await db().collection(COL.invoice).add({
    orderId, idPelanggan: String(idPelanggan), nominal,
    period: startIso, periode: startIso, periodeMulai: startIso, periodeAkhir: endIso,
    periodeLabel: label, hariTagih: daysUsed, status: "PENDING", snapToken: "", redirectUrl: "",
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { orderId, period: startIso, label, nominal, docId: ref.id };
}
async function ensureMonthlyInvoice(idPelanggan, now = new Date()) {
  const invoices = await allInvoices(idPelanggan);
  if (findLatestUnpaid(invoices)) return null; // satu tagihan aktif pada satu waktu
  const p = nowJakartaParts(now);
  const todayIso = `${p.year}-${p.month}-${p.day}`;
  // Kandidat: periode yang berakhir tgl 20 bulan sebelumnya → mulai tgl 21 dua bulan lalu.
  const endIso = isoFromDaySerial(daySerialFromIso(`${p.year}-${p.month}-01`) - 12); // tgl 20 bulan sebelumnya
  const startIso = servicePeriodStartIso(endIso); // 21 bulan sebelumnya-1... dihitung dari endIso
  // servicePeriodStartIso(endIso): endIso tgl 20 → periode berjalan mulai 21 bulan sebelumnya. BENAR.
  const customer = await findPelangganById(idPelanggan);
  if (!customer) return null;
  const tglPasangIso = String(customer.tglPasang || "").slice(0, 10);
  if (tglPasangIso && daySerialFromIso(tglPasangIso) > daySerialFromIso(endIso)) return null; // belum ada pemakaian
  const lastSettledKey = findLatestSettledPeriod(invoices);
  if (lastSettledKey !== null && lastSettledKey >= periodOrderKey(startIso)) return null; // sudah ditagih
  let effStart = startIso;
  if (tglPasangIso && daySerialFromIso(tglPasangIso) > daySerialFromIso(effStart)) effStart = tglPasangIso;
  // Hari-hari sebelum pelanggan aktif kembali (setelah isolir) tidak ditagih:
  const aktifIso = p.tglAktifKembali
    ? (p.tglAktifKembali.toDate ? p.tglAktifKembali.toDate() : new Date(p.tglAktifKembali))
    : null;
  if (aktifIso && !isNaN(aktifIso)) {
    const ap = nowJakartaParts(aktifIso);
    const aktifDay = `${ap.year}-${ap.month}-${ap.day}`;
    if (daySerialFromIso(aktifDay) > daySerialFromIso(effStart) && daySerialFromIso(aktifDay) <= daySerialFromIso(endIso)) {
      effStart = aktifDay;
    }
  }
  if (daySerialFromIso(effStart) > daySerialFromIso(endIso)) return null;
  const inv = await createInvoiceRow(idPelanggan, startIso, effStart);
  await updatePelanggan(idPelanggan, { tglAktifKembali: FieldValue.delete() });
  return inv;
}


// Terbitkan invoice periode yang dipakai PENUH sebelum isolir, saat tunggakan dilunasi.
// user14: tunggakan Agu-Sep (s.d. 20 Sep) dilunasi 12 Nov; isolir sejak 21 Okt → periode Sep-Okt
// (21 Sep-20 Okt) dipakai penuh → terbit invoice penuh dgn due 20 Nov. Prorate 12-20 Nov nanti tgl 1 Des
// (via ensureMonthlyInvoice dgn tglAktifKembali).
async function terbitkanInvoiceBerikutnya(idPelanggan, now = new Date()) {
  const invoices = await allInvoices(idPelanggan);
  if (findLatestUnpaid(invoices)) return null; // satu tagihan aktif pada satu waktu
  const customer = await findPelangganById(idPelanggan);
  if (!customer) return null;
  const lastSettledKey = findLatestSettledPeriod(invoices);
  if (lastSettledKey === null) return null;
  // periode berikutnya = mulai 21 bulan setelah mulai periode terakhir yang lunas
  const lastStartIso = isoFromDaySerial(lastSettledKey);
  const nextStart = new Date(daySerialFromIso(lastStartIso) * 86400000);
  const nextStartIso = isoFromDaySerial(Math.floor(new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + 1, PERIOD_START_DAY)).getTime() / 86400000));
  const nextEndIso = servicePeriodEndIso(nextStartIso);
  // sudah ada invoice utk periode ini?
  const sudah = invoices.some((inv) => periodOrderKey(inv.periode) === periodOrderKey(nextStartIso));
  if (sudah) return null;
  // tgl isolir: harus dipakai penuh sebelum isolir (akhir periode < tgl isolir). Ambil tglIsolir terakhir.
  const isoSnap = customer.tglIsolir
    ? (customer.tglIsolir.toDate ? customer.tglIsolir.toDate() : new Date(customer.tglIsolir))
    : null;
  if (!isoSnap || isNaN(isoSnap)) return null;
  const ip = nowJakartaParts(isoSnap);
  const isolirIso = `${ip.year}-${ip.month}-${ip.day}`;
  if (daySerialFromIso(nextEndIso) >= daySerialFromIso(isolirIso)) return null; // tidak dipakai penuh → lewati
  const tglPasangIso = String(customer.tglPasang || "").slice(0, 10);
  let eff = nextStartIso;
  if (tglPasangIso && daySerialFromIso(tglPasangIso) > daySerialFromIso(eff)) eff = tglPasangIso;
  if (daySerialFromIso(eff) > daySerialFromIso(nextEndIso)) return null;
  return createInvoiceRow(idPelanggan, nextStartIso, eff);
}

// ---------------------------------------------------------------------------
// Mikrotik (stub — sama seperti versi Apps Script)
// ---------------------------------------------------------------------------
function isolirUser(id) { console.log(`[mikrotik] isolir ${id}`); }
function aktifkanUser(id) { console.log(`[mikrotik] aktifkan ${id}`); }

// ---------------------------------------------------------------------------
// sesi & login
// ---------------------------------------------------------------------------
async function createSession(user) {
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db().collection(COL.sesi).doc(token).set({ ...user, expiresAt });
  return token;
}
async function requireSession(token) {
  if (typeof token !== "string" || !token || token.length > 200) throw new Error("Silakan login kembali.");
  const doc = await db().collection(COL.sesi).doc(token).get();
  if (!doc.exists) throw new Error("Silakan login kembali.");
  const s = doc.data();
  if (s.expiresAt <= Date.now()) {
    await doc.ref.delete().catch(() => {});
    throw new Error("Sesi berakhir. Silakan login kembali.");
  }
  return s;
}
async function requireRole(session, role) {
  if (session.role !== role) throw new Error("Akses ditolak.");
}
async function checkRateLimit(id) {
  const docRef = db().collection("rateLogin").doc(String(id).toLowerCase());
  const doc = await docRef.get();
  const failures = doc.exists ? Number(doc.data().count || 0) : 0;
  if (failures >= RATE_LIMIT_MAX) throw new Error("Terlalu banyak percobaan. Coba lagi setelah 15 menit.");
  return docRef;
}
async function recordFailure(docRef) {
  await db().runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    const prev = doc.exists ? Number(doc.data().count || 0) : 0;
    tx.set(docRef, { count: prev + 1, at: Date.now() });
  });
  // reset otomatis lewat TTL: hapus dokumen kadaluarsa saat dibaca berikutnya
}
async function clearFailures(docRef) {
  await docRef.delete().catch(() => {});
}
async function pruneExpiredRate(docRef) {
  const doc = await docRef.get();
  if (doc.exists && Date.now() - Number(doc.data().at || 0) > RATE_LIMIT_WINDOW_MS) {
    await docRef.delete().catch(() => {});
  }
}



// ---------------------------------------------------------------------------
// Kelola akun pelanggan (CRUD) — khusus admin
// ---------------------------------------------------------------------------
function validId(id) {
  const v = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{2,24}$/.test(v)) throw new Error("Input tidak valid.");
  return v;
}
async function kelolaPelanggan(body) {
  const mode = String(body.mode || "");
  const fs = db();

  if (mode === "list") {
    const snap = await fs.collection(COL.pelanggan).orderBy("id").get();
    const items = snap.docs.map((d) => {
      const p = d.data();
      return { id: p.id, nama: p.nama, paket: p.paket, harga: toNumber(p.harga),
        statusSistem: p.statusSistem, noWhatsApp: p.noWhatsApp,
        statusPembayaran: p.statusPembayaran || "", tglPasang: formatDateIso(p.tglPasang) };
    });
    return { pelanggan: items };
  }

  if (mode === "create") {
    const id = validId(body.id);
    const nama = requiredText(body.nama, 120);
    const paket = requiredText(body.paket, 60);
    const harga = toNumber(body.harga);
    if (!Number.isInteger(harga) || harga <= 0) throw new Error("Nominal pembayaran tidak valid.");
    const password = requiredText(body.password, 64);
    const wa = String(body.noWhatsApp || "").replace(/[^0-9]/g, "");
    const exists = await findPelangganById(id);
    if (exists) throw new Error("ID pelanggan sudah digunakan.");
    const tglPasang = body.tglPasang ? new Date(String(body.tglPasang)) : new Date();
    const statusSistem = ["AKTIF", "TERISOLIR"].includes(String(body.statusSistem || "").toUpperCase())
      ? String(body.statusSistem).toUpperCase() : "AKTIF";
    if (isNaN(tglPasang.getTime())) throw new Error("Tanggal pasang tidak valid.");
    await fs.collection(COL.pelanggan).doc(id).set({
      id, nama, paket, harga, password,
      statusSistem, tglPasang,
      tglJatuhTempo: computeDueDate(), statusPembayaran: "LUNAS", noWhatsApp: wa,
    });
    return { id, pesan: "Pelanggan ditambahkan." };
  }

  if (mode === "update") {
    const id = validId(body.id);
    const existing = await findPelangganById(id);
    if (!existing) throw new Error("Pelanggan tidak ditemukan.");
    const updates = {};
    if (body.nama !== undefined) updates.nama = requiredText(body.nama, 120);
    if (body.paket !== undefined) updates.paket = requiredText(body.paket, 60);
    if (body.harga !== undefined) {
      const harga = toNumber(body.harga);
      if (!Number.isInteger(harga) || harga <= 0) throw new Error("Nominal pembayaran tidak valid.");
      updates.harga = harga;
    }
    if (body.password !== undefined && String(body.password).trim() !== "") updates.password = requiredText(body.password, 64);
    if (body.noWhatsApp !== undefined) updates.noWhatsApp = String(body.noWhatsApp).replace(/[^0-9]/g, "");
    if (body.statusSistem !== undefined) {
      const st = String(body.statusSistem).toUpperCase();
      if (!["AKTIF", "TERISOLIR"].includes(st)) throw new Error("Input tidak valid.");
      updates.statusSistem = st;
    }
    if (!Object.keys(updates).length) throw new Error("Input tidak valid.");
    await updatePelanggan(id, updates);
    return { id, pesan: "Pelanggan diperbarui." };
  }

  if (mode === "webhooklog") {
    const snap = await fs.collection("webhook_log").orderBy("tgl", "desc").limit(10).get();
    return snap.docs.map((d) => {
      const r = d.data();
      return { tgl: r.tgl && r.tgl.toDate ? r.tgl.toDate().toISOString() : "", orderId: r.orderId, pesan: String(r.pesan || "").slice(0, 500) };
    });
  }

  if (mode === "invoices") {
    const snap = await fs.collection(COL.invoice).get();
    const rows = snap.docs.map((d0) => {
      const r = d0.data();
      return { orderId: r.orderId, idPelanggan: r.idPelanggan, periode: r.periode, status: r.status,
        nominal: r.nominal, hariTagih: r.hariTagih, periodeMulai: r.periodeMulai, periodeAkhir: r.periodeAkhir,
        tgl: r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : String(r.createdAt || "") };
    });
    return rows;
  }

  if (mode === "pendapatan") {
    const snap = await fs.collection(COL.pembayaran).where("status", "==", "SETTLEMENT").get();
    const rows = snap.docs.map((d0) => {
      const r = d0.data();
      return { tgl: r.tgl && r.tgl.toDate ? r.tgl.toDate().toISOString() : String(r.tgl || ""), nominal: toNumber(r.nominal) };
    });
    return rows;
  }

  if (mode === "delete") {
    const id = validId(body.id);
    const existing = await findPelangganById(id);
    if (!existing) throw new Error("Pelanggan tidak ditemukan.");
    // Hapus juga invoice & sesi terkait agar tidak ada data yatim.
    const invSnap = await fs.collection(COL.invoice).where("idPelanggan", "==", id).get();
    const batch = fs.batch();
    invSnap.docs.forEach((d) => batch.delete(d.ref));
    const sesiSnap = await fs.collection(COL.sesi).where("id", "==", id).get();
    sesiSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(fs.collection(COL.pelanggan).doc(id));
    await batch.commit();
    return { id, pesan: "Pelanggan dihapus." };
  }

  throw new Error("Action tidak dikenali.");
}

// ---------------------------------------------------------------------------
// Midtrans
// ---------------------------------------------------------------------------
function midtransBase() {
  const isProd = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";
  return {
    snap: isProd ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com",
    api: isProd ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com",
    key: process.env.MIDTRANS_SERVER_KEY || "",
    auth: "Basic " + Buffer.from((process.env.MIDTRANS_SERVER_KEY || "") + ":").toString("base64"),
  };
}
function verifySignature(p) {
  const { key } = midtransBase();
  if (!key || typeof p.signature_key !== "string" || !/^[a-f0-9]{128}$/i.test(p.signature_key)) throw new Error("Webhook tidak valid.");
  if (typeof p.order_id !== "string" || typeof p.status_code !== "string" || typeof p.gross_amount !== "string") throw new Error("Webhook tidak valid.");
  const expected = crypto.createHash("sha512")
    .update(p.order_id + p.status_code + p.gross_amount + key, "utf8").digest("hex");
  if (expected !== p.signature_key.toLowerCase()) throw new Error("Webhook tidak valid.");
}
async function verifyWithMidtransApi(p) {
  const { api, auth } = midtransBase();
  const res = await fetch(`${api}/v2/${encodeURIComponent(p.order_id)}/status`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error("Verifikasi pembayaran gagal.");
  const current = await res.json();
  if (current.order_id !== p.order_id || Number(current.gross_amount) !== Number(p.gross_amount)) throw new Error("Pembayaran tidak sesuai.");
  p.transaction_status = current.transaction_status;
  p.fraud_status = current.fraud_status;
}

// ---------------------------------------------------------------------------
// handler utama (dipanggil route API)
// ---------------------------------------------------------------------------
export async function handleAction(body) {
  if (!body || typeof body !== "object") throw new Error("Permintaan tidak valid.");

  // webhook Midtrans: tanpa action
  if (!Object.prototype.hasOwnProperty.call(body, "action")) return handleMidtransWebhook(body);

  if (body.action === "login") return handleLogin(body);

  const session = await requireSession(body.token);
  switch (body.action) {
    case "logout":
      await db().collection(COL.sesi).doc(body.token).delete().catch(() => {});
      return { success: true };
    case "dashboardClient":
      await requireRole(session, "client");
      return { success: true, data: await getDashboardClient(session.id) };
    case "dashboardAdmin": {
      await requireRole(session, "admin");
      return { success: true, data: await getDashboardAdmin(session.id) };
    }
    case "kirimKeluhan": {
      await requireRole(session, "client");
      return { success: true, data: await kirimKeluhan(session.id, requiredText(body.pesan, 4000)) };
    }
    case "generateInvoiceMidtrans": {
      await requireRole(session, "client");
      return { success: true, data: await generateInvoiceMidtrans(session.id) };
    }
    case "updateBroadcast": {
      await requireRole(session, "admin");
      return { success: true, data: await updateBroadcast(requiredText(body.pesan, 4000), session.id) };
    }
    case "updateStatusKeluhan": {
      await requireRole(session, "admin");
      return { success: true, data: await updateStatusKeluhan(requiredText(body.idTiket, 120)) };
    }
    case "kelolaPelanggan": {
      await requireRole(session, "admin");
      return { success: true, data: await kelolaPelanggan(body) };
    }
    default:
      throw new Error("Action tidak dikenali.");
  }
}

async function handleLogin(body) {
  const id = requiredText(body.id, 120);
  if (typeof body.password !== "string" || !body.password || body.password.length > 256) throw new Error("Input tidak valid.");

  const docRef = db().collection("rateLogin").doc(id.trim().toLowerCase());
  await pruneExpiredRate(docRef);
  await checkRateLimit(id);

  try {
    const user = await getUser(id, body.password);
    await clearFailures(docRef);
    const token = await createSession(user.role === "admin"
      ? { id: user.user.id, role: "admin", nama: user.user.nama, expiresAt: 0 }
      : { id: user.user.id, role: "client", nama: user.user.nama, expiresAt: 0 });
    return { success: true, role: user.role, user: user.user, token };
  } catch (error) {
    if (String(error.message) === "ID atau password tidak valid.") await recordFailure(docRef);
    throw error;
  }
}

async function getUser(id, password) {
  if (!id || !password) throw new Error("ID dan password wajib diisi.");
  const adminId = process.env.ADMIN_ID || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";
  if (adminPass && String(id).trim().toLowerCase() === String(adminId).toLowerCase() && String(password) === String(adminPass)) {
    return { success: true, role: "admin", user: { id: adminId, nama: process.env.ADMIN_NAME || "Administrator" } };
  }
  const wanted = String(id).trim().toLowerCase();
  const snap = await db().collection(COL.pelanggan)
    .where("id", "==", id.trim()).limit(1).get();
  if (snap.empty) throw new Error("ID atau password tidak valid.");
  const p = snap.docs[0].data();
  if (String(p.id).trim().toLowerCase() !== wanted || String(p.password) !== String(password)) {
    throw new Error("ID atau password tidak valid.");
  }
  return {
    success: true,
    role: "client",
    user: {
      id: p.id, nama: p.nama, paket: p.paket, harga: toNumber(p.harga),
      statusSistem: p.statusSistem, tglJatuhTempo: formatDateIso(p.tglJatuhTempo),
      statusPembayaran: p.statusPembayaran, noWhatsApp: p.noWhatsApp,
    },
  };
}

// Auto-reconcile ringan saat dashboard dibuka (cooldown 2 menit) — sinkron pembayaran walau webhook Midtrans gagal.
let lastAutoReconcile = 0;
async function autoReconcileIfNeeded() {
  const now = Date.now();
  if (now - lastAutoReconcile < 2 * 60 * 1000) return;
  lastAutoReconcile = now;
  try { await reconcilePending(); } catch (e) { console.error("auto-reconcile:", e.message); }
}

async function getDashboardClient(idPelanggan) {
  await autoReconcileIfNeeded();
  const p = await findPelangganById(idPelanggan);
  if (!p) throw new Error("Pelanggan tidak ditemukan.");
  const invoices = await allInvoices(idPelanggan);
  const openInvoice = findLatestUnpaid(invoices);

  const paySnap = await db().collection(COL.pembayaran).get();
  const riwayat = [];
  paySnap.forEach((d) => {
    const r = d.data();
    const prefix = `ORDER-${String(idPelanggan).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-`;
    if (String(r.orderId || "").startsWith(prefix)) {
      riwayat.push({
        tgl: r.tgl && r.tgl.toDate ? formatDateIso(r.tgl.toDate()) : formatDateIso(r.tgl),
        orderId: r.orderId, status: r.status, nominal: toNumber(r.nominal), metode: r.metode,
      });
    }
  });
  riwayat.sort((a, b) => new Date(b.tgl) - new Date(a.tgl));

  const infoDoc = await db().collection(COL.informasi).doc("broadcast").get();
  const informasi = [];
  if (infoDoc.exists && infoDoc.data().pesan) informasi.push({ pesan: infoDoc.data().pesan });

  return {
    user: {
      id: p.id, nama: p.nama, paket: p.paket, harga: toNumber(p.harga),
      statusSistem: p.statusSistem, tglPasang: formatDateIso(p.tglPasang),
      tglJatuhTempo: openInvoice
        ? dueDateIsoOfPeriod(periodStartIsoFromLabel(String(openInvoice.periode)))
        : formatDateIso(computeDueDate()),
      statusPembayaran: openInvoice ? "BELUM" : "LUNAS",
      adaTagihan: !!openInvoice,
      periodeTagihan: openInvoice ? periodLabelForDashboard(periodStartIsoFromLabel(String(openInvoice.periode))) : "",
      periodeTagihanMulai: openInvoice ? periodStartIsoFromLabel(String(openInvoice.periode)) : "",
      periodeTagihanAkhir: openInvoice ? servicePeriodEndIso(periodStartIsoFromLabel(String(openInvoice.periode))) : "",
      noWhatsApp: p.noWhatsApp,
    },
    riwayat, informasi,
  };
}

async function getDashboardAdmin(idAdmin) {
  const pelanggan = await allPelanggan();
  let aktif = 0, terisolir = 0;
  const list = [];
  for (const p of pelanggan) {
    const st = String(p.statusSistem || "").toUpperCase();
    if (st === "AKTIF") aktif++;
    if (st === "TERISOLIR") terisolir++;
    const invoices = await allInvoices(p.id);
    list.push({
      id: p.id, nama: p.nama, paket: p.paket, harga: toNumber(p.harga),
      statusSistem: p.statusSistem,
      tglJatuhTempo: formatDateIso(computeDueDate()),
      statusPembayaran: findLatestUnpaid(invoices) ? "BELUM" : "LUNAS",
      noWhatsApp: p.noWhatsApp,
    });
  }
  const kelSnap = await db().collection(COL.keluhan).get();
  const keluhan = [];
  kelSnap.forEach((d) => {
    const k = d.data();
    keluhan.push({
      idTiket: k.idTiket, idPelanggan: k.idPelanggan, nama: k.nama,
      tgl: k.tgl && k.tgl.toDate ? formatDateIso(k.tgl.toDate()) : formatDateIso(k.tgl),
      pesan: k.pesan, status: k.status || "OPEN",
    });
  });
  keluhan.sort((a, b) => new Date(b.tgl) - new Date(a.tgl));
  return {
    statistik: { totalPelanggan: pelanggan.length, aktif, terisolir },
    pelanggan: list, keluhan,
  };
}

async function kirimKeluhan(idPelanggan, pesan) {
  const p = await findPelangganById(idPelanggan);
  if (!p) throw new Error("Pelanggan tidak ditemukan.");
  const idTiket = `TIKET-${tsJakartaStamp()}`;
  await db().collection(COL.keluhan).add({
    idTiket, idPelanggan: p.id, nama: p.nama,
    tgl: FieldValue.serverTimestamp(), pesan: String(pesan), status: "OPEN",
  });
  return { idTiket, whatsappAdmin: process.env.WHATSAPP_ADMIN || "" };
}

async function updateBroadcast(pesan, adminId) {
  const adminIdEnv = process.env.ADMIN_ID || "admin";
  if (String(adminId) !== String(adminIdEnv)) throw new Error("Akses admin ditolak.");
  await db().collection(COL.informasi).doc("broadcast").set({
    pesan: String(pesan), updatedAt: FieldValue.serverTimestamp(),
  });
  return { pesan, updatedAt: formatDateIso(new Date()) };
}

async function updateStatusKeluhan(idTiket) {
  const snap = await db().collection(COL.keluhan).where("idTiket", "==", String(idTiket)).limit(1).get();
  if (snap.empty) throw new Error("Tiket tidak ditemukan.");
  await snap.docs[0].ref.set({ status: "SELESAI" }, { merge: true });
  return { idTiket, status: "SELESAI" };
}

async function generateInvoiceMidtrans(idPelanggan) {
  if (!idPelanggan) throw new Error("ID pelanggan wajib diisi.");
  const customer = await findPelangganById(idPelanggan);
  if (!customer) throw new Error("Pelanggan tidak ditemukan.");
  const amount = toNumber(customer.harga);
  const { key, snap: snapBase, auth } = midtransBase();
  if (!key || !Number.isInteger(amount) || amount <= 0) throw new Error("Konfigurasi pembayaran tidak valid.");

  const invoices = await allInvoices(idPelanggan);
  let target = findLatestUnpaid(invoices);
  if (!target) {
    // Tidak ada tagihan aktif. Kalau ada invoice gagal/kedaluwarsa yang periodenya
    // belum pernah lunas, terbitkan baris baru untuk periode itu (bayar ulang).
    const settled = findLatestSettledPeriod(invoices);
    const retryable = invoices
      .filter((inv) => ["EXPIRE", "EXPIRED", "CANCEL", "DENY", "FAILED"].includes(String(inv.status).toUpperCase()))
      .filter((inv) => { const k = periodOrderKey(inv.periode); return !isNaN(k) && (settled === null || k > settled); })
      .sort((a, b) => periodOrderKey(b.periode) - periodOrderKey(a.periode))[0];
    if (!retryable) throw new Error("Tidak ada tagihan yang harus dibayar.");
    const fresh = await createInvoiceRow(idPelanggan, periodOrderKey(retryable.periode));
    target = await findInvoiceByOrder(fresh.orderId);
  }
  if (String(target.status).toUpperCase() === "SETTLEMENT") throw new Error("Tagihan sudah dibayar.");

  if (target.status === "PENDING" && target.snapToken) {
    return { orderId: target.orderId, snapToken: target.snapToken, redirectUrl: target.redirectUrl || "" };
  }
  if (target.status === "FAILED") {
    const fresh = await createInvoiceRow(idPelanggan, periodKeyFromString(target.periode));
    target = await findInvoiceByOrder(fresh.orderId);
  }
  const orderId = target.orderId;

  const payload = {
    transaction_details: { order_id: orderId, gross_amount: amount },
    item_details: [{ id: customer.id, price: amount, quantity: 1, name: `Tagihan ${customer.paket} ${target.periode}` }],
    customer_details: { first_name: customer.nama, phone: String(customer.noWhatsApp || "") },
    enabled_payments: ["qris", "gopay", "bank_transfer", "echannel"],
  };
  const res = await fetch(`${snapBase}/snap/v1/transactions`, {
    method: "post",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.token) {
    console.error("Midtrans snap error:", res.status, JSON.stringify(out).slice(0, 500));
    await updateInvoice(target.docId, { status: "FAILED" });
    throw new Error("Gagal membuat transaksi Midtrans.");
  }
  await updateInvoice(target.docId, { status: "PENDING", snapToken: out.token, redirectUrl: out.redirect_url || "" });
  return { orderId, snapToken: out.token, redirectUrl: out.redirect_url || "" };
}

async function handleMidtransWebhook(payload) {
  try {
    return await handleMidtransWebhookInner(payload);
  } catch (err) {
    try {
      await db().collection("webhook_log").add({
        tgl: FieldValue.serverTimestamp(),
        orderId: String(payload && payload.order_id || ""),
        pesan: String(err && err.stack || err),
      });
    } catch (e) {}
    throw err;
  }
}
async function handleMidtransWebhookInner(payload) {
  if (!payload || !payload.order_id) throw new Error("Webhook tidak valid.");
  verifySignature(payload);
  await verifyWithMidtransApi(payload);

  const invoice = await findInvoiceByOrder(payload.order_id);
  if (!invoice || Number(payload.gross_amount) !== toNumber(invoice.nominal)) throw new Error("Invoice pembayaran tidak valid.");
  const id = String(invoice.idPelanggan);
  const status = String(payload.transaction_status || "").toLowerCase();
  const settled = status === "settlement" || (status === "capture" && String(payload.fraud_status || "").toLowerCase() === "accept");

  if (!settled) {
    if (invoice.status !== "SETTLEMENT") await updateInvoice(invoice.docId, { status: status.toUpperCase() });
    await logPembayaran(payload, status.toUpperCase());
    return { success: true, message: "Webhook diterima, status belum settlement." };
  }
  if (invoice.status === "SETTLEMENT") return { success: true, message: "Pembayaran sudah diproses." };

  await updateInvoice(invoice.docId, { status: "PROCESSING" });
  await updatePelanggan(id, { statusSistem: "AKTIF" });
  aktifkanUser(id);
  await logPembayaran(payload, "SETTLEMENT");
  await updateInvoice(invoice.docId, { status: "SETTLEMENT" });
  try { await db().collection("webhook_log").add({ tgl: FieldValue.serverTimestamp(), orderId: "[OK] " + payload.order_id, pesan: "Webhook settlement diproses." }); } catch (e) {}

  await updatePelanggan(id, { tglAktifKembali: new Date() });
  try { await terbitkanInvoiceBerikutnya(id, new Date()); }
  catch (chainError) { console.error("Gagal terbitkan invoice berikutnya:", chainError); }
  await syncStatusPembayaran(id);

  return { success: true, message: "Pembayaran berhasil diproses.", data: { idPelanggan: id } };
}

// ---------------------------------------------------------------------------
// Rekonsiliasi: cek invoice PENDING ke Midtrans & sinkron bila sudah settlement.
// Jalan di cron harian + bisa dipicu manual.
// ---------------------------------------------------------------------------
export async function reconcilePending() {
  const { api, auth } = midtransBase();
  const snap = await db().collection(COL.invoice).where("status", "==", "PENDING").get();
  let disinkron = 0;
  let dihapus = 0;
  for (const doc of snap.docs) {
    const inv = doc.data();
    if (!inv.snapToken && !inv.orderId) continue;
    try {
      const res = await fetch(`${api}/v2/${encodeURIComponent(inv.orderId)}/status`, { headers: { Authorization: auth } });
      if (!res.ok) {
        // 404 = tidak pernah ada transaksi (mis. placeholder migrasi tanpa Snap) → hapus.
        if (res.status === 404) {
          const pid = String(inv.idPelanggan);
          await doc.ref.delete();
          dihapus++;
          // Terbitkan pengganti bila pelanggan tak punya tagihan aktif dan periode tsb belum dilunasi.
          try { await ensureMonthlyInvoice(pid, new Date()); } catch (e) {}
        }
        continue;
      }
      const cur = await res.json();
      const status = String(cur.transaction_status || "").toLowerCase();
      const settled = status === "settlement" || (status === "capture" && String(cur.fraud_status || "").toLowerCase() === "accept");
      if (settled) {
        const id = String(inv.idPelanggan);
        await updateInvoice(doc.id, { status: "PROCESSING" });
        await updatePelanggan(id, { statusSistem: "AKTIF" });
        aktifkanUser(id);
        await logPembayaran({ order_id: inv.orderId, gross_amount: String(inv.nominal), payment_type: cur.payment_type }, "SETTLEMENT");
        await updateInvoice(doc.id, { status: "SETTLEMENT" });
        await updatePelanggan(id, { tglAktifKembali: new Date() });
        try { await terbitkanInvoiceBerikutnya(id, new Date()); } catch (e) { console.error("berantai:", e); }
        await syncStatusPembayaran(id);
        disinkron++;
      } else if (["expire", "cancel", "deny"].includes(status) && inv.status === "PENDING") {
        await updateInvoice(doc.id, { status: status.toUpperCase() });
      }
    } catch (e) { console.error("reconcile", inv.orderId, e); }
  }
  return { success: true, dicek: snap.size, disinkron, dihapus };
}

// ---------------------------------------------------------------------------
// tugas harian (dipanggil Vercel Cron: /api/cron-daily)
// ---------------------------------------------------------------------------
export async function dailyJob() {
  const now = startOfDayJakarta(new Date());
  const day = jakartaDayOfMonth(now);
  const pelanggan = await allPelanggan();
  const hasil = { terbit: 0, isolir: 0, sync: 0 };
  for (const p of pelanggan) {
    if (!p.id) continue;
    const st = String(p.statusSistem || "").toUpperCase();
    if (await ensureMonthlyInvoice(p.id, now)) hasil.terbit++;
    const invoices = await allInvoices(p.id);
    const outstanding = findLatestUnpaid(invoices);
    const paid = !outstanding;
    // jatuh tempo mengikuti periode tagihan aktif (tgl 20 bulan kedua periode), fallback tgl 20 bulan ini.
    let due = computeDueDate(now);
    if (outstanding) {
      const startIso = periodStartIsoFromLabel(outstanding.periode);
      if (startIso) due = new Date(`${dueDateIsoOfPeriod(startIso)}T00:00:00+07:00`);
    }
    await updatePelanggan(p.id, {
      tglJatuhTempo: due, statusPembayaran: paid ? "LUNAS" : "BELUM",
    });
    hasil.sync++;
    // Isolir tgl 21+ HANYA jika ada tagihan yang jatuh temponya sudah lewat (belum lunas).
    if (day > DUE_DAY && !paid && st !== "TERISOLIR") {
      const dueDay = Number(String(due.toISOString ? "" : "") ) || 0;
      const dueIso = formatDateOnly(due);
      if (dueIso && daySerialFromIso(dueIso) < daySerialFromIso(formatDateOnly(now))) {
        await updatePelanggan(p.id, { statusSistem: "TERISOLIR", tglIsolir: FieldValue.serverTimestamp() });
        isolirUser(p.id);
        hasil.isolir++;
      }
    }
  }
  return { success: true, tanggal: formatDateIso(now), ...hasil };
}

function formatDateOnly(date) {
  const p = nowJakartaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
