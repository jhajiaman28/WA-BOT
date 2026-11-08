require('dotenv').config?.();

const TZ = 'Asia/Kolkata';

function getISTNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function formatISTDate(date = getISTNow()) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = String(date.getFullYear()).slice(-2);
  return `${d}/${m}/${y}`;
}

function formatISTTimestamp(date = getISTNow()) {
  return date.toLocaleString('en-IN', { timeZone: TZ, hour12: true });
}

function normalizePhone(jidOrNum = '') {
  return String(jidOrNum).split('@')[0].split(':')[0].replace(/\D/g, '');
}

module.exports = {
  TZ,
  PORT: process.env.PORT || 3000,
  MASTER_SHEET_ID: process.env.MASTER_SHEET_ID || '1jRRJDoNyRNPJStRaSwZm5EKUQPmm1Kpv3dFtYsm5L5E',
  DRIVE_SESSION_FOLDER_ID: process.env.DRIVE_SESSION_FOLDER_ID || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  OWNER_PHONE: normalizePhone(process.env.OWNER_PHONE || ''),
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  AUTH_DIR: '/tmp/wa_auth_info',
  getISTNow,
  formatISTDate,
  formatISTTimestamp,
  normalizePhone,
};
