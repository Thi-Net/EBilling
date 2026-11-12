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
  const id = (req.query.id || "").toString();
  const iso = (req.query.isolir || "").toString();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return res.status(400).json({ success: false });
  const snap = await db().collection("pelanggan").doc(id).set({ tglIsolir: new Date(iso + "T00:00:00+07:00") }, { merge: true });
  return res.status(200).json({ success: true, id, isolir: iso });
}
