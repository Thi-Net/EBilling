# ThiNet billing security setup

Implementasi lokal belum di-deploy. Jalankan tes lokal di folder proyek:

```sh
node tests/backend.cjs
node tests/invoices.cjs
node tests/proxy.mjs
```

## Sheet baru wajib

Buat sheet `Log_Invoice` dengan header baris pertama, tepat urutan:

`Order_ID | ID_Pelanggan | Nominal | Periode | Status | Snap_Token | Redirect_URL | Updated_At`

Jangan hapus atau ubah sheet lama. Deploy Apps Script bersama proxy/frontend; webhook lama tanpa catatan invoice sah akan ditolak. Atur zona waktu Apps Script ke `Asia/Jakarta`, lalu jalankan `setupTimeTriggers()` sekali untuk mengganti trigger harian isolir/reset. Kolom `Status_Pembayaran` lama diselaraskan oleh trigger; dashboard mengambil status pembayaran periode aktif dari `Log_Invoice`.

## Aturan periode

Tagihan periode layanan bulan sebelumnya tersedia mulai tanggal 1 bulan berikutnya. Invoice dapat dibayar kapan saja; tanggal 20 bulan penerbitan menjadi batas isolir. Pembayaran invoice lama mengaktifkan pelanggan, sementara tagihan terbaru tetap berlaku. Bulan layanan yang dilewati saat isolir tidak dibuat sebagai tunggakan; setelah bayar, sistem hanya buat invoice untuk bulan layanan terbaru yang sudah jatuh waktu terbit. Invoice yang sudah dibuat mempertahankan nominal dan periode awal meski tarif pelanggan berubah.

Settlement ditandai `PROCESSING`, menerapkan perubahan pelanggan, mencatat pembayaran (unik per order/status), lalu `SETTLEMENT`. Callback ulang dapat melanjutkan setelah kegagalan sebagian. Kegagalan webhook di proxy mengembalikan HTTP 502 dan `Retry-After: 30` agar Midtrans mengirim ulang.

## Sebelum produksi

1. Rotasi semua kredensial yang pernah terekspos; simpan nilai baru hanya di Script Properties/env Vercel.
2. Pastikan `SCRIPT_URL` persis URL Web App Apps Script `/exec` yang baru.
3. Deploy Apps Script baru dan endpoint proxy/frontend secara berpasangan; konfigurasi webhook Midtrans ke endpoint proxy.
4. Uji sandbox: buat invoice, ubah tarif sebelum callback, pembayaran akhir pekan/bulan, callback duplikat, signature salah, dan gangguan sementara API/Sheet.
5. Simulasi isolir pada hari 20 dan pembayaran invoice lama sesudahnya; verifikasi pelanggan langsung aktif serta invoice periode terbaru tetap belum lunas.

Batas: Sheet bukan DB transaksional. `PROCESSING` dan retry mengurangi risiko crash, tetapi kegagalan total Google Sheets tetap perlu pemantauan dan rekonsiliasi manual. Password pelanggan lama masih plaintext; jangan anggap migrasi password sudah dilakukan.
