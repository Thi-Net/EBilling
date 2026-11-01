var CONFIG = {
  SPREADSHEET_ID: PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID"),
  MIDTRANS_SERVER_KEY: PropertiesService.getScriptProperties().getProperty("MIDTRANS_SERVER_KEY"),
  MIDTRANS_IS_PRODUCTION: PropertiesService.getScriptProperties().getProperty("MIDTRANS_IS_PRODUCTION") === "true",
  ADMIN_ID: "admin",
  ADMIN_PASSWORD: PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD"),
  ADMIN_NAME: "Administrator",
  WHATSAPP_ADMIN: "6281234567890",
  TIMEZONE: "Asia/Jakarta",
  SHEETS: {
    PELANGGAN: "Data_Pelanggan",
    PEMBAYARAN: "Log_Pembayaran",
    INVOICE: "Log_Invoice",
    KELUHAN: "Data_Keluhan",
    INFORMASI: "Data_Informasi"
  }
};

function doGet(e) {
  return jsonOutput_({success: false, message: "Gunakan POST JSON."});
}

function doPost(e) {
  try {
    var p = parseJson_(e);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("JSON tidak valid.");
    if (!p.action) return jsonOutput_(handleMidtransWebhook_(p));
    if (p.action === "login") return jsonOutput_(login_(p));
    var session = requireSession_(p.token);
    var data;
    switch (p.action) {
      case "logout":
        CacheService.getScriptCache().remove("session:" + p.token);
        return jsonOutput_({success: true});
      case "dashboardClient":
        requireRole_(session, "client"); data = getDashboardClient(session.id); break;
      case "dashboardAdmin":
        requireRole_(session, "admin"); data = getDashboardAdmin(session.id); break;
      case "kirimKeluhan":
        requireRole_(session, "client"); data = kirimKeluhan(session.id, requiredText_(p.pesan, 4000)); break;
      case "generateInvoiceMidtrans":
        requireRole_(session, "client"); data = generateInvoiceMidtrans(session.id); break;
      case "updateBroadcast":
        requireRole_(session, "admin"); data = updateBroadcast(requiredText_(p.pesan, 4000), session.id); break;
      case "updateStatusKeluhan":
        requireRole_(session, "admin"); data = updateStatusKeluhan(requiredText_(p.idTiket, 120)); break;
      default: throw new Error("Action tidak dikenali.");
    }
    return jsonOutput_({success: true, data: data});
  } catch (error) {
    return jsonOutput_(errorResponse_(error));
  }
}

function requiredText_(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Input tidak valid.");
  return value.trim();
}

function requireRole_(session, role) {
  if (session.role !== role) throw new Error("Akses ditolak.");
}

function requireSession_(token) {
  if (typeof token !== "string" || !token || token.length > 100) throw new Error("Silakan login kembali.");
  var value = CacheService.getScriptCache().get("session:" + token);
  if (!value) throw new Error("Silakan login kembali.");
  var session = JSON.parse(value);
  if (session.expiresAt <= Date.now()) throw new Error("Sesi berakhir. Silakan login kembali.");
  return session;
}

function login_(p) {
  var id = requiredText_(p.id, 120);
  if (typeof p.password !== "string" || !p.password || p.password.length > 256) throw new Error("Input tidak valid.");
  var cache = CacheService.getScriptCache();
  var key = "login:" + id;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // ponytail: batas per akun di CacheService; gunakan WAF untuk batas IP terdistribusi.
    var failures = Number(cache.get(key) || 0);
    if (failures >= 5) throw new Error("Terlalu banyak percobaan. Coba lagi setelah 15 menit.");
    var result;
    try { result = getUser(id, p.password); }
    catch (error) {
      // Hanya kredensial salah yang dihitung gagal; error konfigurasi/data diteruskan.
      if (String(error.message) !== "ID atau password tidak valid.") throw error;
      cache.put(key, String(failures + 1), 900); throw new Error("ID atau password tidak valid.");
    }
    cache.remove(key);
    var token = Utilities.getUuid() + Utilities.getUuid();
    cache.put("session:" + token, JSON.stringify({id: result.user.id, role: result.role, expiresAt: Date.now() + 21600000}), 21600);
    result.token = token;
    return result;
  } finally { lock.releaseLock(); }
}

