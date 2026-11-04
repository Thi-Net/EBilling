import { handleAction } from "./lib/backend.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(401).json({ success: false });
  try {
    const login = await handleAction({ action: "login", id: "user5", password: "user123" });
    const result = await handleAction({ action: "generateInvoiceMidtrans", token: login.token });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return res.status(200).json({ ok: false, error: String(error && error.message || error), stack: String(error && error.stack || "").slice(0, 800) });
  }
}
