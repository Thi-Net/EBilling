const ACTIONS = new Set([
  "login", "logout", "dashboardClient", "dashboardAdmin", "kirimKeluhan",
  "updateBroadcast", "updateStatusKeluhan", "generateInvoiceMidtrans"
]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const fail = (status, message) => res.status(status).json({ success: false, message });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(405, "Metode tidak diizinkan.");
  }
  if (Object.keys(req.query || {}).length || (req.url || "").includes("?")) {
    return fail(400, "Parameter URL tidak diizinkan.");
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return fail(400, "JSON tidak valid.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "Permintaan tidak valid.");
  }
  const isAction = Object.prototype.hasOwnProperty.call(body, "action");
  if (isAction) {
    if (!ACTIONS.has(body.action)) return fail(400, "Aksi tidak diizinkan.");
  } else {
    if (Object.keys(body).some((key) => !["order_id", "status_code", "gross_amount", "signature_key", "transaction_status", "fraud_status", "payment_type"].includes(key))) return fail(400, "Notifikasi pembayaran tidak valid.");
    const fields = ["order_id", "status_code", "gross_amount", "signature_key", "transaction_status"];
    if (!fields.every((key) => typeof body[key] === "string" && body[key].trim())) {
      return fail(400, "Notifikasi pembayaran tidak valid.");
    }
  }
  if (isAction && Object.keys(body).some((key) => !["action", "token", "id", "password", "idPelanggan", "pesan", "idTiket"].includes(key))) return fail(400, "Parameter tidak diizinkan.");

  const scriptUrl = (process.env.SCRIPT_URL || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(scriptUrl)) {
    return fail(500, "Layanan belum tersedia.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) return fail(502, "Layanan sedang bermasalah.");
    const result = JSON.parse(await response.text());
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.success !== "boolean") {
      return fail(502, "Respons layanan tidak valid.");
    }
    // Webhook gagal harus non-2xx agar Midtrans mengulang pengiriman.
    if (!isAction && !result.success) {
      res.setHeader("Retry-After", "30");
      return res.status(502).json(result);
    }
    return res.status(200).json(result);
  } catch {
    return fail(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? "Waktu tunggu layanan habis." : "Layanan tidak dapat dihubungi.");
  } finally {
    clearTimeout(timeout);
  }
}
