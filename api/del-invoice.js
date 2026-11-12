import { getFirestore } from "firebase-admin/firestore";
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
  const orderId = (req.query.orderId || "").toString();
  if (!orderId) return res.status(400).json({ success: false });
  const snap = await db().collection("invoice").where("orderId", "==", orderId).limit(1).get();
  if (snap.empty) return res.status(404).json({ success: false });
  await snap.docs[0].ref.delete();
  return res.status(200).json({ success: true, deleted: orderId });
}
