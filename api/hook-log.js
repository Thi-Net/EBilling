// Endpoint diagnosa: mencatat SEMUA request mentah (header + body) ke Firestore webhook_log.
// Untuk membuktikan apakah notifikasi Midtrans benar-benar sampai ke domain baru.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function db() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  try {
    let body = req.body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch (e) { body = String(req.body).slice(0, 500); }
    await db().collection("webhook_log").add({
      tgl: FieldValue.serverTimestamp(),
      orderId: "[RAW] " + (body && body.order_id ? body.order_id : "(kosong)"),
      pesan: JSON.stringify({
        method: req.method,
        host: (req.headers.host || ""),
        ua: (req.headers["user-agent"] || "").slice(0, 120),
        ct: (req.headers["content-type"] || ""),
        body,
      }).slice(0, 900),
    });
  } catch (e) {
    console.error("hook-log error:", e);
  }
  return res.status(200).json({ success: true });
}