function getUser(id, password) {
  if (!id || !password) {
    throw new Error("ID dan password wajib diisi.");
  }

  if (CONFIG.ADMIN_PASSWORD && String(id) === String(CONFIG.ADMIN_ID) && String(password) === String(CONFIG.ADMIN_PASSWORD)) {
    return {
      success: true,
      role: "admin",
      user: {
        id: CONFIG.ADMIN_ID,
        nama: CONFIG.ADMIN_NAME
      }
    };
  }

  var pelanggan = getObjects_(getSheet_(CONFIG.SHEETS.PELANGGAN));
  var user = null;
  var i;

  for (i = 0; i < pelanggan.length; i++) {
    if (
      String(pelanggan[i].ID_Pelanggan) === String(id) &&
      String(pelanggan[i].Password) === String(password)
    ) {
      user = pelanggan[i];
      break;
    }
  }

  if (!user) {
    throw new Error("ID atau password tidak valid.");
  }

  return {
    success: true,
    role: "client",
    user: {
      id: user.ID_Pelanggan,
      nama: user.Nama_Lengkap
    }
  };
}

function getDashboardClient(idPelanggan) {
  if (!idPelanggan) {
    throw new Error("ID pelanggan tidak ditemukan.");
  }

  syncJatuhTempo_();

  var pelanggan = findPelangganById_(idPelanggan);
  if (!pelanggan) {
    throw new Error("Data pelanggan tidak ditemukan.");
  }

  var currentInvoice = findInvoice_(idPelanggan, invoicePeriod_(new Date()));
  var riwayatRaw = getObjects_(getSheet_(CONFIG.SHEETS.PEMBAYARAN));
  var informasiRaw = getObjects_(getSheet_(CONFIG.SHEETS.INFORMASI));
  var riwayat = [];
  var informasi = [];
  var i;

  for (i = 0; i < riwayatRaw.length; i++) {
    if (orderBelongsTo_(riwayatRaw[i].Order_ID, idPelanggan)) {
      riwayat.push({
        tgl: formatDateIso_(riwayatRaw[i].Tgl),
        orderId: riwayatRaw[i].Order_ID,
        status: riwayatRaw[i].Status,
        nominal: toNumber_(riwayatRaw[i].Nominal),
        metode: riwayatRaw[i].Metode
      });
    }
  }

  riwayat.sort(function(a, b) {
    return new Date(b.tgl) - new Date(a.tgl);
  });

  for (i = 0; i < informasiRaw.length; i++) {
    if (informasiRaw[i].Pesan) {
      informasi.push({
        pesan: informasiRaw[i].Pesan
      });
    }
  }

  return {
    user: {
      id: pelanggan.ID_Pelanggan,
      nama: pelanggan.Nama_Lengkap,
      paket: pelanggan.Paket_Internet,
      harga: toNumber_(pelanggan.Harga),
      statusSistem: pelanggan.Status_Sistem,
      tglPasang: formatDateIso_(pelanggan.Tgl_Pasang),
      tglJatuhTempo: formatDateIso_(pelanggan.Tgl_Jatuh_Tempo),
      statusPembayaran: currentInvoice && currentInvoice.Status === "SETTLEMENT" ? "LUNAS" : "BELUM",
      noWhatsApp: pelanggan.No_WhatsApp
    },
    riwayat: riwayat,
    informasi: informasi
  };
}

