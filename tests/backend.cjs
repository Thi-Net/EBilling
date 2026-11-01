const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const file = process.argv[2] || 'apps-script/Code.gs';
const cache = new Map();
const props = {ADMIN_ID:'admin', ADMIN_PASSWORD:'test-only-password', MIDTRANS_SERVER_KEY:'test-only-key'};
const ctx = vm.createContext({console, Date, JSON, Object, Number, String, Math, isNaN,
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k] || null})},
  SpreadsheetApp:{getActiveSpreadsheet:()=>null},
  CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_512:'sha512'},Charset:{UTF_8:'utf8'},
    computeDigest:(alg,s)=>[...crypto.createHash(alg).update(s).digest()],base64Encode:s=>Buffer.from(s).toString('base64')},
  Logger:{log(){}},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>JSON.parse(s)})}
});
vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
const post=p=>ctx.doPost({postData:{contents:JSON.stringify(p)}});
ctx.getDashboardAdmin=id=>({checkedId:id});
ctx.updateStatusKeluhan=id=>({idTiket:id});
assert.equal(post({action:'dashboardAdmin',id:'admin'}).success,false,'unauthenticated admin rejected');
assert.equal(post({action:'updateStatusKeluhan',idTiket:'x'}).success,false);
assert.equal(ctx.doGet({parameter:{action:'login',id:'admin',password:'test-only-password'}}).success,false,'GET login rejected');
const login=post({action:'login',id:'admin',password:'test-only-password'});
assert.equal(login.success,true); assert.ok(login.token);
ctx.getDashboardAdmin=id=>({checkedId:id});
assert.equal(post({action:'dashboardAdmin',token:login.token,id:'forged'}).data.checkedId,'admin');
cache.set('session:client-test',JSON.stringify({id:'customer-1',role:'client',expiresAt:Date.now()+100000}));
ctx.getDashboardClient=id=>({checkedId:id});
assert.equal(post({action:'dashboardClient',token:'client-test',id:'customer-2'}).data.checkedId,'customer-1');
assert.equal(post({action:'dashboardAdmin',token:'client-test'}).success,false);
assert.equal(post({action:'logout',token:login.token}).success,true);
assert.equal(post({action:'dashboardAdmin',token:login.token}).success,false);
console.log('PASS backend: auth, roles, ownership, logout, expiry, GET denial, signature, settlement replay, hyphen IDs');
assert.equal(ctx.errorResponse_(new Error('Sheet tidak ditemukan: rahasia')).message,'Permintaan gagal. Hubungi administrator.');
assert.equal(ctx.errorResponse_(new Error('Silakan login kembali.')).message,'Silakan login kembali.');
console.log('PASS backend: internal errors sanitized');
// Error konfigurasi (sheet/izin) harus tetap terlihat, bukan disamarkan jadi kredensial salah.
ctx.getUser=()=>{ throw new Error('Sheet tidak ditemukan: Data_Pelanggan'); };
assert.equal(post({action:'login',id:'x',password:'y'}).message,'Permintaan gagal. Hubungi administrator.');
ctx.getUser=()=>{ throw new Error('ID atau password tidak valid.'); };
assert.equal(post({action:'login',id:'z',password:'y'}).message,'ID atau password tidak valid.');
console.log('PASS login: config errors not disguised as bad credentials');
