import { reconcilePending } from "./lib/backend.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(401).json({ success: false, message: "Tidak diizinkan." });
  try {
    return res.status(200).json(await reconcilePending());
  } catch (error) {
    console.error("reconcile error:", error);
    return res.status(500).json({ success: false, message: "Rekonsiliasi gagal." });
  }
}