function getDashboardAdmin(idAdmin) {
  if (String(idAdmin) !== String(CONFIG.ADMIN_ID)) {
    throw new Error("Akses admin ditolak.");
  }

  syncJatuhTempo_();

  var pelangganRaw = getObjects_(getSheet_(CONFIG.SHEETS.PELANGGAN));
  var keluhanRaw = getObjects_(getSheet_(CONFIG.SHEETS.KELUHAN));
  var pelanggan = [];
  var keluhan = [];
  var aktif = 0;
  var terisolir = 0;
  var i;
  var statusSistem;

  for (i = 0; i < pelangganRaw.length; i++) {
    statusSistem = String(pelangganRaw[i].Status_Sistem || "").toUpperCase();
    if (statusSistem === "AKTIF") {
      aktif++;
    }
    if (statusSistem === "TERISOLIR") {
      terisolir++;
    }

    pelanggan.push({
      id: pelangganRaw[i].ID_Pelanggan,
      nama: pelangganRaw[i].Nama_Lengkap,
      paket: pelangganRaw[i].Paket_Internet,
      harga: toNumber_(pelangganRaw[i].Harga),
      statusSistem: pelangganRaw[i].Status_Sistem,
      tglJatuhTempo: formatDateIso_(pelangganRaw[i].Tgl_Jatuh_Tempo),
      statusPembayaran: (function() {
        var inv = findInvoice_(pelangganRaw[i].ID_Pelanggan, invoicePeriod_(new Date()));
        return inv && inv.Status === "SETTLEMENT" ? "LUNAS" : "BELUM";
      })(),
      noWhatsApp: pelangganRaw[i].No_WhatsApp
    });
  }

  for (i = 0; i < keluhanRaw.length; i++) {
    keluhan.push({
      idTiket: keluhanRaw[i].ID_Tiket,
      idPelanggan: keluhanRaw[i].ID_Pelanggan,
      nama: keluhanRaw[i].Nama,
      tgl: formatDateIso_(keluhanRaw[i].Tgl),
      pesan: keluhanRaw[i].Pesan,
      status: keluhanRaw[i].Status || "OPEN"
    });
  }

  keluhan.sort(function(a, b) {
    return new Date(b.tgl) - new Date(a.tgl);
  });

  return {
    statistik: {
      totalPelanggan: pelanggan.length,
      aktif: aktif,
      terisolir: terisolir
    },
    pelanggan: pelanggan,
    keluhan: keluhan
  };
}

function kirimKeluhan(idPelanggan, pesan) {
  if (!idPelanggan || !pesan) {
    throw new Error("ID pelanggan dan pesan keluhan wajib diisi.");
  }

  var pelanggan = findPelangganById_(idPelanggan);
  if (!pelanggan) {
    throw new Error("Pelanggan tidak ditemukan.");
  }

  var ticketId = "TIKET-" + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyyMMdd-HHmmss");
  var sheet = getSheet_(CONFIG.SHEETS.KELUHAN);

  sheet.appendRow([
    ticketId,
    pelanggan.ID_Pelanggan,
    pelanggan.Nama_Lengkap,
    new Date(),
    sheetText_(pesan),
    "OPEN"
  ]);

  return {
    idTiket: ticketId,
    whatsappAdmin: CONFIG.WHATSAPP_ADMIN
  };
}

function updateBroadcast(pesan, adminId) {
  if (String(adminId) !== String(CONFIG.ADMIN_ID)) {
    throw new Error("Akses admin ditolak.");
  }

  if (!pesan) {
    throw new Error("Pesan broadcast wajib diisi.");
  }

  var sheet = getSheet_(CONFIG.SHEETS.INFORMASI);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    sheet.appendRow([sheetText_(pesan)]);
  } else {
    sheet.getRange(2, 1, Math.max(lastRow - 1, 1), 1).clearContent();
    sheet.getRange(2, 1).setValue(sheetText_(pesan));
  }

  return {
    pesan: pesan,
    updatedAt: formatDateIso_(new Date())
  };
}

function updateStatusKeluhan(idTiket) {
  if (!idTiket) {
    throw new Error("ID tiket wajib diisi.");
  }

  var sheet = getSheet_(CONFIG.SHEETS.KELUHAN);
  var data = sheet.getDataRange().getValues();
  var i;

  for (i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(idTiket)) {
      sheet.getRange(i + 1, 6).setValue("SELESAI");
      return {
        idTiket: idTiket,
        status: "SELESAI"
      };
    }
  }

  throw new Error("Tiket tidak ditemukan.");
}

