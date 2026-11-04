export default async function handler(req, res) {
  try {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
    const hasSa = raw.length > 0;
    let parsed = null, initErr = null, colErr = null, docs = null;
    try { parsed = JSON.parse(raw).project_id; } catch (e) { initErr = String(e); }
    try {
      const mod = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      const app = mod.initializeApp({ credential: mod.cert(JSON.parse(raw)) }, "dbg");
      const db = getFirestore(app);
      const snap = await db.collection("pelanggan").limit(1).get();
      docs = snap.size;
    } catch (e) { colErr = String(e && e.message || e); }
    res.status(200).json({ hasSa, len: raw.length, project: parsed, initErr, colErr, docs });
  } catch (e) { res.status(500).json({ fatal: String(e) }); }
}
