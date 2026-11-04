
/**
 * Fungsi migrasi: jalankan SEKALI di editor Apps Script (project lama),
 * lalu salin output log dan kirim ke saya (atau simpan sebagai file).
 */
function exportDataForMigration() {
  function rowsToObjects(sheet) {
    if (!sheet) return [];
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return [];
    var headers = values[0];
    var out = [];
    for (var r = 1; r < values.length; r++) {
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        if (!headers[c]) continue;
        var v = values[r][c];
        obj[headers[c]] = v instanceof Date ? v.toISOString() : v;
      }
      out.push(obj);
    }
    return out;
  }
  var ss = getSpreadsheet_();
  var data = {
    pelanggan: rowsToObjects(ss.getSheetByName("Data_Pelanggan")).map(function(p) {
      return {
        id: String(p.ID_Pelanggan), nama: String(p.Nama_Lengkap || ""),
        paket: String(p.Paket_Internet || ""), harga: Number(p.Harga || 0),
        statusSistem: String(p.Status_Sistem || "AKTIF"),
        tglPasang: p.Tgl_Pasang || "",
        tglJatuhTempo: p.Tgl_Jatuh_Tempo || "",
        statusPembayaran: String(p.Status_Pembayaran || ""),
        noWhatsApp: String(p.No_WhatsApp || ""),
        password: String(p.Password || "")
      };
    }),
    invoice: rowsToObjects(ss.getSheetByName("Log_Invoice")).map(function(inv) {
      return {
        orderId: String(inv.Order_ID || ""), idPelanggan: String(inv.ID_Pelanggan || ""),
        nominal: Number(inv.Nominal || 0), periode: String(inv.Periode || ""),
        status: String(inv.Status || "PENDING"), snapToken: String(inv.Snap_Token || ""),
        redirectUrl: String(inv.Redirect_URL || ""), createdAt: inv.Created_At || new Date().toISOString()
      };
    }),
    pembayaran: rowsToObjects(ss.getSheetByName("Log_Pembayaran")).map(function(p) {
      return {
        tgl: p.Tgl || new Date().toISOString(), orderId: String(p.Order_ID || ""),
        status: String(p.Status || ""), nominal: Number(p.Nominal || 0),
        metode: String(p.Metode || "midtrans")
      };
    }),
    keluhan: rowsToObjects(ss.getSheetByName("Data_Keluhan")).map(function(k) {
      return {
        idTiket: String(k.ID_Tiket || ""), idPelanggan: String(k.ID_Pelanggan || ""),
        nama: String(k.Nama || ""), tgl: k.Tgl || new Date().toISOString(),
        pesan: String(k.Pesan || ""), status: String(k.Status || "OPEN")
      };
    }),
    informasi: rowsToObjects(ss.getSheetByName("Data_Informasi")).map(function(i) {
      return { pesan: String(i.Pesan || "") };
    })
  };
  Logger.log("===MULAI-EXPORT===");
  Logger.log(JSON.stringify(data));
  Logger.log("===SELESAI-EXPORT===");
  Logger.log("Salin teks di antara MULAI-EXPORT dan SELESAI-EXPORT, kirim ke asisten.");
}
