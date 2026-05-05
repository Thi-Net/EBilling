export default async function handler(req, res) {
  const SCRIPT_URL = process.env.SCRIPT_URL;

  if (!SCRIPT_URL) {
    return res.status(500).json({
      success: false,
      msg: "SCRIPT_URL belum diset di Vercel"
    });
  }

  try {
    const cleanUrl = SCRIPT_URL.trim().replace(/['"]+/g, "");
    const urlParams = new URLSearchParams(req.query).toString();
    const finalUrl = cleanUrl.includes("?")
      ? `${cleanUrl}&${urlParams}`
      : `${cleanUrl}?${urlParams}`;

    const response = await fetch(finalUrl, {
      method: req.method,
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await response.text();
    return res.status(200).send(text);
  } catch (error) {
    return res.status(500).json({
      success: false,
      msg: "Proxy error",
      error_debug: error.message
    });
  }
}
