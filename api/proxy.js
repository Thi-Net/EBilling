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
    const searchParams = new URLSearchParams();
    const query = req.query || {};
    const queryKeys = Object.keys(query);
    let i;
    let key;
    let value;

    for (i = 0; i < queryKeys.length; i++) {
      key = queryKeys[i];
      value = query[key];

      if (Array.isArray(value)) {
        value.forEach(function(item) {
          searchParams.append(key, item);
        });
      } else if (typeof value !== "undefined") {
        searchParams.append(key, value);
      }
    }

    const urlParams = searchParams.toString();
    const finalUrl = cleanUrl.includes("?")
      ? (urlParams ? `${cleanUrl}&${urlParams}` : cleanUrl)
      : (urlParams ? `${cleanUrl}?${urlParams}` : cleanUrl);

    const requestInit = {
      method: req.method,
      headers: {
        "Accept": "application/json"
      }
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      requestInit.headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(req.body || {});
    }

    const response = await fetch(finalUrl, requestInit);

    const text = await response.text();
    return res.status(response.status || 200).send(text);
  } catch (error) {
    return res.status(500).json({
      success: false,
      msg: "Proxy error",
      error_debug: error.message
    });
  }
}
