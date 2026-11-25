const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, MASTER_SHEET_ID, AUTH_DIR } = require('./config');

let sheetsClient = null;
const retryQueue = [];

function initSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');

  const raw = GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')
    ? GOOGLE_SERVICE_ACCOUNT_JSON
    : Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
  const credentials = JSON.parse(raw);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
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
  const sheets = initSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function updateRange(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const sheets = initSheetsClient();
  return sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
}

async function batchUpdateValues(spreadsheetId, data, valueInputOption = 'USER_ENTERED') {
  const sheets = initSheetsClient();
  return sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption, data },
  });
}

async function appendRow(spreadsheetId, tabName, rowValues) {
  const sheets = initSheetsClient();
  return sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  });
}

async function getSheetIdByName(spreadsheetId, tabName) {
  const sheets = initSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found`);
  return sheet.properties.sheetId;
}

async function insertColumnAt(spreadsheetId, tabName, colIndex) {
  const sheets = initSheetsClient();
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
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  try {
    const rows = await getRows(MASTER_SHEET_ID, 'WA_Session!A2:B');
    let count = 0;
    for (const [name, data] of rows) {
      if (name && data) {
        fs.writeFileSync(path.join(AUTH_DIR, name), data);
        count++;
      }
    }
    console.log(`[Session] Restored ${count} auth files from Master Sheet.`);
  } catch (err) {
    console.error('[Session Restore]', err.message);
  }
}

let syncTimer = null;
function scheduleAuthSyncToDrive() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAuthToSheet().catch((e) => console.error('[Session Sync]', e.message)), 1500);
}

async function syncAuthToSheet() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const sheets = initSheetsClient();
  let files = fs.readdirSync(AUTH_DIR).filter((f) => fs.statSync(path.join(AUTH_DIR, f)).isFile());
  const preKeys = files.filter((f) => f.startsWith('pre-key-')).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
    return na - nb;
  });
  if (preKeys.length > 60) {
    const toRemove = preKeys.slice(0, preKeys.length - 60);
    for (const f of toRemove) fs.unlinkSync(path.join(AUTH_DIR, f));
    files = files.filter((f) => !toRemove.includes(f));
  }
  const rows = [['File_Name', 'Data']];
  for (const name of files) {
    const content = fs.readFileSync(path.join(AUTH_DIR, name), 'utf8');
    if (content.length <= 49000) rows.push([name, content]);
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId: MASTER_SHEET_ID, range: 'WA_Session!A1:B' });
  await updateRange(MASTER_SHEET_ID, 'WA_Session!A1', rows, 'RAW');
}


async function clearAuthInSheet() {
  try {
    const sheets = initSheetsClient();
    await sheets.spreadsheets.values.clear({ spreadsheetId: MASTER_SHEET_ID, range: 'WA_Session!A2:B' });
    console.log('[Session] Cleared stale WA_Session from Master Sheet.');
  } catch (err) {
    console.error('[Session Clear]', err.message);
  }
}


function getServiceAccountEmail() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) return '';
  const raw = GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')
    ? GOOGLE_SERVICE_ACCOUNT_JSON
    : Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
  return JSON.parse(raw).client_email || '';
}

async function createTrackerSpreadsheet(title) {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('Missing OAuth env vars (GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN) to create new spreadsheets, or pass an existing Sheet URL.');
  }
  const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  const userSheets = google.sheets({ version: 'v4', auth: oauth2 });
  const userDrive = google.drive({ version: 'v3', auth: oauth2 });

  const created = await userSheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: 'Current_Members' } },
        { properties: { title: 'Exited_Members' } },
      ],
    },
  });
  const sheetId = created.data.spreadsheetId;
  const saEmail = getServiceAccountEmail();
  if (saEmail) {
    await userDrive.permissions.create({
      fileId: sheetId,
      requestBody: { type: 'user', role: 'writer', emailAddress: saEmail },
      sendNotificationEmail: false,
    });
  }

  await updateRange(sheetId, 'Current_Members!A1:E1', [['Name', 'Phone_or_ID', 'Entry_Type', 'Joined_Date', 'Joined_Time']], 'RAW');
  await updateRange(sheetId, 'Exited_Members!A1:E1', [['Name', 'Phone_or_ID', 'Exit_Date', 'Exit_Time', 'Action']], 'RAW');
  return sheetId;
}

async function createTabIfMissing(spreadsheetId, tabName) {
  const sheets = initSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function rewriteTab(spreadsheetId, tabName, headers, rows) {
  const sheets = initSheetsClient();
  const allRows = [headers, ...rows];
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A:Z` });
  await updateRange(spreadsheetId, `${tabName}!A1`, allRows, 'RAW');
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
  syncAuthToSheet,
  clearAuthInSheet,
  createTrackerSpreadsheet,
  createTabIfMissing,
  rewriteTab,
  getRetryCount: () => retryQueue.length,
};
