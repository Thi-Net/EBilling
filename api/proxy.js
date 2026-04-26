export default async function handler(req, res) {
  // 1. Ambil URL rahasia
  const SCRIPT_URL = process.env.SCRIPT_URL;

  // 2. PROTEKSI: Cek apakah variabelnya ada
  if (!SCRIPT_URL) {
    return res.status(500).json({ 
      success: false, 
      msg: "Variabel Key kosong di Vercel Dashboard!" 
    });
  }

  try {
    // 3. PEMBERSIHAN EKSTRIM: Hapus spasi, tanda kutip, atau karakter aneh
    const cleanUrl = SCRIPT_URL.trim().replace(/['"]+/g, '');
    
    // 4. Susun parameter secara manual (lebih aman dari error construct URL)
    const urlParams = new URLSearchParams(req.query).toString();
    const finalUrl = cleanUrl.includes('?') 
      ? `${cleanUrl}&${urlParams}` 
      : `${cleanUrl}?${urlParams}`;

    // 5. Eksekusi tembak ke Google
    const response = await fetch(finalUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    const data = await response.json();
    
    // 6. Kirim balik ke web ThiNet
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      msg: "Koneksi ke Database Gagal", 
      error_debug: error.message 
    });
  }
}