function generateInvoiceMidtrans(idPelanggan) {
  if (!idPelanggan) throw new Error("ID pelanggan wajib diisi.");
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var customer = findPelangganById_(idPelanggan);
    if (!customer) throw new Error("Pelanggan tidak ditemukan.");
    var period = invoicePeriod_(new Date()), amount = toNumber_(customer.Harga);
    if (!CONFIG.MIDTRANS_SERVER_KEY || !Number.isInteger(amount) || amount <= 0) throw new Error("Konfigurasi pembayaran tidak valid.");
    var old = findInvoice_(idPelanggan, period);
    if (old) {
      if (old.Status !== "FAILED" && old.Snap_Token) return {orderId: old.Order_ID, snapToken: old.Snap_Token, redirectUrl: old.Redirect_URL};
      throw new Error("Invoice sudah ada atau sedang diproses. Coba lagi nanti.");
    }
    var orderId = "ORDER-" + String(customer.ID_Pelanggan).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) + "-" + Utilities.getUuid().replace(/-/g, "").slice(0, 12);
    getSheet_(CONFIG.SHEETS.INVOICE).appendRow([orderId, customer.ID_Pelanggan, amount, period, "CREATING", "", "", new Date()]);
    var url = (CONFIG.MIDTRANS_IS_PRODUCTION ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com") + "/snap/v1/transactions";
    var payload = {transaction_details:{order_id:orderId,gross_amount:amount},item_details:[{id:customer.ID_Pelanggan,price:amount,quantity:1,name:"Tagihan " + customer.Paket_Internet + " " + period}],customer_details:{first_name:customer.Nama_Lengkap,phone:customer.No_WhatsApp},enabled_payments:["qris","gopay","bank_transfer","echannel"]};
    var response = UrlFetchApp.fetch(url,{method:"post",contentType:"application/json",payload:JSON.stringify(payload),headers:{Authorization:"Basic " + Utilities.base64Encode(CONFIG.MIDTRANS_SERVER_KEY + ":")},muteHttpExceptions:true});
    var body = safeParseJson_(response.getContentText() || "{}");
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !body.token) throw new Error("Gagal membuat transaksi Midtrans.");
    updateInvoice_(orderId,{Status:"PENDING",Snap_Token:body.token,Redirect_URL:body.redirect_url || ""});
    return {orderId:orderId,snapToken:body.token,redirectUrl:body.redirect_url || ""};
  } finally { lock.releaseLock(); }
}

function autoIsolir() {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
  var sheet = getSheet_(CONFIG.SHEETS.PELANGGAN);
  var data = sheet.getDataRange().getValues();
  var now = startOfDay_(new Date());
  var i;
  var idPelanggan;
  var tglPasang;
  var jatuhTempo;
  var statusSistem;

  for (i = 1; i < data.length; i++) {
    idPelanggan = data[i][0];
    tglPasang = data[i][6];
    jatuhTempo = computeDueDate_(tglPasang, now);
    statusSistem = String(data[i][5] || "").toUpperCase();
    if (jatuhTempo) sheet.getRange(i + 1, 8).setValue(jatuhTempo);
    // Status lunas ditentukan Log_Invoice periode berjalan, bukan kolom lama.
    var invoice = findInvoice_(idPelanggan, invoicePeriod_(now));
    var paid = !!invoice && invoice.Status === "SETTLEMENT";
    sheet.getRange(i + 1, 9).setValue(paid ? "LUNAS" : "BELUM");

    if (now.getTime() > jatuhTempo.getTime() && !paid && statusSistem !== "TERISOLIR") {
      sheet.getRange(i + 1, 6).setValue("TERISOLIR");
      isolirUser(idPelanggan);
    }
  }
  } finally { lock.releaseLock(); }
}

function resetBulanan() {
  // Tidak mengubah status; status periode dihitung dari Log_Invoice oleh autoIsolir.
}

function setupTimeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var i;
  var handler;

  for (i = 0; i < triggers.length; i++) {
    handler = triggers[i].getHandlerFunction();
    if (handler === "autoIsolir" || handler === "resetBulanan") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger("autoIsolir")
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();

  ScriptApp.newTrigger("resetBulanan")
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();
}

function isolirUser(idPelanggan) {
  Logger.log("Simulasi Mikrotik: isolir user " + idPelanggan);
}

function aktifkanUser(idPelanggan) {
  Logger.log("Simulasi Mikrotik: aktifkan user " + idPelanggan);
}

