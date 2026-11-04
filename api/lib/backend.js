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
function periodToString(key) {
  const y = Math.floor(key / 12);
  const m = key % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}
function periodKeyFromString(s) {
  const parts = String(s).split("-");
  return Number(parts[0]) * 12 + (Number(parts[1]) - 1);
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
    if (String(inv.status) === "SETTLEMENT") continue;
    const key = periodKeyFromString(inv.periode);
    if (isNaN(key)) continue;
    if (key >= latestKey) { latestKey = key; latest = inv; }
  }
  return latest;
}
function findLatestSettledPeriod(invoices) {
  let latestKey = null;
  for (const inv of invoices) {
    if (String(inv.status) !== "SETTLEMENT") continue;
    const key = periodKeyFromString(inv.periode);
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
// siklus tagihan berantai
// ---------------------------------------------------------------------------
async function createInvoiceRow(idPelanggan, periodKey) {
  const customer = await findPelangganById(idPelanggan);
  if (!customer) throw new Error("Pelanggan tidak ditemukan: " + idPelanggan);
  const period = periodToString(periodKey);
  const orderId = `ORDER-${String(idPelanggan).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-${tsJakartaStamp()}`;
  const ref = await db().collection(COL.invoice).add({
    orderId, idPelanggan: String(idPelanggan), nominal: toNumber(customer.harga),
    period, periode: period, status: "PENDING", snapToken: "", redirectUrl: "",
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { orderId, period, docId: ref.id };
}
async function ensureMonthlyInvoice(idPelanggan, now = new Date()) {
  const invoices = await allInvoices(idPelanggan);
  if (findLatestUnpaid(invoices)) return null;
  const candidateKey = previousMonthKey(now);
  const lastSettledKey = findLatestSettledPeriod(invoices);
  if (lastSettledKey !== null && candidateKey <= lastSettledKey) return null;
  return createInvoiceRow(idPelanggan, candidateKey);
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
    await fs.collection(COL.pelanggan).doc(id).set({
      id, nama, paket, harga, password,
      statusSistem: "AKTIF", tglPasang: new Date(),
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

async function getDashboardClient(idPelanggan) {
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
      tglJatuhTempo: formatDateIso(computeDueDate()),
      statusPembayaran: openInvoice ? "BELUM" : "LUNAS",
      adaTagihan: !!openInvoice,
      periodeTagihan: openInvoice ? String(openInvoice.periode) : "",
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
  if (!target) throw new Error("Tidak ada tagihan yang harus dibayar.");
  if (target.status === "SETTLEMENT") throw new Error("Tagihan sudah dibayar.");

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

  try { await ensureMonthlyInvoice(id, new Date()); }
  catch (chainError) { console.error("Gagal terbitkan invoice berantai:", chainError); }
  await syncStatusPembayaran(id);

  return { success: true, message: "Pembayaran berhasil diproses.", data: { idPelanggan: id } };
}

// ---------------------------------------------------------------------------
// tugas harian (dipanggil Vercel Cron: /api/cron-daily)
// ---------------------------------------------------------------------------
export async function dailyJob() {
  const now = startOfDayJakarta(new Date());
  const day = jakartaDayOfMonth(now);
  const due = computeDueDate(now);
  const pelanggan = await allPelanggan();
  const hasil = { terbit: 0, isolir: 0, sync: 0 };
  for (const p of pelanggan) {
    if (!p.id) continue;
    if (day === 1) { if (await ensureMonthlyInvoice(p.id, now)) hasil.terbit++; }
    const invoices = await allInvoices(p.id);
    const outstanding = findLatestUnpaid(invoices);
    const paid = !outstanding;
    const st = String(p.statusSistem || "").toUpperCase();
    await updatePelanggan(p.id, {
      tglJatuhTempo: due, statusPembayaran: paid ? "LUNAS" : "BELUM",
    });
    hasil.sync++;
    if (day > DUE_DAY && !paid && st !== "TERISOLIR") {
      await updatePelanggan(p.id, { statusSistem: "TERISOLIR" });
      isolirUser(p.id);
      hasil.isolir++;
    }
  }
  return { success: true, tanggal: formatDateIso(now), ...hasil };
}
