const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
let today=new Date('2026-12-05T12:00:00+07:00'),writes=0,upstream;
const cache=new Map(),props={ADMIN_ID:'admin',ADMIN_PASSWORD:'test-only-password',MIDTRANS_SERVER_KEY:'test-only-key'};
let customer={ID_Pelanggan:'customer-1',Harga:100000,Status_Sistem:'TERISOLIR',Status_Pembayaran:'BELUM',Nama_Lengkap:'Test'};
const customerRows=[['ID_Pelanggan','x','Nama_Lengkap','Paket_Internet','Harga','Status_Sistem','Tgl_Pasang','Tgl_Jatuh_Tempo','Status_Pembayaran','No_WhatsApp'],['customer-1','','Test','Paket',100000,'TERISOLIR',new Date('2026-01-01'),new Date('2026-11-20'),'BELUM','']];
const invoiceRows=[['Order_ID','ID_Pelanggan','Nominal','Periode','Status','Snap_Token','Redirect_URL','Updated_At']],paymentRows=[];
function sheet(rows){return {getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),appendRow:r=>{rows.push(r);writes++},getLastRow:()=>rows.length,getRange:(row,col,n)=>({setValue:v=>{if(row>1&&rows[row-1])rows[row-1][col-1]=v;writes++},clearContent(){}})}}
const sheets={'Log_Invoice':sheet(invoiceRows),'Log_Pembayaran':sheet(paymentRows),'Data_Pelanggan':sheet(customerRows)};
const NativeDate=Date,MockDate=function(...a){return a.length?new NativeDate(...a):new NativeDate(today)};MockDate.now=()=>today.getTime();MockDate.prototype=NativeDate.prototype;
const ctx=vm.createContext({console,Date:MockDate,JSON,Object,Number,String,Math,isNaN,
PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_512:'sha512'},Charset:{UTF_8:'utf8'},computeDigest:(a,s)=>[...crypto.createHash(a).update(s).digest()],base64Encode:s=>Buffer.from(s).toString('base64'),formatDate:(d,t,f)=>{if(f==='yyyy-MM')return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');if(f==='yyyy-MM-dd')return d.toISOString().slice(0,10);if(f==='yyyyMM')return d.toISOString().slice(0,7).replace('-','');if(f==='yyyyMMddHHmmss')return d.toISOString().replace(/[-:TZ.]/g,'').slice(0,14);if(f==='d')return String(d.getDate());return d.toISOString()}},
SpreadsheetApp:{openById:()=>({getSheetByName:n=>sheets[n]})},Logger:{log(){}},ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>JSON.parse(s)})},
UrlFetchApp:{fetch:(url,o)=>url.includes('/snap/')?{getResponseCode:()=>201,getContentText:()=>JSON.stringify({token:'snap',redirect_url:'https://pay.test'})}:upstream()},ScriptApp:{getProjectTriggers:()=>[]}});
vm.runInContext(fs.readFileSync(process.argv[2]||'apps-script/Code.gs','utf8'),ctx);
ctx.findPelangganById_=id=>String(id)===customer.ID_Pelanggan?customer:null;
ctx.getObjects_=sh=>sh===sheets['Log_Invoice']?invoiceRows.slice(1).map(r=>Object.fromEntries(invoiceRows[0].map((h,i)=>[h,r[i]]))):paymentRows.slice(1).map(r=>Object.fromEntries(['Tgl','Order_ID','Status','Nominal','Metode'].map((h,i)=>[h,r[i]])));
ctx.getSheet_=n=>sheets[n];ctx.aktifkanUser=()=>{};ctx.getObjects_=((original)=>sh=>sh===sheets['Data_Pelanggan']?customerRows.slice(1).map(r=>({ID_Pelanggan:r[0],Nama_Lengkap:r[1],Paket_Internet:r[2],Harga:r[3],Status_Sistem:r[4],Status_Pembayaran:r[5],Tgl_Pasang:r[6],Tgl_Jatuh_Tempo:r[7],No_WhatsApp:r[8]})):original(sh))(ctx.getObjects_);
assert.equal(ctx.invoicePeriod_(new NativeDate('2026-11-01T00:00:00Z')),'2026-10');
assert.equal(ctx.invoicePeriod_(new NativeDate('2026-12-01T00:00:00Z')),'2026-11');
const invoice={Order_ID:'ORDER-customer-1-20261201000000',ID_Pelanggan:'customer-1',Nominal:100000,Periode:'2026-11',Status:'PENDING',Snap_Token:'snap',Redirect_URL:'https://pay.test'};invoiceRows.push(Object.values(invoice));customer.Harga=200000;
upstream=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({order_id:invoice.Order_ID,gross_amount:'100000.00',transaction_status:'settlement',fraud_status:'accept',payment_type:'qris'})});
let p={order_id:invoice.Order_ID,status_code:'200',gross_amount:'100000.00',transaction_status:'settlement'};p.signature_key=crypto.createHash('sha512').update(p.order_id+p.status_code+p.gross_amount+props.MIDTRANS_SERVER_KEY).digest('hex');
assert.equal(ctx.handleMidtransWebhook_(p).success,true,'settle immutable old invoice after price change');assert.equal(customerRows[1][5],'AKTIF');assert.equal(invoiceRows[1][4],'SETTLEMENT');assert.equal(paymentRows.length,1);
ctx.handleMidtransWebhook_(p);assert.equal(paymentRows.length,1,'duplicate webhook idempotent');
today=new NativeDate('2027-01-05T12:00:00+07:00');const res=ctx.generateInvoiceMidtrans('customer-1');const row=invoiceRows.find(r=>r[0]===res.orderId);assert.equal(row[3],'2026-12','bill latest service month only');assert.equal(row[2],200000);
assert.equal(ctx.invoicePeriod_(new NativeDate('2027-01-21T12:00:00+07:00')),'2026-12');
upstream=()=>({getResponseCode:()=>503,getContentText:()=>''});assert.throws(()=>ctx.handleMidtransWebhook_(p));assert.equal(customerRows[1][5],'AKTIF','lookup failure has no changes');
// Retry setelah crash sebelum update pelanggan: PROCESSING tetap menyelesaikan pembayaran.
upstream=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({order_id:invoice.Order_ID,gross_amount:'100000.00',transaction_status:'settlement',fraud_status:'accept',payment_type:'qris'})});
invoiceRows[1][4]='PROCESSING'; customerRows[1][5]='TERISOLIR'; const before=paymentRows.length;
assert.equal(ctx.handleMidtransWebhook_(p).success,true); assert.equal(customerRows[1][5],'AKTIF'); assert.equal(invoiceRows[1][4],'SETTLEMENT'); assert.equal(paymentRows.length,before+1,'partial retry logs once');
assert.equal(ctx.handleMidtransWebhook_(p).success,true); assert.equal(paymentRows.length,before+1,'retry after settlement no duplicate ledger');
// Isolir hanya setelah tanggal 20; lunas periode berjalan tidak diisolir.
ctx.aktifkanUser=()=>{};let isolations=0;ctx.isolirUser=()=>isolations++;
customerRows[1][5]='AKTIF';invoiceRows[1][4]='PENDING';today=new NativeDate('2026-12-20T12:00:00+07:00');ctx.autoIsolir();assert.equal(isolations,0,'not isolated on the 20th');
today=new NativeDate('2026-12-21T12:00:00+07:00');ctx.autoIsolir();assert.equal(isolations,1,'isolated after the 20th');
console.log('PASS immutable invoice amount/period, late-payment activation, idempotent webhook, latest-period billing, failed lookup no writes');