function handleMidtransWebhook_(payload) {
  if (!payload || !payload.order_id) throw new Error("Webhook tidak valid.");
  verifyMidtrans_(payload);
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var invoice = findInvoiceByOrder_(payload.order_id);
    if (!invoice || Number(payload.gross_amount) !== toNumber_(invoice.Nominal)) throw new Error("Invoice pembayaran tidak valid.");
    var id = String(invoice.ID_Pelanggan), status = String(payload.transaction_status || "").toLowerCase();
    var settled = status === "settlement" || (status === "capture" && String(payload.fraud_status).toLowerCase() === "accept");
    if (!settled) {
      if (invoice.Status !== "SETTLEMENT") updateInvoice_(payload.order_id,{Status:status.toUpperCase()});
      logPembayaran_(payload,status.toUpperCase());
      return {success:true,message:"Webhook diterima, status belum settlement."};
    }
    if (invoice.Status === "SETTLEMENT") return {success: true, message: "Pembayaran sudah diproses."};
    // Semua langkah di bawah idempoten: aman diulang setelah gagal sebagian.
    updateInvoice_(payload.order_id,{Status:"PROCESSING"});
    updatePelangganPayment_(id,{statusSistem:"AKTIF",statusPembayaran:"LUNAS"});
    aktifkanUser(id);
    logPembayaran_(payload,"SETTLEMENT");
    updateInvoice_(payload.order_id,{Status:"SETTLEMENT"});
    return {success:true,message:"Pembayaran berhasil diproses.",data:{idPelanggan:id}};
  } finally { lock.releaseLock(); }
}

function invoicePeriod_(date) {
  return Utilities.formatDate(new Date(date.getFullYear(),date.getMonth()-1,1),CONFIG.TIMEZONE,"yyyy-MM");
}
function findInvoiceByOrder_(orderId) {
  var rows=getObjects_(getSheet_(CONFIG.SHEETS.INVOICE));
  for(var i=0;i<rows.length;i++) if(String(rows[i].Order_ID)===String(orderId)) return rows[i];
  return null;
}
function findInvoice_(id,period) {
  var rows=getObjects_(getSheet_(CONFIG.SHEETS.INVOICE));
  for(var i=0;i<rows.length;i++) if(String(rows[i].ID_Pelanggan)===String(id)&&String(rows[i].Periode)===period) return rows[i];
  return null;
}
function updateInvoice_(orderId, updates) {
  var sheet=getSheet_(CONFIG.SHEETS.INVOICE), values=sheet.getDataRange().getValues(), headers=values[0];
  for(var r=1;r<values.length;r++) if(String(values[r][0])===String(orderId)) {
    Object.keys(updates).forEach(function(key){var col=headers.indexOf(key);if(col>0)sheet.getRange(r+1,col+1).setValue(updates[key]);});
    var updated=headers.indexOf("Updated_At");if(updated>=0)sheet.getRange(r+1,updated+1).setValue(new Date()); return;
  }
  throw new Error("Invoice tidak ditemukan.");
}

function updatePelangganPayment_(idPelanggan, updates) {
  var sheet = getSheet_(CONFIG.SHEETS.PELANGGAN);
  var data = sheet.getDataRange().getValues();
  var i;

  for (i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(idPelanggan)) {
      if (updates.statusSistem) {
        sheet.getRange(i + 1, 6).setValue(updates.statusSistem);
      }
      if (updates.statusPembayaran) {
        sheet.getRange(i + 1, 9).setValue(updates.statusPembayaran);
      }
      return {
        nama: data[i][2]
      };
    }
  }

  throw new Error("Pelanggan untuk pembayaran tidak ditemukan.");
}

function logPembayaran_(payload, status) {
  var sheet = getSheet_(CONFIG.SHEETS.PEMBAYARAN);
  var existing = getObjects_(sheet);
  for (var i = 0; i < existing.length; i++) {
    if (String(existing[i].Order_ID) === String(payload.order_id || "") && String(existing[i].Status) === String(status || "")) return;
  }
  sheet.appendRow([
    new Date(),
    payload.order_id || "",
    status || payload.transaction_status || "",
    Number(payload.gross_amount || 0),
    payload.payment_type || "midtrans"
  ]);
}

function syncJatuhTempo_() {
  var sheet = getSheet_(CONFIG.SHEETS.PELANGGAN);
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var i;
  var dueDate;
  var currentDueDate;
  var currentTime;

  for (i = 1; i < data.length; i++) {
    dueDate = computeDueDate_(data[i][6], now);
    if (!dueDate) {
      continue;
    }

    currentDueDate = data[i][7];
    currentTime = currentDueDate instanceof Date ? currentDueDate.getTime() : new Date(currentDueDate).getTime();

    if (isNaN(currentTime) || currentTime !== dueDate.getTime()) {
      sheet.getRange(i + 1, 8).setValue(dueDate);
    }
  }
}

