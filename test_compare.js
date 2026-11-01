function compare(sheetId, sheetPw, inputId, inputPw) {
  console.log('exact:', String(sheetId) === String(inputId) && String(sheetPw) === String(inputPw));
  console.log('trimmed:', String(sheetId).trim() === String(inputId).trim() && String(sheetPw).trim() === String(inputPw).trim());
  console.log('case-insensitive ID:', String(sheetId).trim().toLowerCase() === String(inputId).trim().toLowerCase());
}
compare('user1', '1234567', 'user1', '1234567');
