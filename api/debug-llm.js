import { errorResponse } from "./lib/backend.js";

export default async function handler(req, res) {
  try {
    const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
    const steps = { hasBase: !!LLM_BASE_URL, hasKey: !!LLM_API_KEY, hasModel: !!LLM_MODEL, basePrefix: (LLM_BASE_URL||"").slice(0,40), model: LLM_MODEL||"" };
    if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) return res.status(200).json({ ok: false, steps });
    const url = LLM_BASE_URL.replace(/\/+$/, "") + "/chat/completions";
    const res2 = await fetch(url, {
      method: "post",
      headers: { Authorization: "Bearer " + LLM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "user", content: "Balas satu kata: siap" }], max_tokens: 10 }),
    });
    const text = await res2.text();
    return res.status(200).json({ ok: res2.ok, status: res2.status, urlPrefix: url.slice(0, 60), body: text.slice(0, 300) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
}