function findPelangganById_(idPelanggan) {
  var pelanggan = getObjects_(getSheet_(CONFIG.SHEETS.PELANGGAN));
  var i;

  for (i = 0; i < pelanggan.length; i++) {
    if (String(pelanggan[i].ID_Pelanggan) === String(idPelanggan)) {
      return pelanggan[i];
    }
  }

  return null;
}

function getSheet_(sheetName) {
  var spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error("Sheet tidak ditemukan: " + sheetName);
  }

  return sheet;
}

function getObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  var headers = values[0];
  var result = [];
  var i;
  var j;
  var obj;

  for (i = 1; i < values.length; i++) {
    obj = {};
    for (j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[i][j];
    }
    result.push(obj);
  }

  return result;
}

function parseJson_(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return {};
    }
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

function extractCustomerIdFromOrder_(orderId) {
  var match = String(orderId).match(/^ORDER-(.+)-\d{14}$/);
  if (!match || !match[1]) {
    throw new Error("Order ID tidak mengandung ID pelanggan.");
  }
  return match[1];
}

function formatDateIso_(value) {
  if (!value) {
    return "";
  }

  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    return String(value);
  }

  return Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function computeDueDate_(installDateValue, referenceDate) {
  var installDate = startOfDay_(installDateValue);
  if (!installDate) {
    return null;
  }
  // Tenggat pembayaran selalu tanggal 20 pada bulan penerbitan invoice.
  var ref = startOfDay_(referenceDate || new Date());
  return new Date(ref.getFullYear(), ref.getMonth(), 20);
}

function startOfDay_(value) {
  if (!value) {
    return null;
  }

  var date = value instanceof Date ? new Date(value) : new Date(value);
  if (isNaN(date.getTime())) {
    return null;
  }

  date.setHours(0, 0, 0, 0);
  return date;
}

function toNumber_(value) {
  var parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getParam_(e, key) {
  return e && e.parameter ? (e.parameter[key] || "") : "";
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(error) {
  var message = error && error.message ? error.message : "";
  // Jangan kirim exception Google/Midtrans atau konfigurasi internal ke browser.
  var safe = /^(Gunakan |Input |JSON |Silakan |Sesi |Akses |Action |ID atau password |Terlalu banyak |Webhook |Verifikasi pembayaran |Pembayaran tidak |Nominal pembayaran )/.test(message);
  return {success: false, message: safe ? message : "Permintaan gagal. Hubungi administrator."};
}

function safeParseJson_(text) {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    return {};
  }
}

function sheetText_(value) {
  return /^[=+@\-]/.test(value) ? "'" + value : value;
}

function orderBelongsTo_(orderId, id) {
  try { return extractCustomerIdFromOrder_(orderId) === String(id); } catch (error) { return false; }
}

function verifyMidtrans_(p) {
  if (!CONFIG.MIDTRANS_SERVER_KEY || typeof p.signature_key !== "string" || !/^[a-f0-9]{128}$/i.test(p.signature_key)) throw new Error("Webhook tidak valid.");
  if (typeof p.order_id !== "string" || typeof p.status_code !== "string" || typeof p.gross_amount !== "string") throw new Error("Webhook tidak valid.");
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_512, p.order_id + p.status_code + p.gross_amount + CONFIG.MIDTRANS_SERVER_KEY, Utilities.Charset.UTF_8);
  var expected = bytes.map(function(b) { return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("");
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ p.signature_key.toLowerCase().charCodeAt(i);
  if (diff) throw new Error("Webhook tidak valid.");
  // Status/fraud bukan bagian signature; pastikan lewat API Midtrans sebelum mutasi.
  var base = CONFIG.MIDTRANS_IS_PRODUCTION ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
  var response = UrlFetchApp.fetch(base + "/v2/" + encodeURIComponent(p.order_id) + "/status", {
    headers: {Authorization: "Basic " + Utilities.base64Encode(CONFIG.MIDTRANS_SERVER_KEY + ":")}, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error("Verifikasi pembayaran gagal.");
  var current = safeParseJson_(response.getContentText());
  if (current.order_id !== p.order_id || Number(current.gross_amount) !== Number(p.gross_amount)) throw new Error("Pembayaran tidak sesuai.");
  p.transaction_status = current.transaction_status;
  p.fraud_status = current.fraud_status;
  p.payment_type = current.payment_type;
}
