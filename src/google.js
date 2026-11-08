const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_SESSION_FOLDER_ID, AUTH_DIR } = require('./config');

let sheetsClient = null;
let driveClient = null;
const retryQueue = [];

function initGoogleClients() {
  if (sheetsClient && driveClient) return { sheets: sheetsClient, drive: driveClient };
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');

  const raw = GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')
    ? GOOGLE_SERVICE_ACCOUNT_JSON
    : Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
  const credentials = JSON.parse(raw);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  driveClient = google.drive({ version: 'v3', auth });
  return { sheets: sheetsClient, drive: driveClient };
}

function colIndexToLetter(idx) {
  let letter = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

async function getRows(spreadsheetId, range) {
  const { sheets } = initGoogleClients();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function updateRange(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const { sheets } = initGoogleClients();
  return sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
}

async function batchUpdateValues(spreadsheetId, data, valueInputOption = 'USER_ENTERED') {
  const { sheets } = initGoogleClients();
  return sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption, data },
  });
}

async function appendRow(spreadsheetId, tabName, rowValues) {
  const { sheets } = initGoogleClients();
  return sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  });
}

async function getSheetIdByName(spreadsheetId, tabName) {
  const { sheets } = initGoogleClients();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found`);
  return sheet.properties.sheetId;
}

async function insertColumnAt(spreadsheetId, tabName, colIndex) {
  const { sheets } = initGoogleClients();
  const sheetId = await getSheetIdByName(spreadsheetId, tabName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: colIndex, endIndex: colIndex + 1 },
          inheritFromBefore: colIndex > 0,
        },
      }],
    },
  });
}

async function safeExecute(fn, metaLabel, notifyFn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[Sheets Retry Queued] ${metaLabel}:`, err.message);
    retryQueue.push({ fn, metaLabel, attempts: 0 });
    if (notifyFn) await notifyFn(`⚠️ Sheet Sync Error (${metaLabel}): ${err.message}. Queued for retry.`);
    return null;
  }
}

async function processRetryQueue(notifyFn) {
  if (!retryQueue.length) return;
  const pending = retryQueue.splice(0, retryQueue.length);
  for (const item of pending) {
    try {
      await item.fn();
    } catch (err) {
      item.attempts += 1;
      if (item.attempts < 10) retryQueue.push(item);
      else if (notifyFn) await notifyFn(`❌ Sheet Sync permanently failed after 10 retries: ${item.metaLabel}`);
    }
  }
}

async function restoreAuthFromDrive() {
  if (!DRIVE_SESSION_FOLDER_ID) return;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { drive } = initGoogleClients();
  const res = await drive.files.list({
    q: `'${DRIVE_SESSION_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  for (const file of res.data.files || []) {
    const dest = path.join(AUTH_DIR, file.name);
    const content = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
    fs.writeFileSync(dest, Buffer.from(content.data));
  }
  console.log(`[Drive] Restored ${(res.data.files || []).length} auth files.`);
}

let syncTimer = null;
function scheduleAuthSyncToDrive() {
  if (!DRIVE_SESSION_FOLDER_ID) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAuthToDrive().catch((e) => console.error('[Drive Sync]', e.message)), 5000);
}

async function syncAuthToDrive() {
  if (!DRIVE_SESSION_FOLDER_ID || !fs.existsSync(AUTH_DIR)) return;
  const { drive } = initGoogleClients();
  const existing = await drive.files.list({
    q: `'${DRIVE_SESSION_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  const map = new Map((existing.data.files || []).map((f) => [f.name, f.id]));
  const localFiles = fs.readdirSync(AUTH_DIR);

  for (const name of localFiles) {
    const fullPath = path.join(AUTH_DIR, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    const media = { mimeType: 'application/json', body: fs.createReadStream(fullPath) };
    if (map.has(name)) {
      await drive.files.update({ fileId: map.get(name), media });
    } else {
      await drive.files.create({
        requestBody: { name, parents: [DRIVE_SESSION_FOLDER_ID] },
        media,
      });
    }
  }
}

module.exports = {
  colIndexToLetter,
  getRows,
  updateRange,
  batchUpdateValues,
  appendRow,
  insertColumnAt,
  safeExecute,
  processRetryQueue,
  restoreAuthFromDrive,
  scheduleAuthSyncToDrive,
  getRetryCount: () => retryQueue.length,
};
