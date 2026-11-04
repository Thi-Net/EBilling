/**
 * Cron harian — dipanggil Vercel Cron setiap hari (lihat vercel.json).
 * Melakukan: terbitkan invoice tgl 1, sinkron status, isolir lewat tgl 20.
 * Dilindungi secret CRON_SECRET via header Authorization.
 */
import { dailyJob } from "./_lib/backend.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return res.status(401).json({ success: false, message: "Tidak diizinkan." });
  }
  try {
    return res.status(200).json(await dailyJob());
  } catch (error) {
    console.error("dailyJob error:", error);
    return res.status(500).json({ success: false, message: "Tugas harian gagal." });
  }
}
