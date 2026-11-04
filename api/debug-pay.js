export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(401).json({ success: false });
  const key = process.env.MIDTRANS_SERVER_KEY || "";
  const isProd = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";
  const base = isProd ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com";
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const orderId = "DEBUG-" + Date.now();
  const payload = { transaction_details: { order_id: orderId, gross_amount: 100000 }, item_details: [{ id: "dbg", price: 100000, quantity: 1, name: "debug" }] };
  const r = await fetch(base + "/snap/v1/transactions", { method: "post", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await r.text();
  return res.status(200).json({ status: r.status, isProd, keyPrefix: key.slice(0, 12), keyLen: key.length, body: body.slice(0, 600) });
}
