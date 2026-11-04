/**
 * Import data dari Apps Script (Google Sheets) ke Firestore — sekali pakai.
 * Dilindungi CRON_SECRET. Body: hasil export JSON dari exportDataForMigration().
 * Dipanggil dengan POST { endpoint }/api/import-data dengan header Authorization: Bearer <CRON_SECRET>
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function db() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) throw new Error("Konfigurasi server belum lengkap.");
  const app = initializeApp({ credential: cert(JSON.parse(raw)) }, `import-${Date.now()}`);
  return getFirestore(app);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(401).json({ success: false, message: "Tidak diizinkan." });
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Metode tidak diizinkan." });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ success: false, message: "JSON tidak valid." }); }

  const { pelanggan = [], invoice = [], pembayaran = [], keluhan = [], informasi = [] } = body;
  const database = db();
  const batch = database.batch();
  let n = 0;

  for (const p of pelanggan) {
    batch.set(database.collection("pelanggan").doc(String(p.id)), p); n++;
  }
  for (const inv of invoice) {
    batch.set(database.collection("invoice").doc(), inv); n++;
  }
  for (const pay of pembayaran) {
    batch.set(database.collection("pembayaran").doc(), pay); n++;
  }
  for (const k of keluhan) {
    batch.set(database.collection("keluhan").doc(), k); n++;
  }
  if (informasi.length) {
    batch.set(database.collection("informasi").doc("broadcast"), { pesan: informasi[0].pesan || "" }); n++;
  }

  await batch.commit();
  return res.status(200).json({ success: true, imported: n });
}
