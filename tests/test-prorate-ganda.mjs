// Uji logika tanggal & prorate tanpa Firestore (salin fungsi murni dari backend.js)
const PERIOD_START_DAY = 21;
function daySerialFromIso(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}
function isoFromDaySerial(serial) {
  const d = new Date(serial * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function servicePeriodEndIso(startIso) {
  const s = new Date(daySerialFromIso(startIso) * 86400000);
  const end = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 20));
  return isoFromDaySerial(Math.floor(end.getTime() / 86400000));
}
function periodDayCount(startIso) {
  return daySerialFromIso(servicePeriodEndIso(startIso)) - daySerialFromIso(startIso) + 1;
}

// prorate ganda — replika logika baru di createInvoiceRow
function nominalGanti(hargaLama, hargaBaru, startIso, tglGanti, effStart) {
  const endIso = servicePeriodEndIso(startIso);
  const total = periodDayCount(startIso);
  const daysUsed = Math.max(0, daySerialFromIso(endIso) - daySerialFromIso(effStart) + 1);
  const hariBaru = daySerialFromIso(endIso) - daySerialFromIso(tglGanti) + 1;
  const hariLama = Math.max(0, daysUsed - hariBaru);
  return { nominal: Math.round((hariLama * hargaLama + hariBaru * hargaBaru) / total), hariLama, hariBaru, total, daysUsed };
}

let fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " | " + desc + " | got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
}

// Kasus user: periode 21 Okt-20 Nov (31 hari), paket A 100rb→B 200rb, ganti 12 Nov
check("prorate ganda 12 Nov", nominalGanti(100000, 200000, "2026-10-21", "2026-11-12", "2026-10-21"),
  { nominal: Math.round((22 * 100000 + 9 * 200000) / 31), hariLama: 22, hariBaru: 9, total: 31, daysUsed: 31 });

// Ganti tgl 5: lama 21 Okt-4 Nov (15 hari), baru 5-20 Nov (16 hari)
check("prorate ganda 5 Nov", nominalGanti(100000, 200000, "2026-10-21", "2026-11-05", "2026-10-21").hariLama, 15);
check("prorate ganda 5 Nov baru", nominalGanti(100000, 200000, "2026-10-21", "2026-11-05", "2026-10-21").hariBaru, 16);

// Ganti tgl 18: lama 28, baru 3
check("prorate ganda 18 Nov", nominalGanti(100000, 200000, "2026-10-21", "2026-11-18", "2026-10-21"), { nominal: Math.round((28 * 100000 + 3 * 200000) / 31), hariLama: 28, hariBaru: 3, total: 31, daysUsed: 31 });

// Periode pendek: 21 Jan-20 Feb (31 hari utk 2026? Jan21-Feb20 = 31)
check("panjang periode Jan-Feb", periodDayCount("2026-01-21"), 31);
check("panjang periode Feb-Mar", periodDayCount("2026-02-21"), 28);
check("panjang periode Des-Jan", periodDayCount("2026-12-21"), 31);

// namaBulanTagihan: periode berakhir 20 Sep → September (bukan Oktober/due)
const bulan = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
check("bulan tagihan periode Agu-Sep", bulan[Number("2026-09-20".slice(5,7)) - 1], "September");
check("bulan tagihan periode Okt-Nov", bulan[Number("2026-11-20".slice(5,7)) - 1], "November");

process.exit(fail ? 1 : 0);
