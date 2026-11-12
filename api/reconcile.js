import { reconcilePending } from "./lib/backend.js";

export default async function handler(req, res) {
  // Vercel Cron mengirim header khusus; akses manual pakai Bearer CRON_SECRET.
  const isVercelCron = req.headers["x-vercel-cron"] !== undefined;
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!isVercelCron && (!secret || provided !== secret)) {
    return res.status(401).json({ success: false, message: "Tidak diizinkan." });
  }
  try {
    return res.status(200).json(await reconcilePending());
  } catch (error) {
    console.error("reconcile error:", error);
    return res.status(500).json({ success: false, message: "Rekonsiliasi gagal." });
  }
}
