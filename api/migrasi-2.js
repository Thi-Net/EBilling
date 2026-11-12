import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeApp, cert, getApps } from "firebase-admin/app";
function db() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(401).json({ success: false });
  const out = { pembayaran: 0, invoice: 0, pelanggan: 0, tagihan: 0 };
  // 1) hapus semua riwayat pembayaran
  const pay = await db().collection("pembayaran").get();
  const b1 = db().batch();
  pay.docs.forEach((d) => { b1.delete(d.ref); out.pembayaran++; });
  await b1.commit();
  // 2) hapus semua invoice
  const inv = await db().collection("invoice").get();
  const b2 = db().batch();
  inv.docs.forEach((d) => { b2.delete(d.ref); out.invoice++; });
  await b2.commit();
  // 3+4) semua pelanggan: TERISOLIR, tglIsolir 21 Okt, invoice tunggakan periode 21 Agu-20 Sep (PENDING, penuh)
  const pel = await db().collection("pelanggan").get();
  for (const d of pel.docs) {
    const p = d.data();
    const harga = Number(p.harga) || 0;
    await d.ref.set({
      statusSistem: "TERISOLIR",
      tglIsolir: new Date("2026-10-21T00:00:00+07:00"),
      tglAktifKembali: FieldValue.delete(),
      statusPembayaran: "BELUM",
      tglJatuhTempo: new Date("2026-10-20T00:00:00+07:00"),
    }, { merge: true });
    out.pelanggan++;
    await db().collection("invoice").add({
      orderId: `ORDER-${String(p.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-MIGRASI2`,
      idPelanggan: p.id, nominal: harga,
      period: "2026-08-21", periode: "2026-08-21", periodeMulai: "2026-08-21", periodeAkhir: "2026-09-20",
      periodeLabel: "Agu-Sep 2026", hariTagih: 31, status: "PENDING", snapToken: "", redirectUrl: "",
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    out.tagihan++;
  }
  return res.status(200).json({ success: true, ...out });
}
