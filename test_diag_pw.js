function diagnosePasswordMatch(sheetPw, inputPw) {
  const sStr = String(sheetPw);
  const iStr = String(inputPw);
  return {
    sheetLen: sStr.length,
    inputLen: iStr.length,
    exactMatch: sStr === iStr,
    trimmedMatch: sStr.trim() === iStr.trim(),
    sheetCodes: Array.from(sStr).map(c => c.charCodeAt(0)),
    inputCodes: Array.from(iStr).map(c => c.charCodeAt(0))
  };
}
console.log(diagnosePasswordMatch("pass123 ", "pass123"));
