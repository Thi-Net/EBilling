/**
 * API utama — memproses action JSON (login, dashboard, dll.) langsung ke Firestore.
 * Menggantikan peran proxy → Apps Script. Respons identik dengan backend lama.
 */
import { handleAction, errorResponse } from "./lib/backend.js";

const ACTIONS = new Set([
  "login", "logout", "dashboardClient", "dashboardAdmin", "kirimKeluhan",
  "updateBroadcast", "updateStatusKeluhan", "generateInvoiceMidtrans", "kelolaPelanggan", "kelolaPaket",
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
    if (Object.keys(body).some((key) => !["action", "token", "id", "password", "idPelanggan", "pesan", "idTiket", "mode", "nama", "paket", "harga", "noWhatsApp", "statusSistem", "tglPasang", "password", "nominal"].includes(key))) {
      return fail(400, "Parameter tidak diizinkan.");
    }
  } else {
    // Webhook Midtrans: field inti wajib ada; field lain diabaikan (payload Midtrans bervariasi).
    const fields = ["order_id", "status_code", "gross_amount", "signature_key", "transaction_status"];
    if (!fields.every((key) => typeof body[key] === "string" && body[key].trim())) {
      return fail(400, "Notifikasi pembayaran tidak valid.");
    }
  }

  try {
    const result = await handleAction(body);
    if (!isAction && !result.success) {
      // Signature tidak valid = bukan notifikasi dari Midtrans (mis. tombol "Test
      // Notification" di dashboard) → cukup 200 agar Midtrans tidak mengulang.
      if (String(result.message) === "Webhook tidak valid.") {
        return res.status(200).json(result);
      }
      res.setHeader("Retry-After", "30");
      return res.status(502).json(result);
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error("[proxy] error:", error && (error.stack || error.message || error));
    return res.status(200).json(errorResponse(error));
  }
}
