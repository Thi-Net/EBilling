import { handleAction } from "./lib/backend.js";
export default async function handler(req, res) {
  try { res.status(200).json({ backend: "loaded" }); } catch (e) { res.status(500).json({ err: String(e) }); }
}
