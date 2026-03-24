
// DATA LAYER — localStorage based
// ============================================================
const DB_KEY = 'vacSystem_v3';

// ============================================================
// GLOBAL STATE — declared here to avoid TDZ issues
// ============================================================
let currentUser = null;
let currentApprovalId = null;
let passwordTargetUser = null;
let pendingExcelQuotas = [];
let firebaseApp = null;
const calState = { year: 2026, month: 1 };
const deptSelectedMap = {};

// ── Security ──────────────────────────────────────────────────
const _loginAttempts = {};
async function _sha256(p) {
  const enc = new TextEncoder().encode(p + 'dazura_salt_2024');
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return 'sha256_' + Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function _rlKey() {
  return btoa([navigator.userAgent.length,screen.width,screen.colorDepth].join('|')).slice(0,16);
}
function _checkRL() {
  const k=_rlKey(), now=Date.now();
  if (!_loginAttempts[k]) _loginAttempts[k]={count:0,lock:0};
  const r=_loginAttempts[k];
  if (r.lock>now) return {blocked:true,secs:Math.ceil((r.lock-now)/1000)};
  return {blocked:false};
}
function _failRL() {
  const k=_rlKey(), now=Date.now();
  if (!_loginAttempts[k]) _loginAttempts[k]={count:0,lock:0};
  const r=_loginAttempts[k];
  r.count++;
  if (r.count>=5){r.lock=now+5*60*1000;r.count=0;}
  else if(r.count>=3){r.lock=now+30*1000;}
}
function _clearRL() { delete _loginAttempts[_rlKey()]; }
const deptElementIds = {
  'regDeptMulti':    { dropdown: 'regDeptDropdown',    tags: 'regDeptTags' },
  'newEmpDeptMulti': { dropdown: 'newEmpDeptDropdown', tags: 'newEmpDeptTags' },
};

function getDB() {
  try {
    const db = JSON.parse(localStorage.getItem(DB_KEY));
    if (!db) return initDB();
    ensureAdminExists(db);
    return db;
  } catch(e) {
    return initDB();
  }
}

// Always make sure admin user exists — safety net against Firebase wipe
function ensureAdminExists(db) {
  if (!db.users) db.users = {};
  if (!db.departments) db.departments = ['הנהלה','חשבות','מכירות','שיווק','פיתוח','תפעול','משאבי אנוש','לוגיסטיקה'];
  if (!db.approvalRequests) db.approvalRequests = [];
  if (!db.auditLog) db.auditLog = [];
  if (!db.settings) db.settings = {};
  if (!db.vacations) db.vacations = {};

  if (!db.users['admin']) {
    // Try to preserve password from local storage before overwriting
    let savedPass = null;
    try {
      const local = JSON.parse(localStorage.getItem(DB_KEY) || '{}');
      savedPass = local?.users?.admin?.password || null;
    } catch(e) {}

    db.users['admin'] = {
      fullName: 'מנהל מערכת',
      username: 'admin',
      password: savedPass || hashPass('admin123'),
      dept: ['הנהלה'],
      role: 'admin',
      status: 'active',
      quotas: { '2026': { annual: 22, initialBalance: 0 } }
    };
    _saveDBLocal(db);
  }
}

function _saveDBLocal(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function initDB() {
  const db = {
    users: {
      'admin': {
        fullName: 'מנהל מערכת',
        username: 'admin',
        password: hashPass('admin123'),
        dept: ['הנהלה'],
        role: 'admin',
        quotas: { '2026': { annual: 22, initialBalance: 0 } }
      },
      'accountant': {
        fullName: 'חשבות',
        username: 'accountant',
        password: hashPass('1234'),
        dept: ['חשבות'],
        role: 'accountant',
        quotas: { '2026': { annual: 22, initialBalance: 0 } }
      }
    },
    vacations: {}, // { username: { 'YYYY-MM-DD': 'full'|'half'|'wfh' } }
    departments: ['הנהלה','חשבות','מכירות','שיווק','פיתוח','תפעול','משאבי אנוש','לוגיסטיקה'],
    approvalRequests: [],
    auditLog: [],   // { ts, user, action, details }
    settings: {
      companyName:      'החברה שלי',
      companyLogo:      '',        // base64 or URL
      cycleStartDay:    1,         // day of month cycle starts (1 = standard, 21 = your case)
      cycleEndDay:      0,         // 0 = last day of month, else explicit day
      dropMonth:        'next',    // 'same' | 'next' — which month vacation days are deducted
      approvalRequired: true,      // employees must request approval
      approvalTimeoutHours: 48,    // hours before reminder sent
      managerEmail:     '',
      payrollFormat:    'csv_generic', // csv_generic | priority | hilan | hashav
      theme:            'blue'
    }
  };
  _saveDBLocal(db);
  return db;
}

function getSettings() {
  const db = getDB();
  return Object.assign({
    systemName: 'Dazura', companyName: 'החברה שלי', companyLogo: '', cycleStartDay: 1, cycleEndDay: 0,
    dropMonth: 'next', approvalRequired: true, approvalTimeoutHours: 48,
    managerEmail: '', payrollFormat: 'csv_generic', theme: 'blue'
  }, db.settings || {});
}

function saveSettings(settings) {
  const db = getDB();
  db.settings = Object.assign(db.settings || {}, settings);
  saveDB(db);
}

// Audit log helper
function auditLog(action, details) {
  const db = getDB();
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.unshift({
    ts: new Date().toISOString(),
    user: currentUser ? currentUser.username : 'system',
    action,
    details: details || ''
  });
  // keep last 500 entries
  if (db.auditLog.length > 500) db.auditLog = db.auditLog.slice(0, 500);
  saveDB(db);
}

function hashPass(p) {
  // Simple hash (not cryptographic - for demo)
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    h = ((h << 5) - h) + p.charCodeAt(i);
    h = h & h;
  }
  return 'h' + Math.abs(h).toString(36) + p.length;
}

// ============================================================
// HOLIDAYS DATA — מלא ומדויק 2026–2030
// מבנה: "YYYY-M-D": { n: שם, half: חצי-יום, blocked: חסום }
// blocked=true  → לא ניתן לבחור (יום חג/זיכרון רשמי)
// half=true     → יום קצר (ערב חג, הושענא רבה, יום הזיכרון, יום השואה)
// שאר הימים    → מופיעים בלוח ומידע, ניתן לבחור חופשה
// ============================================================
const HOLIDAYS = {
  "2026-1-1":{n:"עשרה בטבת",half:false,blocked:false},
  "2026-1-30":{n:"ערב ט\"ו בשבט",half:false,blocked:false},
  "2026-1-31":{n:"ט\"ו בשבט",half:false,blocked:false},
  "2026-2-17":{n:"יום המשפחה",half:false,blocked:false},
  "2026-3-2":{n:"תענית אסתר",half:false,blocked:false},
  "2026-3-3":{n:"פורים",half:false,blocked:false},
  "2026-3-4":{n:"שושן פורים",half:false,blocked:false},
  "2026-4-1":{n:"ערב פסח",half:true,blocked:false},
  "2026-4-2":{n:"פסח",half:false,blocked:true},
  "2026-4-3":{n:"חול המועד פסח",half:false,blocked:false},
  "2026-4-4":{n:"חול המועד פסח",half:false,blocked:false},
  "2026-4-5":{n:"חול המועד פסח",half:false,blocked:false},
  "2026-4-6":{n:"חול המועד פסח",half:false,blocked:false},
  "2026-4-7":{n:"ערב שביעי של פסח",half:true,blocked:false},
  "2026-4-8":{n:"שביעי של פסח",half:false,blocked:true},
  "2026-4-9":{n:"מימונה",half:false,blocked:false},
  "2026-4-13":{n:"ערב יום השואה",half:false,blocked:false},
  "2026-4-14":{n:"יום השואה והגבורה",half:false,blocked:false},
  "2026-4-20":{n:"ערב יום הזיכרון",half:false,blocked:false},
  "2026-4-21":{n:"יום הזיכרון",half:true,blocked:false},
  "2026-4-22":{n:"יום העצמאות",half:false,blocked:true},
  "2026-5-1":{n:"פסח שני",half:false,blocked:false},
  "2026-5-5":{n:"ל\"ג בעומר",half:false,blocked:false},
  "2026-5-15":{n:"יום ירושלים",half:false,blocked:false},
  "2026-5-21":{n:"ערב שבועות",half:true,blocked:false},
  "2026-5-22":{n:"שבועות",half:false,blocked:true},
  "2026-7-2":{n:"צום י\"ז בתמוז",half:false,blocked:false},
  "2026-7-22":{n:"ערב תשעה באב",half:true,blocked:false},
  "2026-7-23":{n:"תשעה באב",half:false,blocked:false},
  "2026-7-29":{n:"ט\"ו באב",half:false,blocked:false},
  "2026-9-11":{n:"ערב ראש השנה",half:true,blocked:false},
  "2026-9-12":{n:"ראש השנה",half:false,blocked:true},
  "2026-9-13":{n:"ראש השנה ב'",half:false,blocked:true},
  "2026-9-14":{n:"צום גדליה",half:false,blocked:false},
  "2026-9-20":{n:"ערב יום כיפור",half:true,blocked:false},
  "2026-9-21":{n:"יום כיפור",half:false,blocked:true},
  "2026-9-25":{n:"ערב סוכות",half:true,blocked:false},
  "2026-9-26":{n:"סוכות",half:false,blocked:true},
  "2026-9-27":{n:"חול המועד סוכות",half:false,blocked:false},
  "2026-9-28":{n:"חול המועד סוכות",half:false,blocked:false},
  "2026-9-29":{n:"חול המועד סוכות",half:false,blocked:false},
  "2026-9-30":{n:"חול המועד סוכות",half:false,blocked:false},
  "2026-10-1":{n:"חול המועד סוכות",half:false,blocked:false},
  "2026-10-2":{n:"הושענא רבה",half:true,blocked:false},
  "2026-10-3":{n:"שמחת תורה",half:false,blocked:true},
  "2026-11-8":{n:"ערב סיגד",half:true,blocked:false},
  "2026-11-9":{n:"חג הסיגד",half:false,blocked:false},
  "2026-12-4":{n:"ערב חנוכה",half:true,blocked:false},
  "2026-12-5":{n:"חנוכה - נר א'",half:false,blocked:false},
  "2026-12-6":{n:"חנוכה - נר ב'",half:false,blocked:false},
  "2026-12-7":{n:"חנוכה - נר ג'",half:false,blocked:false},
  "2026-12-8":{n:"חנוכה - נר ד'",half:false,blocked:false},
  "2026-12-9":{n:"חנוכה - נר ה'",half:false,blocked:false},
  "2026-12-10":{n:"חנוכה - נר ו'",half:false,blocked:false},
  "2026-12-11":{n:"חנוכה - נר ז'",half:false,blocked:false},
  "2026-12-12":{n:"זאת חנוכה",half:false,blocked:false},
  "2026-12-20":{n:"עשרה בטבת",half:false,blocked:false},
  "2027-1-19":{n:"ערב ט\"ו בשבט",half:false,blocked:false},
  "2027-1-20":{n:"ט\"ו בשבט",half:false,blocked:false},
  "2027-2-15":{n:"יום המשפחה",half:false,blocked:false},
  "2027-3-22":{n:"תענית אסתר",half:false,blocked:false},
  "2027-3-23":{n:"פורים",half:false,blocked:false},
  "2027-3-24":{n:"שושן פורים",half:false,blocked:false},
  "2027-4-21":{n:"ערב פסח",half:true,blocked:false},
  "2027-4-22":{n:"פסח",half:false,blocked:true},
  "2027-4-23":{n:"חול המועד פסח",half:false,blocked:false},
  "2027-4-24":{n:"חול המועד פסח",half:false,blocked:false},
  "2027-4-25":{n:"חול המועד פסח",half:false,blocked:false},
  "2027-4-26":{n:"חול המועד פסח",half:false,blocked:false},
  "2027-4-27":{n:"ערב שביעי של פסח",half:true,blocked:false},
  "2027-4-28":{n:"שביעי של פסח",half:false,blocked:true},
  "2027-4-29":{n:"מימונה",half:false,blocked:false},
  "2027-5-3":{n:"ערב יום השואה",half:false,blocked:false},
  "2027-5-4":{n:"יום השואה והגבורה",half:false,blocked:false},
  "2027-5-10":{n:"ערב יום הזיכרון",half:false,blocked:false},
  "2027-5-11":{n:"יום הזיכרון",half:true,blocked:false},
  "2027-5-12":{n:"יום העצמאות",half:false,blocked:true},
  "2027-5-20":{n:"פסח שני",half:false,blocked:false},
  "2027-5-24":{n:"ל\"ג בעומר",half:false,blocked:false},
  "2027-6-3":{n:"יום ירושלים",half:false,blocked:false},
  "2027-6-10":{n:"ערב שבועות",half:true,blocked:false},
  "2027-6-11":{n:"שבועות",half:false,blocked:true},
  "2027-7-22":{n:"צום י\"ז בתמוז",half:false,blocked:false},
  "2027-8-11":{n:"ערב תשעה באב",half:true,blocked:false},
  "2027-8-12":{n:"תשעה באב",half:false,blocked:false},
  "2027-8-18":{n:"ט\"ו באב",half:false,blocked:false},
  "2027-10-1":{n:"ערב ראש השנה",half:true,blocked:false},
  "2027-10-2":{n:"ראש השנה",half:false,blocked:true},
  "2027-10-3":{n:"ראש השנה ב'",half:false,blocked:true},
  "2027-10-4":{n:"צום גדליה",half:false,blocked:false},
  "2027-10-10":{n:"ערב יום כיפור",half:true,blocked:false},
  "2027-10-11":{n:"יום כיפור",half:false,blocked:true},
  "2027-10-15":{n:"ערב סוכות",half:true,blocked:false},
  "2027-10-16":{n:"סוכות",half:false,blocked:true},
  "2027-10-17":{n:"חול המועד סוכות",half:false,blocked:false},
  "2027-10-18":{n:"חול המועד סוכות",half:false,blocked:false},
  "2027-10-19":{n:"חול המועד סוכות",half:false,blocked:false},
  "2027-10-20":{n:"חול המועד סוכות",half:false,blocked:false},
  "2027-10-21":{n:"חול המועד סוכות",half:false,blocked:false},
  "2027-10-22":{n:"הושענא רבה",half:true,blocked:false},
  "2027-10-23":{n:"שמחת תורה",half:false,blocked:true},
  "2027-10-28":{n:"ערב סיגד",half:true,blocked:false},
  "2027-10-29":{n:"חג הסיגד",half:false,blocked:false},
  "2027-11-15":{n:"יום רבין",half:false,blocked:false},
  "2027-12-24":{n:"ערב חנוכה",half:true,blocked:false},
  "2027-12-25":{n:"חנוכה - נר א'",half:false,blocked:false},
  "2027-12-26":{n:"חנוכה - נר ב'",half:false,blocked:false},
  "2027-12-27":{n:"חנוכה - נר ג'",half:false,blocked:false},
  "2027-12-28":{n:"חנוכה - נר ד'",half:false,blocked:false},
  "2027-12-29":{n:"חנוכה - נר ה'",half:false,blocked:false},
  "2027-12-30":{n:"חנוכה - נר ו'",half:false,blocked:false},
  "2027-12-31":{n:"חנוכה - נר ז'",half:false,blocked:false},
  "2028-1-1":{n:"זאת חנוכה",half:false,blocked:false},
  "2028-1-8":{n:"ערב ט\"ו בשבט",half:false,blocked:false},
  "2028-1-9":{n:"ט\"ו בשבט",half:false,blocked:false},
  "2028-1-20":{n:"עשרה בטבת",half:false,blocked:false},
  "2028-2-14":{n:"יום המשפחה",half:false,blocked:false},
  "2028-3-9":{n:"תענית אסתר",half:false,blocked:false},
  "2028-3-10":{n:"פורים",half:false,blocked:false},
  "2028-3-11":{n:"שושן פורים",half:false,blocked:false},
  "2028-4-10":{n:"ערב פסח",half:true,blocked:false},
  "2028-4-11":{n:"פסח",half:false,blocked:true},
  "2028-4-12":{n:"חול המועד פסח",half:false,blocked:false},
  "2028-4-13":{n:"חול המועד פסח",half:false,blocked:false},
  "2028-4-14":{n:"חול המועד פסח",half:false,blocked:false},
  "2028-4-15":{n:"חול המועד פסח",half:false,blocked:false},
  "2028-4-16":{n:"ערב שביעי של פסח",half:true,blocked:false},
  "2028-4-17":{n:"שביעי של פסח",half:false,blocked:true},
  "2028-4-18":{n:"מימונה",half:false,blocked:false},
  "2028-4-23":{n:"ערב יום השואה",half:false,blocked:false},
  "2028-4-24":{n:"יום השואה והגבורה",half:false,blocked:false},
  "2028-4-29":{n:"פסח שני",half:false,blocked:false},
  "2028-4-30":{n:"ערב יום הזיכרון",half:false,blocked:false},
  "2028-5-1":{n:"יום הזיכרון",half:true,blocked:false},
  "2028-5-2":{n:"יום העצמאות",half:false,blocked:true},
  "2028-5-13":{n:"ל\"ג בעומר",half:false,blocked:false},
  "2028-5-23":{n:"יום ירושלים",half:false,blocked:false},
  "2028-5-30":{n:"ערב שבועות",half:true,blocked:false},
  "2028-5-31":{n:"שבועות",half:false,blocked:true},
  "2028-7-9":{n:"צום י\"ז בתמוז",half:false,blocked:false},
  "2028-7-29":{n:"ערב תשעה באב",half:true,blocked:false},
  "2028-7-30":{n:"תשעה באב",half:false,blocked:false},
  "2028-8-5":{n:"ט\"ו באב",half:false,blocked:false},
  "2028-9-20":{n:"ערב ראש השנה",half:true,blocked:false},
  "2028-9-21":{n:"ראש השנה",half:false,blocked:true},
  "2028-9-22":{n:"ראש השנה ב'",half:false,blocked:true},
  "2028-9-23":{n:"צום גדליה",half:false,blocked:false},
  "2028-9-29":{n:"ערב יום כיפור",half:true,blocked:false},
  "2028-9-30":{n:"יום כיפור",half:false,blocked:true},
  "2028-10-4":{n:"ערב סוכות",half:true,blocked:false},
  "2028-10-5":{n:"סוכות",half:false,blocked:true},
  "2028-10-6":{n:"חול המועד סוכות",half:false,blocked:false},
  "2028-10-7":{n:"חול המועד סוכות",half:false,blocked:false},
  "2028-10-8":{n:"חול המועד סוכות",half:false,blocked:false},
  "2028-10-9":{n:"חול המועד סוכות",half:false,blocked:false},
  "2028-10-10":{n:"חול המועד סוכות",half:false,blocked:false},
  "2028-10-11":{n:"הושענא רבה",half:true,blocked:false},
  "2028-10-12":{n:"שמחת תורה",half:false,blocked:true},
  "2028-10-17":{n:"ערב סיגד",half:true,blocked:false},
  "2028-10-18":{n:"חג הסיגד",half:false,blocked:false},
  "2028-11-4":{n:"יום רבין",half:false,blocked:false},
  "2028-12-12":{n:"ערב חנוכה",half:true,blocked:false},
  "2028-12-13":{n:"חנוכה - נר א'",half:false,blocked:false},
  "2028-12-14":{n:"חנוכה - נר ב'",half:false,blocked:false},
  "2028-12-15":{n:"חנוכה - נר ג'",half:false,blocked:false},
  "2028-12-16":{n:"חנוכה - נר ד'",half:false,blocked:false},
  "2028-12-17":{n:"חנוכה - נר ה'",half:false,blocked:false},
  "2028-12-18":{n:"חנוכה - נר ו'",half:false,blocked:false},
  "2028-12-19":{n:"חנוכה - נר ז'",half:false,blocked:false},
  "2028-12-20":{n:"זאת חנוכה",half:false,blocked:false},
  "2029-1-9":{n:"עשרה בטבת",half:false,blocked:false},
  "2029-1-28":{n:"ערב ט\"ו בשבט",half:false,blocked:false},
  "2029-1-29":{n:"ט\"ו בשבט",half:false,blocked:false},
  "2029-2-12":{n:"יום המשפחה",half:false,blocked:false},
  "2029-2-27":{n:"תענית אסתר",half:false,blocked:false},
  "2029-2-28":{n:"פורים",half:false,blocked:false},
  "2029-3-1":{n:"שושן פורים",half:false,blocked:false},
  "2029-3-30":{n:"ערב פסח",half:true,blocked:false},
  "2029-3-31":{n:"פסח",half:false,blocked:true},
  "2029-4-1":{n:"חול המועד פסח",half:false,blocked:false},
  "2029-4-2":{n:"חול המועד פסח",half:false,blocked:false},
  "2029-4-3":{n:"חול המועד פסח",half:false,blocked:false},
  "2029-4-4":{n:"חול המועד פסח",half:false,blocked:false},
  "2029-4-5":{n:"ערב שביעי של פסח",half:true,blocked:false},
  "2029-4-6":{n:"שביעי של פסח",half:false,blocked:true},
  "2029-4-7":{n:"מימונה",half:false,blocked:false},
  "2029-4-11":{n:"ערב יום השואה",half:false,blocked:false},
  "2029-4-12":{n:"יום השואה והגבורה",half:false,blocked:false},
  "2029-4-18":{n:"פסח שני",half:false,blocked:false},
  "2029-4-19":{n:"ערב יום הזיכרון",half:false,blocked:false},
  "2029-4-20":{n:"יום הזיכרון",half:true,blocked:false},
  "2029-4-21":{n:"יום העצמאות",half:false,blocked:true},
  "2029-5-2":{n:"ל\"ג בעומר",half:false,blocked:false},
  "2029-5-12":{n:"יום ירושלים",half:false,blocked:false},
  "2029-5-19":{n:"ערב שבועות",half:true,blocked:false},
  "2029-5-20":{n:"שבועות",half:false,blocked:true},
  "2029-6-28":{n:"צום י\"ז בתמוז",half:false,blocked:false},
  "2029-7-18":{n:"ערב תשעה באב",half:true,blocked:false},
  "2029-7-19":{n:"תשעה באב",half:false,blocked:false},
  "2029-7-25":{n:"ט\"ו באב",half:false,blocked:false},
  "2029-9-9":{n:"ערב ראש השנה",half:true,blocked:false},
  "2029-9-10":{n:"ראש השנה",half:false,blocked:true},
  "2029-9-11":{n:"ראש השנה ב'",half:false,blocked:true},
  "2029-9-12":{n:"צום גדליה",half:false,blocked:false},
  "2029-9-18":{n:"ערב יום כיפור",half:true,blocked:false},
  "2029-9-19":{n:"יום כיפור",half:false,blocked:true},
  "2029-9-23":{n:"ערב סוכות",half:true,blocked:false},
  "2029-9-24":{n:"סוכות",half:false,blocked:true},
  "2029-9-25":{n:"חול המועד סוכות",half:false,blocked:false},
  "2029-9-26":{n:"חול המועד סוכות",half:false,blocked:false},
  "2029-9-27":{n:"חול המועד סוכות",half:false,blocked:false},
  "2029-9-28":{n:"חול המועד סוכות",half:false,blocked:false},
  "2029-9-29":{n:"חול המועד סוכות",half:false,blocked:false},
  "2029-9-30":{n:"הושענא רבה",half:true,blocked:false},
  "2029-10-1":{n:"שמחת תורה",half:false,blocked:true},
  "2029-10-6":{n:"ערב סיגד",half:true,blocked:false},
  "2029-10-7":{n:"חג הסיגד",half:false,blocked:false},
  "2029-11-3":{n:"יום רבין",half:false,blocked:false},
  "2029-12-1":{n:"ערב חנוכה",half:true,blocked:false},
  "2029-12-2":{n:"חנוכה - נר א'",half:false,blocked:false},
  "2029-12-3":{n:"חנוכה - נר ב'",half:false,blocked:false},
  "2029-12-4":{n:"חנוכה - נר ג'",half:false,blocked:false},
  "2029-12-5":{n:"חנוכה - נר ד'",half:false,blocked:false},
  "2029-12-6":{n:"חנוכה - נר ה'",half:false,blocked:false},
  "2029-12-7":{n:"חנוכה - נר ו'",half:false,blocked:false},
  "2029-12-8":{n:"חנוכה - נר ז'",half:false,blocked:false},
  "2029-12-9":{n:"זאת חנוכה",half:false,blocked:false},
  "2029-12-30":{n:"עשרה בטבת",half:false,blocked:false},
  "2030-1-17":{n:"ערב ט\"ו בשבט",half:false,blocked:false},
  "2030-1-18":{n:"ט\"ו בשבט",half:false,blocked:false},
  "2030-2-11":{n:"יום המשפחה",half:false,blocked:false},
  "2030-3-18":{n:"תענית אסתר",half:false,blocked:false},
  "2030-3-19":{n:"פורים",half:false,blocked:false},
  "2030-3-20":{n:"שושן פורים",half:false,blocked:false},
  "2030-4-18":{n:"ערב פסח",half:true,blocked:false},
  "2030-4-19":{n:"פסח",half:false,blocked:true},
  "2030-4-20":{n:"חול המועד פסח",half:false,blocked:false},
  "2030-4-21":{n:"חול המועד פסח",half:false,blocked:false},
  "2030-4-22":{n:"חול המועד פסח",half:false,blocked:false},
  "2030-4-23":{n:"חול המועד פסח",half:false,blocked:false},
  "2030-4-24":{n:"ערב שביעי של פסח",half:true,blocked:false},
  "2030-4-25":{n:"שביעי של פסח",half:false,blocked:true},
  "2030-4-26":{n:"מימונה",half:false,blocked:false},
  "2030-4-29":{n:"ערב יום השואה",half:false,blocked:false},
  "2030-4-30":{n:"יום השואה והגבורה",half:false,blocked:false},
  "2030-5-6":{n:"ערב יום הזיכרון",half:false,blocked:false},
  "2030-5-7":{n:"יום הזיכרון",half:true,blocked:false},
  "2030-5-8":{n:"יום העצמאות",half:false,blocked:true},
  "2030-5-16":{n:"פסח שני",half:false,blocked:false},
  "2030-5-20":{n:"ל\"ג בעומר",half:false,blocked:false},
  "2030-5-30":{n:"יום ירושלים",half:false,blocked:false},
  "2030-6-6":{n:"ערב שבועות",half:true,blocked:false},
  "2030-6-7":{n:"שבועות",half:false,blocked:true},
  "2030-7-17":{n:"צום י\"ז בתמוז",half:false,blocked:false},
  "2030-8-6":{n:"ערב תשעה באב",half:true,blocked:false},
  "2030-8-7":{n:"תשעה באב",half:false,blocked:false},
  "2030-8-13":{n:"ט\"ו באב",half:false,blocked:false},
  "2030-8-27":{n:"ערב ראש השנה",half:true,blocked:false},
  "2030-8-28":{n:"ראש השנה",half:false,blocked:true},
  "2030-8-29":{n:"ראש השנה ב'",half:false,blocked:true},
  "2030-8-30":{n:"צום גדליה",half:false,blocked:false},
  "2030-9-5":{n:"ערב יום כיפור",half:true,blocked:false},
  "2030-9-6":{n:"יום כיפור",half:false,blocked:true},
  "2030-9-10":{n:"ערב סוכות",half:true,blocked:false},
  "2030-9-11":{n:"סוכות",half:false,blocked:true},
  "2030-9-12":{n:"חול המועד סוכות",half:false,blocked:false},
  "2030-9-13":{n:"חול המועד סוכות",half:false,blocked:false},
  "2030-9-14":{n:"חול המועד סוכות",half:false,blocked:false},
  "2030-9-15":{n:"חול המועד סוכות",half:false,blocked:false},
  "2030-9-16":{n:"חול המועד סוכות",half:false,blocked:false},
  "2030-9-17":{n:"הושענא רבה",half:true,blocked:false},
  "2030-9-18":{n:"שמחת תורה",half:false,blocked:true},
  "2030-9-23":{n:"ערב סיגד",half:true,blocked:false},
  "2030-9-24":{n:"חג הסיגד",half:false,blocked:false},
  "2030-10-19":{n:"יום רבין",half:false,blocked:false},
  "2030-11-19":{n:"ערב חנוכה",half:true,blocked:false},
  "2030-11-20":{n:"חנוכה - נר א'",half:false,blocked:false},
  "2030-11-21":{n:"חנוכה - נר ב'",half:false,blocked:false},
  "2030-11-22":{n:"חנוכה - נר ג'",half:false,blocked:false},
  "2030-11-23":{n:"חנוכה - נר ד'",half:false,blocked:false},
  "2030-11-24":{n:"חנוכה - נר ה'",half:false,blocked:false},
  "2030-11-25":{n:"חנוכה - נר ו'",half:false,blocked:false},
  "2030-11-26":{n:"חנוכה - נר ז'",half:false,blocked:false},
  "2030-11-27":{n:"זאת חנוכה",half:false,blocked:false},
  "2030-12-19":{n:"עשרה בטבת",half:false,blocked:false},
};

// ============================================================
// getHolidayInfo — ממיר תאריך YYYY-MM-DD למידע חג
// ============================================================
function getHolidayInfo(dateStr) {
  // Convert "YYYY-MM-DD" → "YYYY-M-D" (without leading zeros) to match HOLIDAYS keys
  const parts = dateStr.split('-');
  const key = `${parts[0]}-${parseInt(parts[1])}-${parseInt(parts[2])}`;
  const h = HOLIDAYS[key];
  if (!h) return null;
  return {
    name:     h.n,
    isPublic: h.blocked,   // blocked = חג שלא עובדים בו = "public holiday"
    isHalf:   h.half,      // half = יום קצר
    canChoose: h.half && !h.blocked // ערב חג = ניתן לבחור חצי יום
  };
}

function dateToStr(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// ============================================================
// AUTH STATE
// ============================================================

function doLogin() {
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  if (!username || !password) { showLoginError('נא למלא שם משתמש וסיסמה'); return; }

  // ── Rate limit ──
  const rl = _checkRL();
  if (rl.blocked) { showLoginError(`⛔ יותר מדי נסיונות. נסה בעוד ${rl.secs} שניות.`); return; }

  const db = getDB();
  const user = db.users[username] || db.users[username.toLowerCase()];
  if (!user) { _failRL(); showLoginError('שם משתמש לא קיים במערכת'); return; }

  // ── SHA-256 + fallback legacy ──
  _sha256(password).then(sha256hash => {
    const stored = user.password || '';
    const legacy = hashPass(password);
    if (stored !== sha256hash && stored !== legacy) {
      _failRL(); showLoginError('סיסמה שגויה'); return;
    }
    // מיגרציה שקטה לסיסמה מוצפנת
    if (stored === legacy) {
      user.password = sha256hash;
      db.users[username] = user;
      saveDB(db);
    }
    _clearRL();
    currentUser = user;
    hideLoginError();

    // ── Firebase Auth — non-blocking ──
    _fbAuthLogin(username, password).catch(()=>{});

    if (!isUserActive(user)) {
      document.getElementById('loginScreen').classList.remove('active');
      document.getElementById('pendingApprovalScreen').classList.add('active');
      document.getElementById('pendingUserName').textContent = user.fullName;
      currentUser = null;
      return;
    }
    if (user.mustChangePassword) {
      document.getElementById('loginScreen').classList.remove('active');
      showForcePasswordChange();
      return;
    }
    document.getElementById('loginScreen').classList.remove('active');
    if (typeof DazuraAI !== 'undefined') DazuraAI.clearHistory();
    if (typeof DazuraFuse !== 'undefined') DazuraFuse.clearHistory();
    const aiMsgs = document.getElementById('aiMessages');
    if (aiMsgs) aiMsgs.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon">🤖</div><p>שלום! אני Dazura AI. שאל אותי כל שאלה הקשורה לחופשות, נוכחות ומידע ארגוני.</p></div>';
    const aiPanel = document.getElementById('aiPanel');
    if (aiPanel) aiPanel.classList.remove('open');
    _aiPanelOpen = false;
    showAIButton();
    showModuleSelector();
  });
}

// Firebase Auth וירטואלי — non-blocking לחלוטין, לא נוגע בסנכרון
async function _fbAuthLogin(username, password) {
  try {
    const auth = await ensureFirebaseAuth();
    if (!auth.currentUser) {
      await auth.signInAnonymously();
    }
  } catch(e) { /* non-critical */ }
}

function doLogout() {
  // ── Full AI reset on logout ──
  if (typeof DazuraAI !== 'undefined') DazuraAI.clearHistory();
  if (typeof DazuraFuse !== 'undefined') DazuraFuse.clearHistory();
  const aiMsgs = document.getElementById('aiMessages');
  if (aiMsgs) aiMsgs.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon">🤖</div><p>שלום! אני Dazura AI. שאל אותי כל שאלה הקשורה לחופשות, נוכחות ומידע ארגוני.</p></div>';
  // Firebase Auth sign out — non-blocking
  ensureFirebaseAuth().then(auth => auth.signOut()).catch(()=>{});
  currentUser = null;
  hideAIButton();
  ['appScreen','timeClockScreen','moduleSelectorScreen','ceoDashboardScreen'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('loginPassword').value = '';
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideLoginError() {
  document.getElementById('loginError').style.display = 'none';
}

function regNextStep(step) {
  const errEl = document.getElementById('registerError');
  errEl.style.display = 'none';

  // Validate before moving forward
  if (step === 2) {
    const fullName = document.getElementById('regFullName').value.trim();
    const username = document.getElementById('regUsername').value.trim();
    const dept     = document.getElementById('regDept').value;
    if (!fullName) { errEl.textContent = 'נא להזין שם מלא'; errEl.style.display = 'block'; return; }
    if (!username) { errEl.textContent = 'נא להזין שם משתמש'; errEl.style.display = 'block'; return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { errEl.textContent = 'שם משתמש: אנגלית/מספרים בלבד'; errEl.style.display = 'block'; return; }
    if (!dept) { errEl.textContent = 'נא לבחור מחלקה'; errEl.style.display = 'block'; return; }
    const db = getDB();
    if (db.users[username.toLowerCase()]) { errEl.textContent = 'שם משתמש זה כבר קיים'; errEl.style.display = 'block'; return; }
  }
  if (step === 3) {
    const pass  = document.getElementById('regPassword').value;
    const pass2 = document.getElementById('regPassword2').value;
    if (pass.length < 4) { errEl.textContent = 'הסיסמה חייבת להיות לפחות 4 תווים'; errEl.style.display = 'block'; return; }
    if (pass !== pass2)  { errEl.textContent = 'הסיסמאות אינן תואמות'; errEl.style.display = 'block'; return; }
  }

  // Show correct step
  [1,2,3].forEach(i => {
    document.getElementById('regStep' + i).style.display = i === step ? '' : 'none';
    document.getElementById('regDot' + i).style.background = i <= step ? 'var(--primary)' : 'var(--border)';
  });
}

function showRegister() {
  populateDeptSelect('regDept');
  document.getElementById('registerError').style.display = 'none';
  ['regFullName','regUsername','regPassword','regPassword2','regEmail'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Reset to step 1
  regNextStep(1);
  openModal('registerModal');
}
function hideRegister() {
  closeModal('registerModal');
}

function populateDeptSelect(selectId) {
  const db = getDB();
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">בחר מחלקה...</option>' + (db.departments||[]).map(d=>`<option value="${d}">${d}</option>`).join('');
  if (cur) sel.value = cur;
}

function doRegister() {
  const fullName = document.getElementById('regFullName').value.trim();
  const username = document.getElementById('regUsername').value.trim().toLowerCase();
  const dept = document.getElementById('regDept').value;
  const pass = document.getElementById('regPassword').value;
  const pass2 = document.getElementById('regPassword2').value;
  const errEl = document.getElementById('registerError');
  errEl.style.display = 'none';
  
  if (!fullName || !username || !dept || !pass) {
    errEl.textContent = 'נא למלא את כל השדות'; errEl.style.display = 'block'; return;
  }
  if (pass.length < 4) {
    errEl.textContent = 'הסיסמה חייבת להיות לפחות 4 תווים'; errEl.style.display = 'block'; return;
  }
  if (pass !== pass2) {
    errEl.textContent = 'הסיסמאות אינן תואמות'; errEl.style.display = 'block'; return;
  }
  
  const db = getDB();
  if (db.users[username]) {
    errEl.textContent = 'שם משתמש זה כבר קיים'; errEl.style.display = 'block'; return;
  }

  // Check if admin approval required
  const requireApproval = getSettings().requireRegistrationApproval !== false; // default: true
  const status = requireApproval ? 'pending' : 'active';
  
  const email = document.getElementById('regEmail')?.value.trim() || '';
  _sha256(pass).then(sha256hash => {
    db.users[username] = {
      fullName, username, password: sha256hash,
      dept, role: 'employee', status, email,
      quotas: { [new Date().getFullYear()]: { annual: 0, initialBalance: 0 } },
      registeredAt: new Date().toISOString()
    };
    saveDB(db);
    if (email) {
      createFirebaseAuthUser(email, pass).then(r => {
        if (!r.success) console.warn('Firebase Auth user creation failed:', r.error);
      });
    }
    closeModal('registerModal');
    if (requireApproval) {
      document.getElementById('loginScreen').classList.remove('active');
      document.getElementById('pendingApprovalScreen').classList.add('active');
      document.getElementById('pendingUserName').textContent = fullName;
    } else {
      showToast('✅ נרשמת בהצלחה! כעת תוכל להיכנס למערכת', 'success');
      document.getElementById('loginUsername').value = username;
    }
    auditLog('register', `${fullName} (${username}) נרשם — ממתין לאישור`);
  });
}

// ============================================================
// APP INITIALIZATION
// ============================================================
function showApp(skipModuleSelector) {
  // Block pending users
  if (!isUserActive(currentUser)) {
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('pendingApprovalScreen').classList.add('active');
    document.getElementById('pendingUserName').textContent = currentUser.fullName;
    currentUser = null;
    return;
  }

  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');
  showAIButton();
  // Set user info
  document.getElementById('navUserName').textContent = currentUser.fullName;
  document.getElementById('userAvatar').textContent = currentUser.fullName.charAt(0);

  // Show company name in nav if element exists
  const nameDisplay = document.getElementById('companyNameDisplay');
  if(nameDisplay) nameDisplay.textContent = getSettings().companyName;
  
  // Determine roles
  const isAdmin      = currentUser.role === 'admin' || currentUser.role === 'accountant';
  const isManager    = currentUser.role === 'manager' || isAdmin || isUserDeptManager(currentUser.username);
  // TAB ניהול — נגיש לאדמין מלא בלבד, או למשתמש עם הרשאות מפורשות
  // TAB ניהול — admin, accountant, ועובד עם הרשאות מפורשות רואים את הטאב (רק הסעיפים שהוענקו)
  const hasAdminAccess = currentUser.role === 'admin' || userHasAnyAdminAccess(currentUser.username);

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = hasAdminAccess ? '' : 'none';
  });
  document.querySelectorAll('.manager-only').forEach(el => {
    el.style.display = isManager ? '' : 'none';
  });
  
  // Firebase button: admin only
  document.getElementById('firebaseBadge').style.display = currentUser.role === 'admin' ? '' : 'none';
  
  // Init calendar
  const now = new Date();
  calState.year = now.getFullYear() < 2026 ? 2026 : Math.min(now.getFullYear(), 2030);
  calState.month = now.getMonth() + 1;
  
  // Audit login
  auditLog('login', `${currentUser.fullName} התחבר למערכת`);
  
  // Apply saved branding immediately
  applyBranding();
  loadTheme();
  
  buildCalendarSelects();
  showTab('dashboard');
  setTimeout(renderAnnouncements, 800);
  setTimeout(populateQuickPermUser, 2000);

  // הצג כפתורי employee-only רק לעובד רגיל
  const isEmployee = currentUser.role === 'employee' || !currentUser.role;
  document.querySelectorAll('.employee-only').forEach(el => {
    el.style.display = isEmployee ? '' : 'none';
  });

  // הפעל פולר + בדיקת פרוטוקול לעובדים
  if (isEmployee) {
    startHandoverPoller();
    setTimeout(checkHandoverNeeded, 1500);
    setTimeout(renderMyHandoverCard, 600);
  }
}

// ============================================================
// TAB SYSTEM
// ============================================================
function showTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
  
  const el = document.getElementById('tab-' + tab);
  if (el) el.classList.add('active');
  
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(btn => btn.classList.add('active'));
  
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'calendar') renderCalendar();
  if (tab === 'yearly') renderYearly();
  if (tab === 'report') renderReport();
  if (tab === 'admin') { renderAdmin(); loadCompanySettings(); populateQuickPermUser(); }
  if (tab === 'manager') renderManagerDashboard();

  // בדוק אם נדרש פרוטוקול — בכל מעבר טאב
  checkHandoverNeeded();
}

// ============================================================
// VACATION DATA
// ============================================================
function getVacations(username) {
  const db = getDB();
  return db.vacations[username] || {};
}
function saveVacation(username, dateStr, type) {
  const db = getDB();
  if (!db.vacations[username]) db.vacations[username] = {};
  if (type === null) {
    delete db.vacations[username][dateStr];
    auditLog('vacation_remove', `${username} ביטל חופשה ב-${dateStr}`);
  } else {
    db.vacations[username][dateStr] = type;
    auditLog('vacation_add', `${username} רשם ${type==='wfh'?'WFH':type==='half'?'חצי יום':'חופשה'} ב-${dateStr}`);
  }

  // If there's an approved/rejected request for this month — reset it to "needs resubmit"
  // because the vacation days changed
  const [yearStr, monthStr] = dateStr.split('-');
  const year = parseInt(yearStr), month = parseInt(monthStr);
  if (db.approvalRequests) {
    db.approvalRequests.forEach(r => {
      if (r.username === username && r.year === year && r.month === month
          && (r.status === 'approved' || r.status === 'rejected')) {
        r.status = 'changed'; // special status: was approved but days changed
        r.changedAt = new Date().toISOString();
      }
    });
  }

  saveDB(db);
  updateApprovalStatusBadge();
}

function getVacationDaysCount(username, year) {
  const vacs = getVacations(username);
  let full = 0, half = 0, wfh = 0;
  for (const [dt, type] of Object.entries(vacs)) {
    if (dt.startsWith(String(year))) {
      if (type === 'full') full++;
      else if (type === 'half') half++;
      else if (type === 'wfh') wfh++;
    }
  }
  return { full, half, wfh, total: full + half * 0.5 };
}

function getQuota(username, year) {
  const db = getDB();
  const u = db.users[username];
  if (!u || !u.quotas) return { annual: 0, initialBalance: 0, knownBalance: null, balanceDate: null };
  return u.quotas[String(year)] || { annual: 0, initialBalance: 0, knownBalance: null, balanceDate: null };
}

// Which payroll period does a vacation date fall into?
// cycleStartDay=21 → period 21/Jan-20/Feb → drops in Feb (or March if dropMonth='next')
function getPayrollMonth(dateStr, settings) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  const month = d.getMonth() + 1; // 1-based
  const year = d.getFullYear();
  const cycleStart = settings.cycleStartDay || 1;

  let periodMonth, periodYear;
  if (cycleStart === 1) {
    // Standard: same month
    periodMonth = month;
    periodYear = year;
  } else {
    // e.g. cycleStart=21: dates 21/Feb-20/Mar → period is March
    if (day >= cycleStart) {
      // belongs to next month's period
      periodMonth = month === 12 ? 1 : month + 1;
      periodYear = month === 12 ? year + 1 : year;
    } else {
      periodMonth = month;
      periodYear = year;
    }
  }

  // dropMonth: 'next' means deduct in the month after the period
  if (settings.dropMonth === 'next') {
    periodMonth = periodMonth === 12 ? 1 : periodMonth + 1;
    if (periodMonth === 1) periodYear++;
  }

  return { month: periodMonth, year: periodYear };
}
// Logic (per the accountant's spreadsheet):
//   Inputs: annual=23, knownBalance=2 on 01/02/2026
//   monthly = 23/12 = 1.916
//   Months remaining (FROM the load month, NOT including it) to Dec = 12 - loadMonth = 10
//   End-of-year total = 2 + 1.916 × 10 = 21.12 ✓
//
//   Current balance = knownBalance + monthly × (currentMonth - loadMonth) - daysUsed
//   End-of-year     = knownBalance + monthly × (12 - loadMonth)           - daysUsed
// ============================================================
function calcBalance(username, year) {
  const quota = getQuota(username, year);
  const stats = getVacationDaysCount(username, year);
  const now = new Date();

  const annual = quota.annual || 0;
  const monthly = annual / 12;

  // --- Determine anchor: knownBalance + loadMonth ---
  let loadMonth = 1;      // default: Jan
  let knownBal  = 0;      // default: 0

  if (quota.balanceDate) {
    // New-style quota with explicit date
    const bd = new Date(quota.balanceDate + 'T00:00:00');
    if (bd.getFullYear() === year) {
      loadMonth = bd.getMonth() + 1;
    }
    knownBal = (quota.knownBalance !== null && quota.knownBalance !== undefined)
      ? quota.knownBalance
      : (quota.initialBalance || 0);
  } else {
    // Legacy quota: initialBalance was carry-over at Jan 1
    loadMonth = 1;
    knownBal  = quota.initialBalance || 0;
  }

  // --- Current month (for live balance) ---
  let currentMonth;
  if (now.getFullYear() === year) {
    currentMonth = now.getMonth() + 1;
  } else if (year < now.getFullYear()) {
    currentMonth = 12;
  } else {
    currentMonth = loadMonth; // future year — nothing extra accrued
  }

  // Months elapsed since load (0 while still in the load month)
  const monthsElapsed = Math.max(0, currentMonth - loadMonth);

  // Current balance
  const accrued = knownBal + monthly * monthsElapsed;
  const balance = accrued - stats.total;

  // End-of-year projection (12 - loadMonth months of accrual after load month)
  const monthsToEoY = Math.max(0, 12 - loadMonth);
  const endOfYearAccrued   = knownBal + monthly * monthsToEoY;
  const projectedEndBalance = endOfYearAccrued - stats.total;

  return { accrued, balance, monthly, knownBal, loadMonth, monthsElapsed,
           projectedEndBalance, endOfYearAccrued, stats, quota, annual, currentMonth };
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  renderAnnouncements();
  if (!currentUser) return;
  const year = calState.year;
  const cb = calcBalance(currentUser.username, year);
  
  document.getElementById('statQuota').textContent = cb.annual + ' ימים';
  document.getElementById('statUsed').textContent = cb.stats.total + ' ימים';
  document.getElementById('statBalance').textContent = cb.balance.toFixed(2) + ' ימים';
  document.getElementById('statMonthly').textContent = cb.monthly.toFixed(2) + ' ימים';
  
  // Color balance
  const balEl = document.getElementById('statBalance');
  balEl.style.color = cb.balance < 0 ? 'var(--danger)' : 'var(--warning)';
  
  // Quota upload notice for accountant/admin only
  if (currentUser.role === 'accountant' || currentUser.role === 'admin') {
    const nowDate = new Date();
    const isJan = nowDate.getMonth() === 0 && nowDate.getDate() <= 9;
    document.getElementById('quotaUploadSection').style.display = 'block';
    document.getElementById('quotaUploadStatus').textContent = isJan 
      ? ' — חלון הטעינה פתוח עד 09 לינואר!' 
      : ' — החלון נסגר (01-09 לינואר בלבד)';
  } else {
    document.getElementById('quotaUploadSection').style.display = 'none';
  }
  
  // Monthly bar chart
  renderMonthlyChart(year);
  
  // Upcoming vacations
  renderUpcoming();
  
  // Vacation forecast (surprise feature)
  renderVacationForecast();
  renderVacationDNA();
}

function renderMonthlyChart(year) {
  const vacs = getVacations(currentUser.username);
  const months = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
  const monthData = Array(12).fill(0);
  
  for (const [dt, type] of Object.entries(vacs)) {
    if (dt.startsWith(String(year))) {
      const m = parseInt(dt.split('-')[1]) - 1;
      monthData[m] += type === 'full' ? 1 : type === 'half' ? 0.5 : 0;
    }
  }
  
  const max = Math.max(...monthData, 1);
  const chartEl = document.getElementById('monthlyBarChart');
  const labelsEl = document.getElementById('monthlyBarLabels');
  
  chartEl.innerHTML = monthData.map((v, i) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
      <span style="font-size:10px;font-weight:700;color:${v > 0 ? 'var(--primary)' : 'var(--text-muted)'};">${v || ''}</span>
      <div style="width:100%;background:${v > 0 ? 'var(--primary)' : 'var(--border)'};height:${Math.round((v/max)*140)+4}px;border-radius:4px 4px 0 0;min-height:4px;transition:height 0.3s;"></div>
    </div>
  `).join('');
  
  labelsEl.innerHTML = months.map(m => `<div style="text-align:center;font-size:10px;color:var(--text-muted);font-weight:600;">${m}</div>`).join('');
}

function renderUpcoming() {
  const vacs = getVacations(currentUser.username);
  const today = new Date();
  today.setHours(0,0,0,0);
  
  const upcoming = Object.entries(vacs)
    .filter(([dt, type]) => {
      const d = new Date(dt);
      return d >= today && type !== 'wfh';
    })
    .sort(([a],[b]) => a.localeCompare(b))
    .slice(0, 5);
  
  const el = document.getElementById('upcomingVacations');
  if (upcoming.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px;text-align:center;padding:20px;">אין חופשות מתוכננות קרובות</p>';
    return;
  }
  
  el.innerHTML = upcoming.map(([dt, type]) => {
    const d = new Date(dt);
    const dayName = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'][d.getDay()];
    const typeLabel = type === 'full' ? '🟢 יום מלא' : '🔵 חצי יום';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
        <div>
          <div style="font-weight:700;font-size:14px;">${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}</div>
          <div style="font-size:12px;color:var(--text-muted);">${dayName}</div>
        </div>
        <span style="font-size:13px;font-weight:600;">${typeLabel}</span>
      </div>
    `;
  }).join('');
}

// ============================================================
// CALENDAR
// ============================================================

function buildCalendarSelects() {
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  const ms = document.getElementById('calMonthSelect');
  ms.innerHTML = monthNames.map((m, i) => `<option value="${i+1}" ${i+1===calState.month?'selected':''}>${m}</option>`).join('');
  
  const ys = document.getElementById('calYearSelect');
  ys.innerHTML = [2026,2027,2028,2029,2030].map(y => `<option value="${y}" ${y===calState.year?'selected':''}>${y}</option>`).join('');
}

function changeCalMonth() {
  calState.month = parseInt(document.getElementById('calMonthSelect').value);
  renderCalendar();
}
function changeCalYear() {
  calState.year = parseInt(document.getElementById('calYearSelect').value);
  renderCalendar();
}
function prevMonth() {
  calState.month--;
  if (calState.month < 1) { calState.month = 12; calState.year--; }
  if (calState.year < 2026) { calState.year = 2026; calState.month = 1; }
  buildCalendarSelects();
  renderCalendar();
}
function nextMonth() {
  calState.month++;
  if (calState.month > 12) { calState.month = 1; calState.year++; }
  if (calState.year > 2030) { calState.year = 2030; calState.month = 12; }
  buildCalendarSelects();
  renderCalendar();
}

function renderCalendar() {
  const { year, month } = calState;
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  document.getElementById('calTitle').textContent = `${monthNames[month-1]} ${year}`;
  
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';
  
  const firstDay = new Date(year, month-1, 1).getDay(); // 0=Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const vacs = getVacations(currentUser.username);
  
  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    grid.appendChild(empty);
  }
  
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = dateToStr(year, month, d);
    const dateObj = new Date(year, month-1, d);
    const dow = dateObj.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dow === 5 || dow === 6; // Fri/Sat
    const isToday = today.getDate()===d && today.getMonth()===month-1 && today.getFullYear()===year;
    
    const hol = getHolidayInfo(dateStr);
    const vacType = vacs[dateStr];
    const sickKey = currentUser.username + '_' + dateStr;
    const isSick  = !!(getDB().sick?.[sickKey]);

    const cell = document.createElement('div');
    cell.className = 'cal-day';

    if (isWeekend) {
      cell.classList.add('weekend-day');
    } else if (hol && hol.isPublic) {
      cell.classList.add('public-holiday');
    } else if (hol && hol.isHalf) {
      cell.classList.add('half-holiday');
    }

    // Vacation / sick colors override
    if (isSick)                cell.className = 'cal-day vac-sick';
    else if (vacType === 'full')  cell.className = 'cal-day vac-full';
    else if (vacType === 'half')  cell.className = 'cal-day vac-half';
    else if (vacType === 'wfh')   cell.className = 'cal-day vac-wfh';

    if (isToday) cell.classList.add('today');
    
    const dayNumEl = document.createElement('div');
    dayNumEl.className = 'day-num';
    dayNumEl.textContent = d;
    cell.appendChild(dayNumEl);
    
    if (hol && hol.name) {
      const eventEl = document.createElement('div');
      eventEl.className = 'day-event';
      eventEl.textContent = hol.name;
      cell.appendChild(eventEl);
    }

    if (isSick) {
      const sickBadge = document.createElement('div');
      sickBadge.className = 'day-badge';
      sickBadge.textContent = '🤒';
      sickBadge.style.cssText = 'background:#1f2937;color:white;';
      cell.appendChild(sickBadge);
    }

    if (!isWeekend && !(hol && hol.isPublic)) {
      cell.onclick = () => openDayModal(dateStr, hol, vacType, isSick);
    }
    
    grid.appendChild(cell);
  }
  
  // Update selects
  document.getElementById('calMonthSelect').value = month;
  document.getElementById('calYearSelect').value = year;
  
  // Show approval status badge
  updateApprovalStatusBadge();
}

// ============================================================
// DAY MODAL
// ============================================================
function openDayModal(dateStr, hol, currentType, isSick) {
  _currentDayModalDate = dateStr;
  // Reset sick toggle
  const toggle = document.getElementById('sickToggle');
  if (toggle) { toggle.checked = false; toggleSickMode(false); }

  const d = new Date(dateStr);
  const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  document.getElementById('dayModalTitle').textContent = `📅 ${dayNames[d.getDay()]} ${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
  
  let info = '';
  if (hol && hol.name) info = `<strong>אירוע:</strong> ${hol.name}<br>`;
  if (hol && hol.isHalf) info += `<span style="color:var(--warning);font-weight:600;">⚠️ ערב חג — ניתן לבחור חצי יום בלבד</span>`;
  document.getElementById('dayModalInfo').innerHTML = info;
  
  const opts = document.getElementById('dayModalOptions');
  opts.innerHTML = '';

  // If sick day — show only cancel sick option
  if (isSick) {
    document.getElementById('dayModalInfo').innerHTML = `<span style="color:#374151;font-weight:700;">🤒 יום מחלה מדווח</span>`;
    // Hide toggle since we're in sick mode view
    document.getElementById('sickToggle').closest('div').style.display = 'none';
    const btn = document.createElement('button');
    btn.style.cssText = 'display:block;width:100%;padding:14px 20px;border-radius:10px;border:2px solid var(--danger);background:#fef2f2;font-family:\'Heebo\',sans-serif;font-size:15px;font-weight:600;cursor:pointer;text-align:right;color:var(--danger);';
    btn.textContent = '❌ בטל דיווח מחלה';
    btn.onclick = () => {
      const db = getDB();
      delete db.sick[currentUser.username + '_' + dateStr];
      saveDB(db);
      closeModal('dayModal');
      renderCalendar();
      updateSickCount();
      showToast('✅ דיווח מחלה בוטל', 'success');
    };
    opts.appendChild(btn);
    openModal('dayModal');
    return;
  }

  // Restore toggle visibility
  const toggleWrap = document.getElementById('sickToggle')?.closest('div');
  if (toggleWrap) toggleWrap.style.display = '';

  // Determine what options are available
  const isHalfOnly = hol && hol.isHalf && !hol.isPublic;
  
  const options = [];
  if (!isHalfOnly) {
    options.push({ type: 'full', label: '🟢 חופשה יום מלא', color: 'var(--success)', active: currentType === 'full' });
  }
  options.push({ type: 'half', label: '🔵 חצי יום חופשה', color: 'var(--info)', active: currentType === 'half' });
  if (!isHalfOnly) {
    options.push({ type: 'wfh', label: '🟡 עבודה מהבית (WFH)', color: '#ca8a04', active: currentType === 'wfh' });
  }
  if (currentType) {
    options.push({ type: null, label: '❌ בטל בחירה', color: 'var(--danger)', active: false });
  }
  
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'day-option-btn';
    btn.style.cssText = `display:block;width:100%;padding:14px 20px;border-radius:10px;border:2px solid ${opt.active ? opt.color : 'var(--border)'};background:${opt.active ? opt.color + '22' : 'white'};font-family:'Heebo',sans-serif;font-size:15px;font-weight:600;cursor:pointer;text-align:right;color:${opt.active ? opt.color : 'var(--text)'};transition:all 0.2s;margin-bottom:8px;`;
    btn.textContent = opt.label + (opt.active ? ' ✓' : '');
    btn.onclick = () => {
      saveVacation(currentUser.username, dateStr, opt.type);
      closeModal('dayModal');
      renderCalendar();
      renderDashboard();
      showToast(opt.type ? '✅ הבחירה נשמרה' : '🗑️ הבחירה בוטלה', 'success');
    };
    opts.appendChild(btn);
  });
  
  openModal('dayModal');
}

// ============================================================
// YEARLY VIEW
// ============================================================
function renderYearly() {
  const year = parseInt(document.getElementById('yearlyYearSelect').value);
  const grid = document.getElementById('yearlyGrid');
  grid.innerHTML = '';
  
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const vacs = getVacations(currentUser.username);
  
  monthNames.forEach((mName, mi) => {
    const m = mi + 1;
    const card = document.createElement('div');
    card.className = 'month-mini-card';
    
    const title = document.createElement('div');
    title.className = 'month-mini-title';
    title.textContent = `${mName} ${year}`;
    card.appendChild(title);
    
    const miniGrid = document.createElement('div');
    miniGrid.className = 'month-mini-grid';
    
    // Day header
    ['א','ב','ג','ד','ה','ו','ש'].forEach(dn => {
      const h = document.createElement('div');
      h.style.cssText = 'font-size:9px;font-weight:700;color:var(--text-muted);text-align:center;padding:2px 0;';
      h.textContent = dn;
      miniGrid.appendChild(h);
    });
    
    const firstDay = new Date(year, m-1, 1).getDay();
    const daysInMonth = new Date(year, m, 0).getDate();
    
    for (let i = 0; i < firstDay; i++) {
      const e = document.createElement('div');
      e.className = 'mini-day empty';
      miniGrid.appendChild(e);
    }
    
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = dateToStr(year, m, d);
      const dow = new Date(year, m-1, d).getDay();
      const isWeekend = dow === 5 || dow === 6;
      const hol = getHolidayInfo(dateStr);
      const vacType = vacs[dateStr];
      
      const dd = document.createElement('div');
      dd.className = 'mini-day';
      dd.textContent = d;
      
      if (isWeekend) dd.classList.add('weekend');
      else if (hol && hol.isPublic) dd.classList.add('public-holiday');
      else if (hol && hol.isHalf && !vacType) dd.classList.add('half-holiday');
      
      if (vacType === 'full') dd.className = 'mini-day vac-full';
      else if (vacType === 'half') dd.className = 'mini-day vac-half';
      else if (vacType === 'wfh') dd.className = 'mini-day vac-wfh';
      
      if (!isWeekend && !(hol && hol.isPublic)) {
        dd.onclick = () => {
          calState.year = year;
          calState.month = m;
          buildCalendarSelects();
          showTab('calendar');
          setTimeout(() => openDayModal(dateStr, hol, vacType), 100);
        };
      }
      miniGrid.appendChild(dd);
    }
    
    card.appendChild(miniGrid);
    grid.appendChild(card);
  });
}

// ============================================================
// REPORT
// ============================================================
function renderReport() {
  const year = parseInt(document.getElementById('reportYearSelect').value);
  renderMyHandoverCard();
  document.getElementById('reportSubtitle').textContent = `סיכום שנת ${year} — ${currentUser.fullName}`;
  
  const cb = calcBalance(currentUser.username, year);
  const { annual, stats, balance, accrued } = cb;
  const monthly = cb.monthly.toFixed(2);
  
  const vacs = getVacations(currentUser.username);
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  // Group by month
  const byMonth = Array(12).fill(null).map(() => ({ full: 0, half: 0, wfh: 0 }));
  for (const [dt, type] of Object.entries(vacs)) {
    if (dt.startsWith(String(year))) {
      const m = parseInt(dt.split('-')[1]) - 1;
      if (type === 'full') byMonth[m].full++;
      else if (type === 'half') byMonth[m].half++;
      else if (type === 'wfh') byMonth[m].wfh++;
    }
  }
  
  const content = document.getElementById('reportContent');
  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px;">
      <div style="background:var(--primary-light);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:var(--primary);">${annual}</div>
        <div style="font-size:12px;color:var(--text-secondary);">מכסה שנתית</div>
      </div>
      <div style="background:#dcfce7;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:var(--success);">${stats.total}</div>
        <div style="font-size:12px;color:var(--text-secondary);">ימים שנוצלו</div>
      </div>
      <div style="background:#fef9c3;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#ca8a04;">${stats.wfh}</div>
        <div style="font-size:12px;color:var(--text-secondary);">ימי WFH</div>
      </div>
      <div style="background:${balance < 0 ? 'var(--danger-light)' : 'var(--success-light)'};border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:${balance < 0 ? 'var(--danger)' : 'var(--success)'};">${balance.toFixed(2)}</div>
        <div style="font-size:12px;color:var(--text-secondary);">יתרה נוכחית</div>
      </div>
    </div>
    
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>חודש</th>
            <th>ימים מלאים</th>
            <th>חצאי ימים</th>
            <th>WFH</th>
            <th>סה"כ ניצול</th>
            <th>מחזור תשלום</th>
          </tr>
        </thead>
        <tbody>
          ${byMonth.map((m, i) => {
            const total = m.full + m.half * 0.5;
            const payMonth = i >= 10 ? (i === 10 ? 0 : 1) : i + 1;
            return `<tr>
              <td style="font-weight:700;">${monthNames[i]}</td>
              <td>${m.full || '-'}</td>
              <td>${m.half || '-'}</td>
              <td>${m.wfh || '-'}</td>
              <td style="font-weight:700;color:${total > 0 ? 'var(--primary)' : 'var(--text-muted)'};">${total || '-'}</td>
              <td style="font-size:12px;color:var(--text-muted);">${total > 0 ? monthNames[payMonth] : '-'}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr style="background:var(--surface2);font-weight:700;">
            <td>סה"כ</td>
            <td>${stats.full}</td>
            <td>${stats.half}</td>
            <td>${stats.wfh}</td>
            <td colspan="2" style="color:var(--primary);">${stats.total} ימי חופשה</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function exportPersonalReport() {
  const year = parseInt(document.getElementById('reportYearSelect')?.value || calState.year);
  const vacs = getVacations(currentUser.username);
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  let csv = '\uFEFF'; // BOM for Hebrew
  csv += 'שם עובד,מחלקה,תאריך,חודש,סוג יום,מחזור תשלום\n';
  
  const sortedVacs = Object.entries(vacs)
    .filter(([dt]) => dt.startsWith(String(year)))
    .sort(([a],[b]) => a.localeCompare(b));
  
  sortedVacs.forEach(([dt, type]) => {
    const d = new Date(dt);
    const m = d.getMonth();
    const dayNum = d.getDate();
    const payMonth = dayNum >= 21 ? monthNames[(m + 1) % 12] : monthNames[(m + 0) % 12];
    const typeLabel = type === 'full' ? 'יום מלא' : type === 'half' ? 'חצי יום' : 'WFH';
    csv += `${currentUser.fullName},${currentUser.dept},${dt},${monthNames[m]},${typeLabel},${payMonth}\n`;
  });
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `חופשות_${currentUser.fullName}_${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📊 הקובץ הורד בהצלחה', 'success');
}

function exportAllToCSV() {
  const db = getDB();
  const year = parseInt(document.getElementById('adminFilterYear').value);
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  let csv = '\uFEFF';
  csv += 'שם עובד,שם משתמש,מחלקה,תאריך,חודש,סוג יום,מכסה שנתית,נוצל,יתרה\n';
  
  for (const [uname, user] of Object.entries(db.users)) {
    const vacs = getVacations(uname);
    const cb2 = calcBalance(uname, year);
    const quota = cb2.quota;
    const stats = cb2.stats;
    const balance = cb2.balance.toFixed(1);
    
    const sortedVacs = Object.entries(vacs)
      .filter(([dt]) => dt.startsWith(String(year)))
      .sort(([a],[b]) => a.localeCompare(b));
    
    if (sortedVacs.length === 0) {
      csv += `${user.fullName},${uname},${user.dept},,,,${quota.annual},${stats.total},${balance}\n`;
    } else {
      sortedVacs.forEach(([dt, type]) => {
        const d = new Date(dt);
        const m = d.getMonth();
        const typeLabel = type === 'full' ? 'יום מלא' : type === 'half' ? 'חצי יום' : 'WFH';
        csv += `${user.fullName},${uname},${user.dept},${dt},${monthNames[m]},${typeLabel},${quota.annual},${stats.total},${balance}\n`;
      });
    }
  }
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `כל_החופשות_${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📊 הייצוא הסתיים בהצלחה', 'success');
}


// ============================================================
// AI FORECAST — עומסי חופשה
// ============================================================
function renderAIForecast() {
  const db = getDB();
  const year = new Date().getFullYear();
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  // Scope to manager's dept — admin sees all
  const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'accountant');
  const employees = Object.values(db.users).filter(u => {
    if (u.role === 'admin' || u.role === 'accountant') return false;
    if (!isUserActive(u)) return false;
    if (isAdmin) return true;
    return managerManagesUser(currentUser.username, u, db);
  });
  const totalEmp = Math.max(employees.length, 1);

  // Build week-by-week map: weekKey → count of vacation days
  const weekMap = {}; // 'YYYY-WW' → { count, names }
  const monthMap = new Array(12).fill(0); // month index → total days
  const deptMonthMap = {}; // dept → [12 months]

  employees.forEach(user => {
    const dept = getUserDept(user) || 'כללי';
    if (!deptMonthMap[dept]) deptMonthMap[dept] = new Array(12).fill(0);

    Object.entries(db.vacations[user.username] || {}).forEach(([dt, type]) => {
      if (!dt.startsWith(String(year))) return;
      if (type === 'wfh') return;
      const val = type === 'half' ? 0.5 : 1;
      const d = new Date(dt + 'T00:00:00');
      const week = getWeekNumber(d);
      const wk = `${year}-W${String(week).padStart(2,'0')}`;
      if (!weekMap[wk]) weekMap[wk] = { count: 0, names: [], weekStart: getWeekStart(d) };
      weekMap[wk].count += val;
      if (!weekMap[wk].names.includes(user.fullName)) weekMap[wk].names.push(user.fullName);
      monthMap[d.getMonth()] += val;
      deptMonthMap[dept][d.getMonth()] += val;
    });
  });

  // --- AI ALERTS ---
  const alerts = [];
  const CAPACITY_WARN = Math.ceil(totalEmp * 0.4); // 40% of team = warning
  const CAPACITY_CRIT = Math.ceil(totalEmp * 0.6); // 60% = critical

  // Peak weeks
  const sortedWeeks = Object.entries(weekMap).sort((a,b) => b[1].count - a[1].count);
  sortedWeeks.slice(0, 3).forEach(([wk, data]) => {
    const pct = Math.round(data.count / totalEmp * 100);
    if (pct >= 40) {
      const level = pct >= 60 ? 'critical' : 'warning';
      const weekLabel = data.weekStart ? formatDateHe(data.weekStart) : wk;
      alerts.push({
        level,
        icon: pct >= 60 ? '🔴' : '🟡',
        text: `שבוע ${weekLabel} — ${data.count} עובדים בחופשה (${pct}% מהצוות)`,
        sub: data.names.slice(0,5).join(', ') + (data.names.length > 5 ? `...+${data.names.length-5}` : '')
      });
    }
  });

  // Peak months
  const peakMonthIdx = monthMap.indexOf(Math.max(...monthMap));
  if (monthMap[peakMonthIdx] > 0) {
    const pct = Math.round(monthMap[peakMonthIdx] / totalEmp * 100);
    if (pct >= 30) {
      alerts.push({
        level: 'info',
        icon: '📈',
        text: `${MONTHS[peakMonthIdx]} — חודש השיא: ${monthMap[peakMonthIdx].toFixed(0)} ימי חופשה (${pct}% מהצוות)`,
        sub: 'שקול לתכנן מראש כיסוי תפקידים'
      });
    }
  }

  // Under-vacation alert
  const noVacEmp = employees.filter(u => {
    const total = Object.entries(db.vacations[u.username]||{})
      .filter(([dt,t]) => dt.startsWith(String(year)) && t !== 'wfh')
      .reduce((s,[,t]) => s+(t==='half'?0.5:1), 0);
    return total === 0;
  });
  if (noVacEmp.length > 0) {
    alerts.push({
      level: 'info',
      icon: '😰',
      text: `${noVacEmp.length} עובדים טרם לקחו חופשה השנה`,
      sub: noVacEmp.slice(0,3).map(u=>u.fullName).join(', ') + (noVacEmp.length>3?`...+${noVacEmp.length-3}`:'') + ' — סיכון burn-out'
    });
  }

  // Unused days end-of-year
  const totalUnused = employees.reduce((sum, u) => {
    const cb = calcBalance(u.username, year);
    return sum + Math.max(0, cb.projectedEndBalance);
  }, 0);
  if (totalUnused > 10) {
    alerts.push({
      level: 'warning',
      icon: '💰',
      text: `${totalUnused.toFixed(0)} ימי חופשה צבורים צפויים לסוף ${year}`,
      sub: 'חבות כספית לחברה — מומלץ לעודד ניצול'
    });
  }

  const alertColors = {
    critical: { bg:'#fef2f2', border:'#fca5a5', text:'#7f1d1d' },
    warning:  { bg:'#fefce8', border:'#fde047', text:'#713f12' },
    info:     { bg:'var(--primary-light)', border:'var(--primary)', text:'var(--primary-dark)' }
  };

  const alertsEl = document.getElementById('aiAlerts');
  if (alertsEl) {
    if (!alerts.length) {
      alertsEl.innerHTML = '<div style="color:var(--success);font-size:14px;padding:8px 0;">✅ אין התראות — עומסי החופשה מאוזנים</div>';
    } else {
      alertsEl.innerHTML = alerts.map(a => {
        const c = alertColors[a.level];
        return `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;padding:12px 16px;margin-bottom:8px;">
          <div style="font-weight:700;font-size:14px;color:${c.text};">${a.icon} ${a.text}</div>
          ${a.sub ? `<div style="font-size:12px;color:${c.text};opacity:0.8;margin-top:3px;">${a.sub}</div>` : ''}
        </div>`;
      }).join('');
    }
  }

  // --- YEAR HEATMAP ---
  const heatmapEl = document.getElementById('yearHeatmap');
  const heatYearEl = document.getElementById('heatmapYear');
  if (heatYearEl) heatYearEl.textContent = year;

  if (heatmapEl) {
    // Build 52-week grid
    const maxCount = Math.max(1, ...Object.values(weekMap).map(w => w.count));
    let html = '<div style="display:flex;gap:3px;align-items:flex-start;">';

    // Month labels row
    const monthStarts = {};
    for (let m = 0; m < 12; m++) {
      const d = new Date(year, m, 1);
      const wk = getWeekNumber(d);
      monthStarts[wk] = MONTHS[m];
    }

    // Weeks grid
    html += '<div>';
    // Day labels
    html += '<div style="display:flex;flex-direction:column;gap:2px;margin-top:20px;margin-left:4px;">';
    ['א','ב','ג','ד','ה'].forEach(d => {
      html += `<div style="font-size:9px;color:var(--text-muted);height:12px;line-height:12px;">${d}</div>`;
    });
    html += '</div></div>';

    for (let w = 1; w <= 52; w++) {
      const wk = `${year}-W${String(w).padStart(2,'0')}`;
      const data = weekMap[wk] || { count: 0, names: [] };
      const intensity = data.count / maxCount;
      const color = getHeatColor(intensity);
      const monthLabel = monthStarts[w] || '';

      html += `<div style="display:flex;flex-direction:column;gap:2px;">
        <div style="font-size:9px;color:var(--text-muted);height:16px;white-space:nowrap;overflow:visible;">${monthLabel}</div>`;

      // 5 work days
      for (let d = 0; d < 5; d++) {
        const title = data.count > 0 ? `שבוע ${w}: ${data.count} ימים — ${data.names.slice(0,3).join(', ')}` : `שבוע ${w}: אין חופשות`;
        html += `<div title="${title}" style="width:12px;height:12px;border-radius:2px;background:${color};cursor:pointer;"></div>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // Legend
    html += `<div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--text-muted);">
      <span>פחות</span>
      ${[0,0.25,0.5,0.75,1].map(v=>`<div style="width:12px;height:12px;border-radius:2px;background:${getHeatColor(v)};"></div>`).join('')}
      <span>יותר</span>
    </div>`;

    heatmapEl.innerHTML = html;
  }

  // --- DEPT × MONTH BAR CHART ---
  const chartEl = document.getElementById('deptMonthChart');
  if (chartEl) {
    const depts = Object.keys(deptMonthMap).slice(0, 6); // max 6 depts
    if (!depts.length) { chartEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">אין נתונים</p>'; return; }

    const deptColors = ['#1a56e8','#16a34a','#7c3aed','#0891b2','#dc2626','#d97706'];
    const maxVal = Math.max(1, ...depts.flatMap(d => deptMonthMap[d]));

    let html = '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:11px;min-width:600px;">';
    // Header
    html += '<tr><th style="padding:4px 8px;text-align:right;width:80px;"></th>';
    MONTHS.forEach(m => { html += `<th style="padding:4px 6px;color:var(--text-secondary);font-weight:600;text-align:center;">${m.slice(0,3)}</th>`; });
    html += '</tr>';

    depts.forEach((dept, di) => {
      const color = deptColors[di % deptColors.length];
      html += `<tr><td style="padding:6px 8px;font-weight:600;color:${color};white-space:nowrap;">${dept}</td>`;
      deptMonthMap[dept].forEach(val => {
        const h = val > 0 ? Math.max(4, Math.round(val / maxVal * 40)) : 0;
        const pct = val > 0 ? val.toFixed(0) : '';
        html += `<td style="padding:4px 6px;text-align:center;vertical-align:bottom;">
          ${h > 0 ? `<div title="${val} ימים" style="height:${h}px;background:${color};border-radius:2px 2px 0 0;margin:0 auto;width:14px;opacity:0.85;"></div>` : ''}
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${pct}</div>
        </td>`;
      });
      html += '</tr>';
    });
    html += '</table></div>';

    // Legend
    html += '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;">';
    depts.forEach((d, i) => {
      html += `<span style="display:flex;align-items:center;gap:4px;font-size:11px;">
        <span style="width:10px;height:10px;border-radius:2px;background:${deptColors[i % deptColors.length]};display:inline-block;"></span>${d}
      </span>`;
    });
    html += '</div>';

    chartEl.innerHTML = html;
  }
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  return Math.ceil((((date - yearStart) / 86400000) + 1)/7);
}

function getWeekStart(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

function formatDateHe(d) {
  const MONTHS = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function getHeatColor(intensity) {
  if (intensity <= 0)    return '#eef2f7';
  if (intensity < 0.25)  return '#bfdbfe';
  if (intensity < 0.5)   return '#60a5fa';
  if (intensity < 0.75)  return '#2563eb';
  return '#1e3a8a';
}

// ============================================================
// ============================================================


function previewCompanyName(val) {
  // Live preview in header as user types
  const nameEl = document.getElementById('companyNameDisplay');
  if(!nameEl) return;
  if(val && val.trim()) {
    nameEl.textContent = val.trim();
    nameEl.style.display = '';
  } else {
    nameEl.style.display = 'none';
  }
}

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    // Compress image via canvas before saving
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const MAX = 400;
      let w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const base64 = canvas.toDataURL('image/jpeg', 0.8);
      document.getElementById('settingCompanyLogo').value = base64;
      const preview = document.getElementById('logoPreview');
      if (preview) { preview.src = base64; preview.style.display = ''; }
      const logoEl = document.getElementById('companyLogoDisplay');
      const iconEl = document.getElementById('brandIcon');
      if (logoEl) { logoEl.src = base64; logoEl.style.display = ''; }
      if (iconEl) iconEl.style.display = 'none';
      // Also update module selector logo
      const mLogoImg  = document.getElementById('moduleLogoImg');
      const mLogoIcon = document.getElementById('moduleBrandIcon');
      if (mLogoImg)  { mLogoImg.src = base64; mLogoImg.style.display = ''; }
      if (mLogoIcon) mLogoIcon.style.display = 'none';
      showToast('✅ לוגו הועלה — לחץ "שמור הגדרות" לשמירה', 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearLogo() {
  document.getElementById('settingCompanyLogo').value = '';
  const preview = document.getElementById('logoPreview');
  if(preview) { preview.src=''; preview.style.display='none'; }
  const logoEl = document.getElementById('companyLogoDisplay');
  const iconEl = document.getElementById('brandIcon');
  if(logoEl) logoEl.style.display = 'none';
  if(iconEl) iconEl.style.display = '';
  if(document.getElementById('logoFileInput')) document.getElementById('logoFileInput').value = '';
  showToast('🗑️ לוגו הוסר', 'warning');
}

function loadCompanySettings() {
  const s = getSettings();
  const set = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
  set('settingCompanyName',      s.companyName);
  set('settingCompanyLogo',      s.companyLogo);
  set('settingCycleStart',       s.cycleStartDay);
  set('settingCycleEnd',         s.cycleEndDay);
  set('settingDropMonth',        s.dropMonth);
  set('settingPayrollFormat',    s.payrollFormat);
  set('settingApprovalRequired', String(s.approvalRequired));
  set('settingApprovalTimeout',  s.approvalTimeoutHours);
  // Show logo preview in settings panel
  const preview = document.getElementById('logoPreview');
  if(preview && s.companyLogo) { preview.src = s.companyLogo; preview.style.display = ''; }
  updateCyclePreview();
  applyBranding(s);
}

function applyBranding(s) {
  if(!s) s = getSettings();

  // Company name — show under branding
  const nameEl = document.getElementById('companyNameDisplay');
  if(nameEl) {
    if(s.companyName && s.companyName !== 'החברה שלי') {
      nameEl.textContent = s.companyName;
      nameEl.style.display = '';
    } else {
      nameEl.style.display = 'none';
    }
  }

  // Logo — replace the emoji icon with the logo image
  const logoEl   = document.getElementById('companyLogoDisplay');
  const iconEl   = document.getElementById('brandIcon');
  if(logoEl && iconEl) {
    if(s.companyLogo) {
      logoEl.src = s.companyLogo;
      logoEl.style.display = '';
      iconEl.style.display = 'none';
    } else {
      logoEl.style.display = 'none';
      iconEl.style.display = '';
    }
  }
}

function saveCompanySettings() {
  const get = id => document.getElementById(id)?.value;
  const s = {
    companyName:          get('settingCompanyName') || 'החברה שלי',
    companyLogo:          get('settingCompanyLogo') || '',
    cycleStartDay:        parseInt(get('settingCycleStart')) || 1,
    cycleEndDay:          parseInt(get('settingCycleEnd')) || 0,
    dropMonth:            get('settingDropMonth') || 'next',
    payrollFormat:        get('settingPayrollFormat') || 'csv_generic',
    approvalRequired:     get('settingApprovalRequired') === 'true',
    approvalTimeoutHours: parseInt(get('settingApprovalTimeout')) || 48,
    authLevel:            parseInt(document.querySelector('input[name="authLevel"]:checked')?.value || getSettings().authLevel || 4),
  };
  saveSettings(s);
  applyBranding(s);
  auditLog('settings_changed', 'הגדרות חברה עודכנו');
  showToast('✅ הגדרות נשמרו — הכותרת עודכנה', 'success');
  updateCyclePreview();
}

function updateCyclePreview() {
  const el = document.getElementById('cyclePreview');
  if(!el) return;
  const start = parseInt(document.getElementById('settingCycleStart')?.value) || 1;
  const drop  = document.getElementById('settingDropMonth')?.value || 'next';
  const dropLabel = drop === 'next' ? 'החודש שלאחר מכן' : 'אותו חודש';
  if(start === 1) {
    el.innerHTML = `📅 <strong>דוגמה:</strong> חופשה ב-15/03 → תרד מהשכר ב${drop==='next'?'אפריל':'מרץ'}`;
  } else {
    const exEnd = start - 1;
    el.innerHTML = `📅 <strong>דוגמה:</strong> חופשה ב-25/02 (בטווח ${start}/02–${exEnd}/03) → תרד מהשכר ב${drop==='next'?'אפריל':'מרץ'}`;
  }
}

// ============================================================
// MANAGER DASHBOARD
// ============================================================
function renderManagerDashboard() {
  if(!isUserDeptManager(currentUser.username) && currentUser.role !== 'admin' && currentUser.role !== 'manager') return;
  const db = getDB();
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'accountant';

  // Build scoped user list — admin sees all, dept manager sees only their dept
  const scopedUsers = Object.values(db.users).filter(u => {
    if (isAdmin) return true;
    return managerManagesUser(currentUser.username, u, db);
  });

  const todayEl = document.getElementById('managerTodayDate');
  if(todayEl) todayEl.textContent = `${now.getDate()} ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  // Render handover protocols for this manager
  renderHandoverList();

  // TODAY STATS
  const todayVacations = [], todayWFH = [];
  scopedUsers.forEach(user => {
    const vacs = db.vacations[user.username] || {};
    if(['full','half'].includes(vacs[todayStr])) todayVacations.push(user.fullName);
    if(vacs[todayStr] === 'wfh') todayWFH.push(user.fullName);
  });
  const totalEmployees = scopedUsers.filter(u => u.role === 'employee' || isUserDeptManager(u.username)).length;
  const myUsername = currentUser.username;
  // Manager sees only requests assigned to them (or all if admin)
  const allPending = (db.approvalRequests || []).filter(r => r.status === 'pending');
  const myPending  = isAdmin ? allPending : allPending.filter(r => r.assignedManager === myUsername);
  const pending = myPending.length;

  const cardsEl = document.getElementById('managerTodayCards');
  if(cardsEl) cardsEl.innerHTML = [
    { icon:'😎', val:todayVacations.length, label:'בחופשה היום',   color:'var(--primary)', bg:'var(--primary-light)', names:todayVacations },
    { icon:'🏠', val:todayWFH.length,       label:'עובדים מהבית',  color:'#7c3aed',        bg:'#f3e8ff',             names:todayWFH },
    { icon:'👥', val:totalEmployees,         label:'סה"כ עובדים',  color:'var(--success)', bg:'var(--success-light)',names:[] },
    { icon:'⏳', val:pending,               label:'בקשות ממתינות', color:'var(--danger)',  bg:'var(--danger-light)', names:[] }
  ].map(c=>`
    <div style="background:${c.bg};border-radius:12px;padding:16px;text-align:center;" title="${c.names.join(', ')}">
      <div style="font-size:30px;font-weight:900;color:${c.color};">${c.val}</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">${c.icon} ${c.label}</div>
      ${c.names.length?`<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">${c.names.slice(0,3).join(', ')}${c.names.length>3?'…':''}</div>`:''}
    </div>`).join('');

  // PENDING APPROVALS
  const pendingReqs = isAdmin
    ? (db.approvalRequests||[]).filter(r=>r.status==='pending')
    : (db.approvalRequests||[]).filter(r=>r.status==='pending' && r.assignedManager===myUsername);
  const badge = document.getElementById('pendingBadge');
  if(badge) badge.textContent = pendingReqs.length || '';
  const pendingEl = document.getElementById('managerPendingList');
  if(pendingEl) {
    if(!pendingReqs.length) {
      pendingEl.innerHTML = '<p style="color:var(--text-muted);font-size:14px;padding:8px 0;">אין בקשות ממתינות ✅</p>';
    } else {
      const timeout = getSettings().approvalTimeoutHours || 48;
      pendingEl.innerHTML = pendingReqs.map(req => {
        const hrs = Math.round((Date.now()-new Date(req.createdAt))/3600000);
        const urgent = hrs >= timeout;
        return `<div style="background:${urgent?'#fef2f2':'var(--surface2)'};border:1px solid ${urgent?'#fca5a5':'var(--border)'};border-radius:10px;padding:14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:700;font-size:14px;">${req.fullName} ${urgent?`<span style="color:var(--danger);font-size:12px;">⚠️ ממתין ${hrs} שעות</span>`:''}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${req.dateRange||''} • ${req.dept||''} • ${req.days||0} ימים</div>
            ${isAdmin && req.assignedManager ? `<div style="font-size:11px;color:var(--text-muted);">מיועד ל: ${db.users[req.assignedManager]?.fullName||req.assignedManager}</div>` : ''}
            <div style="font-size:11px;color:var(--text-muted);">הוגש: ${new Date(req.createdAt).toLocaleDateString('he-IL')}</div>
            ${req.note?`<div style="font-size:12px;color:var(--primary);margin-top:4px;">💬 "${req.note}"</div>`:''}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-success" style="font-size:13px;" onclick="approveRequest('${req.id}')">✅ אשר</button>
            <button class="btn" style="font-size:13px;background:var(--danger-light);color:var(--danger);border:1px solid #fca5a5;" onclick="rejectRequestPrompt('${req.id}')">❌ דחה</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  // UPCOMING VACATIONS (team, next 30 days)
  const upcomingEl = document.getElementById('managerUpcomingList');
  if(upcomingEl) {
    const in30 = new Date(now.getTime()+30*86400000).toISOString().slice(0,10);
    const upcoming = [];
    scopedUsers.forEach(user => {
      Object.entries(db.vacations[user.username]||{}).forEach(([dt,type]) => {
        if(dt>=todayStr && dt<=in30) upcoming.push({name:user.fullName,dept:getUserDept(user),date:dt,type});
      });
    });
    upcoming.sort((a,b)=>a.date.localeCompare(b.date));
    if(!upcoming.length) {
      upcomingEl.innerHTML='<p style="color:var(--text-muted);font-size:14px;">אין חופשות מתוכננות ב-30 הימים הקרובים</p>';
    } else {
      const grouped={};
      upcoming.forEach(u=>{if(!grouped[u.date])grouped[u.date]=[];grouped[u.date].push(u);});
      upcomingEl.innerHTML=Object.entries(grouped).map(([dt,items])=>{
        const d=new Date(dt+'T00:00:00');
        return `<div style="margin-bottom:10px;">
          <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:4px;">${d.getDate()} ${monthNames[d.getMonth()]}</div>
          ${items.map(i=>`<span style="display:inline-block;background:${i.type==='wfh'?'#f3e8ff':'var(--primary-light)'};color:${i.type==='wfh'?'#7c3aed':'var(--primary-dark)'};border-radius:20px;padding:3px 10px;font-size:12px;margin:2px;">${i.name}${i.type==='wfh'?' 🏠':i.type==='half'?' (חצי)':''}</span>`).join('')}
        </div>`;
      }).join('');
    }
  }

  // OVERLAP WARNINGS
  const overlaps = findOverlaps(db, todayStr);
  const overlapSection = document.getElementById('overlapSection');
  if(overlapSection) overlapSection.style.display = overlaps.length?'':'none';
  const overlapEl = document.getElementById('overlapList');
  if(overlapEl && overlaps.length) {
    overlapEl.innerHTML = overlaps.map(o=>`
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:13px;">
        ⚠️ <strong>${o.date}</strong> — מחלקת ${o.dept}: <strong>${o.names.join(' ו-')}</strong> שניהם בחופשה
      </div>`).join('');
  }

  // TEAM BALANCE TABLE
  const teamEl = document.getElementById('managerTeamBalance');
  if(teamEl) {
    const year = now.getFullYear();
    const rows = scopedUsers.filter(u=>u.role==='employee'||isUserDeptManager(u.username)).map(u=>{
      const cb = calcBalance(u.username, year);
      const pct = Math.min(100, cb.stats.total/Math.max(1,cb.annual)*100);
      const color = cb.projectedEndBalance<0?'var(--danger)':cb.projectedEndBalance<3?'var(--warning)':'var(--success)';
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px;font-weight:600;">${u.fullName}</td>
        <td style="padding:10px;text-align:center;font-size:13px;">${getUserDept(u)||'-'}</td>
        <td style="padding:10px;text-align:center;">${cb.annual}</td>
        <td style="padding:10px;text-align:center;">${cb.stats.total}</td>
        <td style="padding:10px;min-width:100px;">
          <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:var(--primary);border-radius:4px;transition:width 0.5s;"></div>
          </div>
        </td>
        <td style="padding:10px;text-align:center;font-weight:700;color:${color};">${cb.balance.toFixed(1)}</td>
        <td style="padding:10px;text-align:center;font-size:12px;color:var(--text-muted);">${cb.projectedEndBalance.toFixed(1)}</td>
      </tr>`;
    }).join('');
    teamEl.innerHTML = rows ? `
      <div class="table-wrapper"><table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:var(--surface2);">
          <th style="padding:10px;text-align:right;">עובד</th>
          <th style="padding:10px;">מחלקה</th>
          <th style="padding:10px;">מכסה</th>
          <th style="padding:10px;">נוצל</th>
          <th style="padding:10px;min-width:100px;">%</th>
          <th style="padding:10px;">יתרה</th>
          <th style="padding:10px;font-size:11px;">צפי סוף שנה</th>
        </tr></thead><tbody>${rows}</tbody>
      </table></div>` : '<p style="color:var(--text-muted);font-size:14px;">אין עובדים</p>';
  }

  renderAuditLog();
  renderAIForecast();
  renderAIStaffingForecast();
  renderEmployeeScores();
}

function findOverlaps(db, todayStr) {
  const in30 = new Date(Date.now()+30*86400000).toISOString().slice(0,10);
  const byDateDept = {};
  Object.values(db.users).forEach(user => {
    const dept = getUserDept(user)||'כללי';
    Object.entries(db.vacations[user.username]||{}).forEach(([dt,type])=>{
      if(dt>=todayStr && dt<=in30 && type!=='wfh') {
        const key=dt+'|'+dept;
        if(!byDateDept[key]) byDateDept[key]={date:dt,dept,names:[]};
        byDateDept[key].names.push(user.fullName);
      }
    });
  });
  return Object.values(byDateDept).filter(v=>v.names.length>=2).sort((a,b)=>a.date.localeCompare(b.date));
}

function renderAuditLog() {
  const el = document.getElementById('auditLogList');
  if(!el) return;
  const log = (getDB().auditLog||[]).slice(0,50);
  if(!log.length){el.innerHTML='<p style="color:var(--text-muted);font-size:13px;">אין רשומות</p>';return;}
  const icons={login:'🔑',logout:'👋',vacation_add:'✈️',vacation_remove:'❌',approval_approved:'✅',approval_rejected:'❌',settings_changed:'⚙️',quota_saved:'📊',employee_added:'👤',employee_deleted:'🗑️',payroll_export:'📤',monthly_report:'📄',vacation_request:'📨'};
  el.innerHTML=log.map(e=>{
    const d=new Date(e.ts);
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border);">
      <span>${icons[e.action]||'📝'}</span>
      <div style="flex:1;font-size:13px;"><strong>${e.user}</strong> <span style="color:var(--text-secondary);">${e.details||e.action}</span></div>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${d.toLocaleString('he-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
    </div>`;
  }).join('');
}

// ============================================================
// PAYROLL EXPORT
// ============================================================
function exportPayroll() {
  const db = getDB();
  const s = getSettings();
  const now = new Date();
  const year = now.getFullYear();
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const prevMonth = now.getMonth()===0?12:now.getMonth();
  const prevYear  = now.getMonth()===0?year-1:year;

  const rows=[];
  Object.values(db.users).filter(u=>u.role==='employee').forEach(user=>{
    let fullDays=0,halfDays=0;
    Object.entries(db.vacations[user.username]||{}).forEach(([dt,type])=>{
      const pm=getPayrollMonth(dt,s);
      if(pm.month===prevMonth&&pm.year===prevYear){
        if(type==='full')fullDays++;
        else if(type==='half')halfDays++;
      }
    });
    if(fullDays+halfDays>0) rows.push({id:user.username,name:user.fullName,dept:getUserDept(user)||'',fullDays,halfDays,total:fullDays+halfDays*0.5});
  });

  let csv='';
  const fmt=s.payrollFormat;
  if(fmt==='priority'){
    csv='employee_id,employee_name,absence_code,days\n';
    rows.forEach(r=>{
      if(r.fullDays) csv+=`${r.id},${r.name},HOL,${r.fullDays}\n`;
      if(r.halfDays) csv+=`${r.id},${r.name},HOL_HALF,${r.halfDays}\n`;
    });
  } else if(fmt==='hilan'){
    csv='מ.אישי,שם,קוד נוכחות,כמות\n';
    rows.forEach(r=>{
      if(r.fullDays) csv+=`${r.id},${r.name},310,${r.fullDays}\n`;
      if(r.halfDays) csv+=`${r.id},${r.name},311,${r.halfDays}\n`;
    });
  } else if(fmt==='hashav'){
    csv='מ.עובד,שם עובד,מחלקה,ימי חופשה מלאים,חצאי ימים,סה"כ\n';
    rows.forEach(r=>csv+=`${r.id},${r.name},${r.dept},${r.fullDays},${r.halfDays},${r.total}\n`);
  } else {
    csv='ID,שם,מחלקה,ימים מלאים,חצאי ימים,סה"כ\n';
    rows.forEach(r=>csv+=`${r.id},${r.name},${r.dept},${r.fullDays},${r.halfDays},${r.total}\n`);
  }

  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download=`payroll_${fmt}_${prevYear}_${String(prevMonth).padStart(2,'0')}.csv`;
  a.click();URL.revokeObjectURL(url);
  auditLog('payroll_export',`ייצוא שכר ${monthNames[prevMonth-1]} ${prevYear} — פורמט: ${fmt}`);
  showToast(`📤 קובץ שכר יוצא — ${monthNames[prevMonth-1]} ${prevYear}`,'success');
}

function exportMonthlyReport() {
  const db=getDB();
  const now=new Date();
  const month=now.getMonth()+1,year=now.getFullYear();
  const monthNames=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  let csv=`דוח חופשות — ${monthNames[month-1]} ${year}\n\n`;
  csv+='שם עובד,מחלקה,מכסה שנתית,ניצל,יתרה נוכחית,צפי סוף שנה\n';
  Object.values(db.users).filter(u=>u.role==='employee').forEach(user=>{
    const cb=calcBalance(user.username,year);
    csv+=`${user.fullName},${getUserDept(user)||''},${cb.annual},${cb.stats.total},${cb.balance.toFixed(1)},${cb.projectedEndBalance.toFixed(1)}\n`;
  });
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download=`monthly_report_${year}_${String(month).padStart(2,'0')}.csv`;
  a.click();URL.revokeObjectURL(url);
  auditLog('monthly_report',`דוח חודשי ${monthNames[month-1]} ${year}`);
  showToast('📄 דוח חודשי יוצא','success');
}

// ============================================================
// APPROVAL WORKFLOW
// ============================================================
function approveRequest(reqId) {
  const db=getDB();
  const req=(db.approvalRequests||[]).find(r=>r.id===reqId);
  if(!req)return;
  req.status='approved';
  req.approvedBy=currentUser.username;
  req.approvedAt=new Date().toISOString();
  if(!db.vacations[req.username])db.vacations[req.username]={};
  (req.dates||[]).forEach(dt=>{db.vacations[req.username][dt]=req.type||'full';});

  // ── סמן שנדרש פרוטוקול העברת מקל לעובד זה ──
  if (!db.handoverPending) db.handoverPending = {};
  db.handoverPending[req.username] = {
    reqId,
    dates: req.dates || [],
    firstDate: (req.dates||[]).slice().sort()[0] || '',
    managerUsername: currentUser.username,
    approvedAt: new Date().toISOString(),
    popupShown: false   // האם הפופאפ כבר הוצג לעובד
  };

  saveDB(db);
  auditLog('approval_approved',`אושרה בקשת ${req.fullName} — ${req.dates?.length||0} ימים`);
  showToast(`✅ בקשת ${req.fullName} אושרה`,'success');
  renderManagerDashboard();
  updateApprovalStatusBadge();
}

function rejectRequestPrompt(reqId) {
  const reason=prompt('סיבת הדחייה (אופציונלי):');
  if(reason===null)return;
  const db=getDB();
  const req=(db.approvalRequests||[]).find(r=>r.id===reqId);
  if(!req)return;
  req.status='rejected';req.rejectedBy=currentUser.username;
  req.rejectedAt=new Date().toISOString();req.rejectReason=reason;
  saveDB(db);
  auditLog('approval_rejected',`נדחתה בקשת ${req.fullName}${reason?' — '+reason:''}`);
  showToast(`❌ בקשת ${req.fullName} נדחתה`,'warning');
  renderManagerDashboard();
  updateApprovalStatusBadge();
}

// ============================================================
// ADMIN
// ============================================================
function renderAdmin() {
  if (currentUser.role !== 'admin' && currentUser.role !== 'accountant' && !userHasAnyAdminAccess(currentUser.username)) return;
  renderTCTodayPreview();
  renderPendingRegistrations();
  applyPermissionsToAdminTab();
  if (currentUser.role === 'admin') { renderPermissionsTable(); }
  populateQuickPermUser();
  // Load temp password field
  const tp = document.getElementById('tempPasswordSetting');
  if (tp) tp.value = getSettings().tempPassword || '';
  
  const db = getDB();
  
  // Quota window check
  const now = new Date();
  const isQuotaWindow = now.getMonth() === 0 && now.getDate() <= 9;
  const quotaMsg = document.getElementById('quotaWindowMsg');
  const quotaAlert = document.getElementById('quotaWindowAlert');
  if (currentUser.role === 'accountant') {
    quotaMsg.textContent = `✅ כמנהלת חשבונות, ניתן לטעון מכסות בכל עת.`;
    quotaAlert.className = 'alert alert-success';
  } else if (isQuotaWindow) {
    quotaMsg.textContent = `✅ חלון הטעינה פתוח עד 09 לינואר ${now.getFullYear()}. ניתן לטעון מכסות!`;
    quotaAlert.className = 'alert alert-success';
  } else {
    quotaMsg.textContent = `🔒 חלון הטעינה סגור. ניתן לטעון מכסות רק בין 01-09 לינואר.`;
    quotaAlert.className = 'alert alert-warning';
  }

  // Render departments + managers table
  renderDeptManagerTable();
  
  // Populate quota employee select
  const quotaEmpSel = document.getElementById('quotaEmpSelect');
  quotaEmpSel.innerHTML = Object.values(db.users).map(u => `<option value="${u.username}">${u.fullName} (${u.dept})</option>`).join('');
  
  // Populate employee selector
  const empSel = document.getElementById('empListSelect');
  if (empSel) {
    const sortedUsers = Object.values(db.users).sort((a,b) => a.fullName.localeCompare(b.fullName, 'he'));
    empSel.innerHTML = '<option value="">— בחר עובד לעריכה —</option>' +
      sortedUsers.map(u => `<option value="${u.username}">${u.fullName} · ${u.dept||''}</option>`).join('');
    const countEl = document.getElementById('empListCount');
    if (countEl) countEl.textContent = `${sortedUsers.length} עובדים`;
  }
  // Hide edit row on re-render
  const editRow = document.getElementById('empListEditRow');
  if (editRow) editRow.style.display = 'none';
  
  // Admin filter selects
  const filterEmpSel = document.getElementById('adminFilterEmp');
  filterEmpSel.innerHTML = '<option value="">כל העובדים</option>' + 
    Object.values(db.users).map(u => `<option value="${u.username}">${u.fullName}</option>`).join('');

  // Department filter
  const filterDeptSel = document.getElementById('adminFilterDept');
  const allDepts = db.departments || [];
  filterDeptSel.innerHTML = '<option value="">כל המחלקות</option>' + 
    allDepts.map(d => `<option value="${d}">${d}</option>`).join('');
  
  renderAdminVacations();
  renderApprovalRequests();
  renderCustomQAList();
}

function saveEmpSalary(username, val) {
  const db = getDB();
  if (!db.users[username]) return;
  db.users[username].dailySalary = parseFloat(val) || 0;
  saveDB(db);
  showToast('💰 שכר יומי נשמר', 'success');
}

// ============================================================
// 📢 ANNOUNCEMENTS — show CEO messages to all employees
// ============================================================
function renderAnnouncements() {

  const db  = getDB();
  const ann = db.announcements || [];
  if (!ann.length || !currentUser) return;

  // Find newest unseen announcement (not acked by this user)
  const unseen = ann.find(a => {
    if (!a.id) return false;
    return !(a.acks && a.acks[currentUser.username]);
  });
  if (!unseen) return;

  const d = new Date(unseen.ts);
  const dateStr = `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  document.getElementById('announcementFrom').textContent = `${unseen.from} — ${dateStr}`;
  document.getElementById('announcementText').textContent = unseen.text;

  const popup = document.getElementById('announcementPopup');
  popup.dataset.annId = unseen.id;
  popup.style.display = 'flex';
}

function closeAnnouncementPopup() {
  document.getElementById('announcementPopup').style.display = 'none';
  // Record ack in DB
  const annId = document.getElementById('announcementPopup').dataset.annId;
  if (!annId || !currentUser) return;
  const db = getDB();
  const ann = (db.announcements || []).find(a => a.id === annId);
  if (ann) {
    if (!ann.acks) ann.acks = {};
    ann.acks[currentUser.username] = new Date().toISOString();
    saveDB(db);
  }
}




function saveEmpBirthday(username, birthday) {
  const db = getDB();
  if (!db.users[username]) return;
  db.users[username].birthday = birthday;
  saveDB(db);
  showToast('🎂 תאריך לידה נשמר', 'success');
}

function renderAdminVacations() {
  const db = getDB();
  const filterEmp = document.getElementById('adminFilterEmp')?.value || '';
  const filterDept = document.getElementById('adminFilterDept')?.value || '';
  const filterYear = parseInt(document.getElementById('adminFilterYear')?.value || 2026);
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  
  const tbody = document.getElementById('adminVacTableBody');
  let rows = [];
  
  for (const [uname, user] of Object.entries(db.users)) {
    if (filterEmp && uname !== filterEmp) continue;
    // Department filter - support array dept
    if (filterDept) {
      const userDepts = Array.isArray(user.dept) ? user.dept : [user.dept];
      if (!userDepts.includes(filterDept)) continue;
    }
    const vacs = getVacations(uname);
    const deptDisplay = Array.isArray(user.dept) ? user.dept.join(', ') : (user.dept || '');
    
    for (let m = 1; m <= 12; m++) {
      let full = 0, half = 0, wfh = 0;
      for (const [dt, type] of Object.entries(vacs)) {
        if (!dt.startsWith(String(filterYear))) continue;
        if (parseInt(dt.split('-')[1]) !== m) continue;
        if (type === 'full') full++;
        else if (type === 'half') half++;
        else if (type === 'wfh') wfh++;
      }
      if (full + half > 0) { // Only show vacation days (not WFH-only rows)
        const total = full + half * 0.5;
        const payM = m >= 11 ? (m === 11 ? 0 : 1) : m;
        rows.push(`<tr>
          <td style="font-weight:700;">${user.fullName}</td>
          <td>${deptDisplay}</td>
          <td>${monthNames[m-1]}</td>
          <td>${full}</td>
          <td>${half}</td>
          <td style="font-weight:700;color:var(--primary);">${total}</td>
          <td style="font-size:12px;color:var(--text-muted);">${monthNames[payM]}</td>
        </tr>`);
      }
    }
  }
  
  tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">אין נתונים להצגה</td></tr>';
}

function clearAdminFilters() {
  const deptSel = document.getElementById('adminFilterDept');
  const empSel = document.getElementById('adminFilterEmp');
  if (deptSel) deptSel.value = '';
  if (empSel) empSel.value = '';
  renderAdminVacations();
}

function saveQuota() {
  const now = new Date();
  const isWindow = now.getMonth() === 0 && now.getDate() <= 9;
  const isAdmin = currentUser.role === 'admin';
  const isAccountant = currentUser.role === 'accountant';
  
  // Admin and accountant can always load quotas; regular employees cannot
  if (!isWindow && !isAdmin && !isAccountant) {
    showToast('⛔ לא ניתן לטעון מכסות מחוץ לחלון (01-09 לינואר)', 'error');
    return;
  }
  
  const emp = document.getElementById('quotaEmpSelect').value;
  const year = document.getElementById('quotaYearAdmin').value;
  const annual = parseFloat(document.getElementById('quotaAnnual').value);
  const knownBalance = parseFloat(document.getElementById('quotaInitBalance').value) || 0;
  const balanceDateStr = document.getElementById('quotaBalanceDate').value;
  
  if (!emp || isNaN(annual)) {
    showToast('⚠️ נא למלא מכסה שנתית', 'warning');
    return;
  }
  
  // Calculate carry-over (initialBalance = balance at Jan 1)
  // If balanceDate given: carryOver = knownBalance - (annual/12 * monthsElapsed)
  // where monthsElapsed = months from Jan 1 to balanceDate
  let carryOver = 0;
  let balanceDateObj = null;
  if (balanceDateStr) {
    balanceDateObj = new Date(balanceDateStr + 'T00:00:00');
    const balYear = balanceDateObj.getFullYear();
    const balMonth = balanceDateObj.getMonth() + 1; // 1-based
    if (balYear === parseInt(year)) {
      // monthsElapsed from start of year to balanceDate (inclusive of that month)
      const monthsElapsed = balMonth;
      carryOver = knownBalance - (annual / 12 * monthsElapsed);
    } else {
      carryOver = knownBalance; // different year, treat as-is
    }
  } else {
    // No date given — assume balance is carry-over from prev year (Jan 1 value)
    carryOver = knownBalance;
  }
  
  const db = getDB();
  if (!db.users[emp].quotas) db.users[emp].quotas = {};
  db.users[emp].quotas[year] = {
    annual,
    initialBalance: carryOver,         // real carry-over at Jan 1
    knownBalance,                        // original value entered
    balanceDate: balanceDateStr || null  // date of known balance
  };
  saveDB(db);
  
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const dateLabel = balanceDateObj
    ? `${balanceDateObj.getDate()} ${monthNames[balanceDateObj.getMonth()]} ${balanceDateObj.getFullYear()}`
    : `01 ינואר ${year}`;
  auditLog('quota_saved', `מכסה עודכנה ל-${db.users[emp].fullName}: ${annual} ימים`); showToast(`✅ מכסה נשמרה: ${annual} ימים | יתרת פתיחה (01/01): ${carryOver.toFixed(2)}`, 'success');
  renderAdmin();
}

// Live preview for quota calculator
function updateQuotaPreview() {
  const annual = parseFloat(document.getElementById('quotaAnnual')?.value) || 0;
  const knownBalance = parseFloat(document.getElementById('quotaInitBalance')?.value);
  const balanceDateStr = document.getElementById('quotaBalanceDate')?.value;
  const year = document.getElementById('quotaYearAdmin')?.value || new Date().getFullYear();
  const preview = document.getElementById('quotaCalcPreview');
  if (!preview) return;
  
  if (!annual || isNaN(knownBalance) || !balanceDateStr) {
    preview.innerHTML = '💡 הזן מכסה שנתית + יתרה ידועה + תאריך לחישוב אוטומטי';
    return;
  }
  
  const monthly = (annual / 12).toFixed(2);
  const balanceDateObj = new Date(balanceDateStr + 'T00:00:00');
  const balYear = balanceDateObj.getFullYear();
  const balMonth = balanceDateObj.getMonth() + 1;
  const monthsElapsed = parseInt(year) === balYear ? balMonth : 0;
  const carryOver = knownBalance - (annual / 12 * monthsElapsed);
  
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  preview.innerHTML = `
    💡 <strong>תצוגה מקדימה:</strong> 
    צבירה חודשית: <strong>${monthly}</strong> | 
    יתרה ב-${monthNames[balMonth-1]}: <strong>${knownBalance}</strong> = 
    carry-over (01/01): <strong>${carryOver.toFixed(2)}</strong> + 
    צבירה ${monthsElapsed} חודשים: <strong>${(annual/12*monthsElapsed).toFixed(2)}</strong>
  `;
}

function openAddEmployeeModal() {
  document.getElementById('addEmpError').style.display = 'none';
  document.getElementById('newEmpName').value = '';
  document.getElementById('newEmpUsername').value = '';
  document.getElementById('newEmpPass').value = '';
  populateDeptSelect('newEmpDept');
  openModal('addEmpModal');
}

function saveNewEmployee() {
  const name     = document.getElementById('newEmpName').value.trim();
  const username = document.getElementById('newEmpUsername').value.trim().toLowerCase();
  const dept     = document.getElementById('newEmpDept').value;
  const role     = document.getElementById('newEmpRole').value;
  const pass     = document.getElementById('newEmpPass').value;
  const salary   = parseFloat(document.getElementById('newEmpDailySalary')?.value) || 0;
  const errEl    = document.getElementById('addEmpError');

  if (!name || !username || !dept || !pass) {
    errEl.textContent = 'נא למלא את כל השדות'; errEl.style.display = 'block'; return;
  }

  const db = getDB();
  if (db.users[username]) {
    errEl.textContent = 'שם משתמש כבר קיים'; errEl.style.display = 'block'; return;
  }

  _sha256(pass).then(sha256hash => {
    db.users[username] = {
      fullName: name, username, password: sha256hash,
      dept, role, email: '', dailySalary: salary,
      mustChangePassword: true,
      quotas: { [new Date().getFullYear()]: { annual: 0, initialBalance: 0 } }
    };
    saveDB(db);
    closeModal('addEmpModal');
    auditLog('employee_added', `עובד חדש נוסף: ${name}`);
    showToast(`✅ עובד ${name} נוסף — יידרש לשנות סיסמה בכניסה`, 'success');
    renderAdmin();
  });
}

function deleteEmployee(username) {
  if (username === 'admin') return;
  const db = getDB();
  const name = db.users[username]?.fullName || username;
  if (!confirm(`למחוק את העובד ${name}? הפעולה בלתי הפיכה.`)) return;
  delete db.users[username];
  if (db.vacations) delete db.vacations[username];
  if (db.timeClockRecords) delete db.timeClockRecords[username];
  if (db.timeclock) delete db.timeclock[username];
  if (db.sick) {
    Object.keys(db.sick).forEach(k => { if (k.startsWith(username + '_')) delete db.sick[k]; });
  }
  saveDB(db);
  pushToFirebase().catch(e => console.warn('deleteEmployee push error:', e));
  auditLog('employee_deleted', `עובד נמחק: ${name}`);
  showToast('🗑️ העובד נמחק', 'success');
  renderAdmin();
}

// ============================================================
// UTIL: Clear month
// ============================================================
function clearMonth() {
  if (!confirm(`למחוק את כל ימי החופשה בחודש הנוכחי?`)) return;
  const { year, month } = calState;
  const db = getDB();
  if (!db.vacations[currentUser.username]) return;
  
  const prefix = dateToStr(year, month, 1).substring(0, 7);
  for (const key of Object.keys(db.vacations[currentUser.username])) {
    if (key.startsWith(prefix)) delete db.vacations[currentUser.username][key];
  }
  saveDB(db);
  renderCalendar();
  renderDashboard();
  showToast('🗑️ החודש נוקה', 'success');
}

function submitVacationRequest() {
  showToast('📨 הבקשה נשלחה למנהל בהצלחה', 'success');
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
// Close on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
});

// ============================================================
// TOAST
// ============================================================
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================================
// DEPARTMENT MULTISELECT
// ============================================================

// Safe dept display — handles both string and array
function getUserDept(user) {
  if (!user || !user.dept) return '';
  if (Array.isArray(user.dept)) return user.dept[0] || '';
  if (typeof user.dept === 'string') return user.dept;
  return '';
}
// Get all depts for a user as array
function getUserDepts(user) {
  if (!user || !user.dept) return [];
  if (Array.isArray(user.dept)) return user.dept.filter(Boolean);
  if (typeof user.dept === 'string') return user.dept ? [user.dept] : [];
  return [];
}
// ============================================================
// ORG TREE — getManagerScope(managerUsername, db)
// Returns the SET of dept names this manager can see
// (their direct depts + all depts under their sub-managers, recursively)
// null = sees ALL (admin / top-level with no restriction)
// ============================================================
function getManagerScope(managerUsername, db) {
  const users = db.users || {};
  const managerUser = users[managerUsername];
  if (!managerUser) return new Set();

  // Admin / accountant always see everything
  if (managerUser.role === 'admin' || managerUser.role === 'accountant') return null;

  const orgTree    = db.orgTree    || {};
  const deptManagers = db.deptManagers || {};
  const node       = orgTree[managerUsername];

  // Explicit top-level flag → sees all
  if (node && node.topLevel) return null;

  // Collect DIRECT depts
  let directDepts = [];
  if (node && node.directDepts && node.directDepts.length) {
    directDepts = node.directDepts;
  } else {
    // Legacy deptManagers fallback
    directDepts = Object.entries(deptManagers)
      .filter(([, mgr]) => mgr === managerUsername)
      .map(([dept]) => dept);
  }

  // Root node in orgTree (parentManager===null) with sub-managers but no direct depts
  // → top-level executive (CEO-style) → sees ALL
  const isRoot        = node && (node.parentManager === null || node.parentManager === undefined);
  const hasSubMgrs    = Object.values(orgTree).some(n => n.parentManager === managerUsername);
  if (isRoot && !directDepts.length && hasSubMgrs) return null;

  // Legacy: role==='manager' with no depts → sees all
  if (!directDepts.length && managerUser.role === 'manager' && !node) return null;

  // No depts, no special flag → sees only self
  if (!directDepts.length) return new Set();

  // Recursively collect all depts (BFS through children in orgTree)
  const allDepts = new Set(directDepts);

  const subManagers = Object.entries(orgTree)
    .filter(([, n]) => n.parentManager === managerUsername)
    .map(([u]) => u);

  // Legacy: any deptManagers entry whose dept is in our scope → their manager is a sub
  for (const [dept, mgr] of Object.entries(deptManagers)) {
    if (directDepts.includes(dept) && mgr && mgr !== managerUsername) {
      subManagers.push(mgr);
    }
  }

  const visited = new Set([managerUsername]);
  const queue   = [...new Set(subManagers)];
  while (queue.length) {
    const sub = queue.shift();
    if (visited.has(sub)) continue;
    visited.add(sub);
    const subScope = getManagerScope(sub, db);
    if (subScope === null) return null;
    subScope.forEach(d => allDepts.add(d));
    Object.entries(orgTree)
      .filter(([, n]) => n.parentManager === sub)
      .forEach(([u]) => { if (!visited.has(u)) queue.push(u); });
  }

  return allDepts;
}

// Check if manager manages a given user (using org tree)
function managerManagesUser(managerUsername, targetUser, db) {
  const scope = getManagerScope(managerUsername, db);
  if (scope === null) return true; // sees all
  if (scope.size === 0) return targetUser.username === managerUsername; // sees only self
  const targetDepts = getUserDepts(targetUser);
  return targetDepts.some(d => scope.has(d));
}

function getDepts() {
  const db = getDB();
  if (!db.departments || db.departments.length === 0) {
    db.departments = ['הנהלה','חשבות','מכירות','שיווק','פיתוח','תפעול','משאבי אנוש','לוגיסטיקה'];
    saveDB(db);
  }
  return db.departments;
}

function initDeptMultiselect(containerId) {
  const ids = deptElementIds[containerId];
  if (!ids) return;
  const dropdown = document.getElementById(ids.dropdown);
  if (!dropdown) return;

  const depts = getDepts();
  if (!deptSelectedMap[containerId]) deptSelectedMap[containerId] = new Set();

  dropdown.innerHTML = '';

  depts.forEach(dept => {
    const isSelected = deptSelectedMap[containerId].has(dept);
    const opt = document.createElement('div');
    opt.className = 'dept-option' + (isSelected ? ' selected' : '');
    opt.innerHTML = `<input type="checkbox" ${isSelected ? 'checked' : ''}> ${dept}`;
    opt.onclick = (e) => {
      e.stopPropagation();
      if (deptSelectedMap[containerId].has(dept)) {
        deptSelectedMap[containerId].delete(dept);
      } else {
        deptSelectedMap[containerId].add(dept);
      }
      renderDeptTags(containerId);
      initDeptMultiselect(containerId);
    };
    dropdown.appendChild(opt);
  });

  // Add new dept row (admins/accountants only, or always show in login since no currentUser yet)
  const canAdd = !currentUser || currentUser.role === 'admin' || currentUser.role === 'accountant';
  if (canAdd) {
    const addRow = document.createElement('div');
    addRow.className = 'dept-add-row';
    addRow.innerHTML = `<input class="dept-add-input" id="${containerId}NewInput" placeholder="מחלקה חדשה..." dir="rtl">
      <button class="dept-add-btn" onclick="addDeptFromMultiselect('${containerId}')">➕</button>`;
    dropdown.appendChild(addRow);
  }
}

function addDeptFromMultiselect(containerId) {
  const input = document.getElementById(containerId + 'NewInput');
  const name = input?.value?.trim();
  if (!name) return;

  const db = getDB();
  if (!db.departments) db.departments = [];
  if (!db.departments.includes(name)) {
    db.departments.push(name);
    saveDB(db);
  }
  if (!deptSelectedMap[containerId]) deptSelectedMap[containerId] = new Set();
  deptSelectedMap[containerId].add(name);
  renderDeptTags(containerId);
  initDeptMultiselect(containerId);
  showToast(`✅ מחלקה "${name}" נוספה`, 'success');
}

function renderDeptTags(containerId) {
  const ids = deptElementIds[containerId];
  if (!ids) return;
  const tagsEl = document.getElementById(ids.tags);
  if (!tagsEl) return;
  const selected = deptSelectedMap[containerId] || new Set();
  if (selected.size === 0) {
    tagsEl.innerHTML = '<span class="dept-placeholder">בחר מחלקה...</span>';
  } else {
    tagsEl.innerHTML = [...selected].map(d =>
      `<span class="dept-tag">${d} <span class="dept-tag-remove" onclick="removeDeptTag('${containerId}','${d}',event)">×</span></span>`
    ).join('');
  }
}

function removeDeptTag(containerId, dept, e) {
  e.stopPropagation();
  if (deptSelectedMap[containerId]) deptSelectedMap[containerId].delete(dept);
  renderDeptTags(containerId);
  initDeptMultiselect(containerId);
}

function toggleDeptDropdown(containerId) {
  const ids = deptElementIds[containerId];
  if (!ids) return;
  const dropdown = document.getElementById(ids.dropdown);
  const trigger = dropdown?.previousElementSibling;
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  // Close all open dropdowns
  document.querySelectorAll('.dept-dropdown.open').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.dept-trigger.open').forEach(t => t.classList.remove('open'));
  if (!isOpen) {
    initDeptMultiselect(containerId);
    dropdown.classList.add('open');
    if (trigger) trigger.classList.add('open');
  }
}

function getSelectedDepts(containerId) {
  return [...(deptSelectedMap[containerId] || new Set())];
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dept-multiselect')) {
    document.querySelectorAll('.dept-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.dept-trigger.open').forEach(t => t.classList.remove('open'));
  }
});

// ============================================================
// DEPARTMENT MANAGEMENT (admin section)
// ============================================================
// ============================================================
// ORG TREE UI FUNCTIONS
// ============================================================














function switchOrgTab(tab) {
  const deptContent = document.getElementById('orgTabDeptContent');
  const treeContent = document.getElementById('orgTabTreeContent');
  const deptBtn     = document.getElementById('orgTabDept');
  const treeBtn     = document.getElementById('orgTabTree');
  if (!deptContent || !treeContent) return;
  if (tab === 'tree') {
    deptContent.style.display = 'none'; treeContent.style.display = '';
    deptBtn.style.cssText  += ';border-bottom-color:transparent;color:var(--text-muted);font-weight:600;';
    treeBtn.style.cssText  += ';border-bottom-color:var(--primary);color:var(--primary);font-weight:800;';
    populateOrgTreeSelects(); renderOrgTree();
  } else {
    treeContent.style.display = 'none'; deptContent.style.display = '';
    deptBtn.style.cssText  += ';border-bottom-color:var(--primary);color:var(--primary);font-weight:800;';
    treeBtn.style.cssText  += ';border-bottom-color:transparent;color:var(--text-muted);font-weight:600;';
  }
}

function populateOrgTreeSelects() {
  const db = getDB();
  const allUsers = Object.values(db.users)
    .filter(u => isUserActive(u) && u.role !== 'admin')
    .sort((a,b) => a.fullName.localeCompare(b.fullName,'he'));

  const opts = allUsers.map(u => `<option value="${u.username}">${u.fullName}</option>`).join('');
  const mgrSel    = document.getElementById('orgTreeManager');
  const parentSel = document.getElementById('orgTreeParent');
  if (mgrSel)    mgrSel.innerHTML    = '<option value="">— בחר עובד —</option>' + opts;
  if (parentSel) parentSel.innerHTML = '<option value="">— אין מנהל מעל (שורש / מנכ"ל) —</option>' + opts;

  const deptBox = document.getElementById('orgTreeDeptsCheckboxes');
  if (deptBox) {
    const depts = db.departments || [];
    deptBox.innerHTML = depts.length
      ? depts.map(d =>
          `<label class="org-dept-chip" id="orgChip_${d.replace(/[^a-zA-Zא-ת]/g,'_')}">
            <input type="checkbox" value="${d}"> ${d}
          </label>`
        ).join('')
      : '<span style="color:var(--text-muted);font-size:12px;">אין מחלקות מוגדרות</span>';

    deptBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        const label = cb.closest('label');
        if (label) {
          label.style.background    = cb.checked ? 'var(--primary)'      : '';
          label.style.color         = cb.checked ? 'white'               : '';
          label.style.borderColor   = cb.checked ? 'var(--primary-dark)' : '';
        }
      };
    });
  }

  if (mgrSel) mgrSel.onchange = () => prefillOrgTreeForm();
}

function prefillOrgTreeForm() {
  const db = getDB();
  const orgTree      = db.orgTree      || {};
  const deptManagers = db.deptManagers || {};
  const username     = document.getElementById('orgTreeManager')?.value;
  if (!username) return;

  const node = orgTree[username] || {};
  const parentSel = document.getElementById('orgTreeParent');
  if (parentSel) parentSel.value = node.parentManager || '';

  const topChk = document.getElementById('orgTreeTopLevel');
  if (topChk) topChk.checked = !!node.topLevel;

  const directDepts = node.directDepts ||
    Object.entries(deptManagers).filter(([,mgr]) => mgr === username).map(([d]) => d);

  document.querySelectorAll('#orgTreeDeptsCheckboxes input[type="checkbox"]').forEach(cb => {
    cb.checked = directDepts.includes(cb.value);
    const label = cb.closest('label');
    if (label) {
      label.style.background  = cb.checked ? 'var(--primary)'      : '';
      label.style.color       = cb.checked ? 'white'               : '';
      label.style.borderColor = cb.checked ? 'var(--primary-dark)' : '';
    }
  });
}

function saveOrgTreeEntry() {
  const username = document.getElementById('orgTreeManager')?.value;
  if (!username) { showToast('⚠️ בחר עובד', 'warning'); return; }

  const parentManager = document.getElementById('orgTreeParent')?.value || null;
  const topLevel      = !!document.getElementById('orgTreeTopLevel')?.checked;
  const directDepts   = [...document.querySelectorAll('#orgTreeDeptsCheckboxes input:checked')]
    .map(cb => cb.value);

  const db = getDB();
  if (!db.orgTree) db.orgTree = {};
  db.orgTree[username] = { directDepts, parentManager, topLevel };

  // Sync to legacy deptManagers
  if (!db.deptManagers) db.deptManagers = {};
  Object.keys(db.deptManagers).forEach(dept => {
    if (db.deptManagers[dept] === username) delete db.deptManagers[dept];
  });
  directDepts.forEach(dept => { db.deptManagers[dept] = username; });

  // Promote to manager role
  if (db.users[username] && db.users[username].role === 'employee') {
    db.users[username].role = 'manager';
  }

  saveDB(db); pushToFirebase().catch(() => {});
  const name = db.users[username]?.fullName || username;
  showToast(`✅ ${name} עודכן בעץ הארגוני`, 'success');
  auditLog('org_tree_update', `${username}: מנהל [${directDepts.join(', ')}] | מדווח ל: ${parentManager || 'שורש'} | topLevel: ${topLevel}`);
  renderOrgTree();
  // Clear form
  const mgrSel = document.getElementById('orgTreeManager');
  if (mgrSel) mgrSel.value = '';
  document.querySelectorAll('#orgTreeDeptsCheckboxes input').forEach(cb => {
    cb.checked = false;
    const l = cb.closest('label');
    if (l) { l.style.background=''; l.style.color=''; l.style.borderColor=''; }
  });
}

function deleteOrgTreeEntry(username) {
  const db = getDB();
  const name = db.users[username]?.fullName || username;
  if (!confirm(`להסיר את ${name} מהעץ הארגוני?
הם לא יימחקו כעובדים — רק ההגדרה הארגונית תוסר.`)) return;
  if (db.orgTree) delete db.orgTree[username];
  if (db.deptManagers) {
    Object.keys(db.deptManagers).forEach(dept => {
      if (db.deptManagers[dept] === username) delete db.deptManagers[dept];
    });
  }
  // Demote to employee if they were promoted
  if (db.users[username] && db.users[username].role === 'manager') {
    db.users[username].role = 'employee';
  }
  saveDB(db); pushToFirebase().catch(() => {});
  renderOrgTree(); renderDeptManagerTable();
  showToast(`🗑️ ${name} הוסר מהעץ הארגוני`, 'info');
}

function renderOrgTree() {
  const el = document.getElementById('orgTreeDisplay');
  if (!el) return;
  const db = getDB();
  const orgTree      = db.orgTree      || {};
  const deptManagers = db.deptManagers || {};

  // Build unified nodes map
  const nodes = {};
  Object.entries(orgTree).forEach(([u, n]) => { nodes[u] = { ...n }; });
  Object.entries(deptManagers).forEach(([dept, mgr]) => {
    if (!nodes[mgr]) nodes[mgr] = { directDepts: [], parentManager: null };
    if (!nodes[mgr].directDepts) nodes[mgr].directDepts = [];
    if (!nodes[mgr].directDepts.includes(dept)) nodes[mgr].directDepts.push(dept);
  });

  if (!Object.keys(nodes).length) {
    el.innerHTML = `<div style="background:var(--surface2);border-radius:12px;padding:24px;text-align:center;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:8px;">🌲</div>
      <div style="font-weight:700;margin-bottom:6px;">העץ הארגוני ריק</div>
      <div style="font-size:13px;">השתמש בטופס למעלה להוספת מנהלים</div>
    </div>`;
    return;
  }

  // Build children map
  const children = {};
  Object.entries(nodes).forEach(([u, n]) => {
    if (n.parentManager) {
      if (!children[n.parentManager]) children[n.parentManager] = [];
      if (!children[n.parentManager].includes(u)) children[n.parentManager].push(u);
    }
  });

  const LEVEL_ICONS  = ['🏛️','👔','👤','👤'];
  const LEVEL_COLORS = ['var(--primary)','#7c3aed','#0891b2','#16a34a'];

  function renderNode(username, depth) {
    const user   = db.users[username];
    const name   = user ? user.fullName : username;
    const node   = nodes[username] || {};
    const depts  = node.directDepts || [];
    const scope  = getManagerScope(username, db);
    const scopeLabel = scope === null
      ? '👁️ כל העובדים'
      : scope.size === 0
        ? '👁️ עצמו בלבד'
        : `👁️ ${scope.size} מחלקות`;
    const color  = LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length-1)];
    const kids   = children[username] || [];
    const borderStyle = depth === 0
      ? `border-right: 4px solid ${color};`
      : `border-right: 3px solid ${color};`;
    const marginRight = depth * 20;

    const deptsHtml = depts.length
      ? depts.map(d => `<span style="background:${color}18;color:${color};border:1px solid ${color}44;border-radius:20px;padding:2px 10px;font-size:11px;font-weight:700;">${d}</span>`).join('')
      : '';

    const kidsHtml = kids.length
      ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">${kids.map(k => renderNode(k, depth+1)).join('')}</div>`
      : '';

    return `<div style="margin-right:${marginRight}px;background:var(--surface);${borderStyle}border-top:1px solid var(--border);border-bottom:1px solid var(--border);border-left:1px solid var(--border);border-radius:0 10px 10px 0;padding:10px 14px;margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:13px;color:${color};">${LEVEL_ICONS[Math.min(depth,3)]} ${name}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${scopeLabel}${node.topLevel?' · 🔑 גישה מלאה':''}</div>
          ${deptsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;">${deptsHtml}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="editOrgNode('${username}')" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-family:'Heebo',sans-serif;color:var(--text-secondary);">✏️</button>
          <button onclick="deleteOrgTreeEntry('${username}')" style="background:var(--danger-light);color:var(--danger);border:1px solid #fca5a5;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-family:'Heebo',sans-serif;">×</button>
        </div>
      </div>
      ${kidsHtml}
    </div>`;
  }

  const roots = Object.keys(nodes).filter(u => !nodes[u].parentManager);
  const orphans = Object.keys(nodes).filter(u => nodes[u].parentManager && !nodes[nodes[u].parentManager]);
  const allRoots = [...roots, ...orphans];

  el.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:10px;display:flex;align-items:center;gap:8px;">
      <span>מבנה ארגוני</span>
      <span style="background:var(--surface2);border-radius:8px;padding:2px 8px;">${Object.keys(nodes).length} מנהלים מוגדרים</span>
    </div>
    ${allRoots.map(u => renderNode(u, 0)).join('')}`;
}

function editOrgNode(username) {
  switchOrgTab('tree');
  setTimeout(() => {
    const mgrSel = document.getElementById('orgTreeManager');
    if (mgrSel) { mgrSel.value = username; prefillOrgTreeForm(); }
    document.getElementById('orgTreeManager')?.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 100);
}

function renderDeptManagerTable() {
  const db = getDB();
  const depts = db.departments || [];
  const deptManagers = db.deptManagers || {};
  const el = document.getElementById('deptManagerTable');
  if (!el) return;

  // Get all users who can be managers (everyone except basic employees)
  const allUsers = Object.values(db.users);
  const managerOptions = allUsers.map(u =>
    `<option value="${u.username}">${u.fullName}${u.role==='admin'?' (אדמין)':u.role==='manager'?' (מנהל)':''}</option>`
  ).join('');

  if (!depts.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">אין מחלקות עדיין</p>';
    return;
  }

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:var(--surface2);">
        <th style="padding:10px;text-align:right;">מחלקה</th>
        <th style="padding:10px;text-align:right;">מנהל/ת אחראי/ת לאישור חופשות</th>
        <th style="padding:10px;text-align:right;">עובדים</th>
        <th style="padding:10px;"></th>
      </tr></thead>
      <tbody>
        ${depts.map(dept => {
          const managerUsername = deptManagers[dept] || '';
          const managerUser = managerUsername ? db.users[managerUsername] : null;
          const empCount = allUsers.filter(u => (u.dept||[]).includes ? (u.dept||[]).includes(dept) : u.dept===dept).length;
          return `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:10px;font-weight:700;">🏢 ${dept}</td>
            <td style="padding:10px;">
              <select onchange="setDeptManager('${dept}', this.value)" class="form-input" style="font-size:13px;padding:6px 10px;width:200px;" dir="rtl">
                <option value="">— ללא מנהל מוגדר —</option>
                ${allUsers.map(u => `<option value="${u.username}" ${u.username===managerUsername?'selected':''}>${u.fullName}</option>`).join('')}
              </select>
              ${!managerUsername ? '<span style="color:var(--warning);font-size:11px;margin-right:6px;">⚠️ לא מוגדר</span>' : ''}
            </td>
            <td style="padding:10px;color:var(--text-secondary);">${empCount} עובדים</td>
            <td style="padding:10px;">
              <button onclick="removeDepartment('${dept}')" style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:18px;" title="מחק מחלקה">×</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function setDeptManager(dept, username) {
  const db = getDB();
  if (!db.deptManagers) db.deptManagers = {};
  if (username) {
    db.deptManagers[dept] = username;
    const managerName = db.users[username]?.fullName || username;
    showToast(`✅ ${managerName} הוגדר/ה כמנהל/ת של ${dept}`, 'success');
    auditLog('dept_manager_set', `מנהל ${dept} הוגדר: ${managerName}`);
  } else {
    delete db.deptManagers[dept];
    showToast(`⚠️ הוסר מנהל מ-${dept}`, 'warning');
  }
  saveDB(db);
  renderDeptManagerTable();
}

function isUserDeptManager(username) {
  // Returns true if this user is assigned as manager of any department
  const db = getDB();
  const deptManagers = db.deptManagers || {};
  return Object.values(deptManagers).includes(username);
}

function getDeptManagerForUser(username) {
  // Returns the manager username for a given employee
  const db = getDB();
  const user = db.users[username];
  if (!user) return null;
  const deptManagers = db.deptManagers || {};
  const userDepts = Array.isArray(user.dept) ? user.dept : [user.dept].filter(Boolean);

  for (const dept of userDepts) {
    const mgr = deptManagers[dept];
    if (mgr && mgr !== username) return mgr; // found a manager, not themselves
  }
  // Fallback: return admin
  const admins = Object.values(db.users).filter(u => u.role === 'admin');
  return admins[0]?.username || null;
}

function addDepartment() {
  const input = document.getElementById('newDeptInput');
  const name = input.value.trim();
  if (!name) { showToast('⚠️ נא להזין שם מחלקה', 'warning'); return; }
  const db = getDB();
  if (!db.departments) db.departments = [];
  if (db.departments.includes(name)) { showToast('⚠️ מחלקה זו כבר קיימת', 'warning'); return; }
  db.departments.push(name);
  saveDB(db);
  input.value = '';
  renderDeptManagerTable();
  showToast(`✅ מחלקה "${name}" נוספה — הגדר מנהל בטבלה`, 'success');
}

function removeDepartment(name) {
  if (!confirm(`למחוק את המחלקה "${name}"?`)) return;
  const db = getDB();
  db.departments = (db.departments || []).filter(d => d !== name);
  if (db.deptManagers) delete db.deptManagers[name];
  saveDB(db);
  renderDeptManagerTable();
  showToast(`🗑️ מחלקה "${name}" נמחקה`, 'success');
}


// ============================================================
// EXCEL QUOTA UPLOAD
// ============================================================

function handleQuotaExcelUpload(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('quotaExcelFileName').textContent = file.name;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      let rows = [];
      const text = e.target.result;
      
      // Parse CSV
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      // Skip header row
      const dataLines = lines.slice(1);
      
      dataLines.forEach(line => {
        // Handle quoted CSV
        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        if (cols.length >= 4 && cols[0]) {
          rows.push({
            firstName: cols[0],
            lastName: cols[1],
            annual: parseFloat(cols[2]) || 0,
            currentQuota: parseFloat(cols[3]) || 0
          });
        }
      });
      
      if (rows.length === 0) {
        showToast('⚠️ לא נמצאו שורות תקינות בקובץ', 'warning');
        return;
      }
      
      pendingExcelQuotas = rows;
      showExcelConfirm(rows);
    } catch(err) {
      showToast('❌ שגיאה בקריאת הקובץ: ' + err.message, 'error');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function showExcelConfirm(rows) {
  const now = new Date();
  const isJan = now.getMonth() === 0;
  const currentMonthHe = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'][now.getMonth()];
  const currentMonthNum = now.getMonth() + 1;
  const year = now.getFullYear();
  
  let warningHtml = '';
  if (!isJan) {
    warningHtml = `
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
        ⚠️ <strong>שים לב!</strong> אתה טוען מכסות בחודש <strong>${currentMonthHe}</strong> ולא בינואר.<br>
        <strong>תאריך יתרה שישמר: 01/${String(currentMonthNum).padStart(2,'0')}/${year}</strong><br>
        יתרת סוף שנה תחושב: יתרה נוכחית + צבירה חודשית × ${12 - currentMonthNum} חודשים
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;">
            <input type="checkbox" id="excelMonthConfirm" style="accent-color:var(--primary);width:16px;height:16px;">
            אני מאשר/ת שהמכסה הנוכחית מתייחסת ל-01 ${currentMonthHe} ${year}
          </label>
        </div>
      </div>`;
  }
  
  // Match rows to users
  const db = getDB();
  const matchedRows = rows.map(row => {
    const fullSearch = (row.firstName + ' ' + row.lastName).trim().toLowerCase();
    const firstSearch = row.firstName.trim().toLowerCase();
    const lastSearch = row.lastName.trim().toLowerCase();
    let matched = null;
    for (const [uname, user] of Object.entries(db.users)) {
      const uFull = user.fullName.toLowerCase();
      const parts = uFull.split(' ');
      if (uFull === fullSearch || uFull.includes(firstSearch) && uFull.includes(lastSearch)) {
        matched = user;
        break;
      }
    }
    return { ...row, matched };
  });
  
  const tableRows = matchedRows.map((r, i) => {
    const statusIcon = r.matched ? '✅' : '⚠️';
    const statusText = r.matched ? r.matched.fullName : 'לא נמצא';
    const statusColor = r.matched ? 'var(--success)' : 'var(--warning)';
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;font-size:13px;">${r.firstName} ${r.lastName}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">${r.annual}</td>
      <td style="padding:8px;font-size:13px;text-align:center;">${r.currentQuota}</td>
      <td style="padding:8px;font-size:12px;color:${statusColor};">${statusIcon} ${statusText}</td>
    </tr>`;
  }).join('');
  
  const matchCount = matchedRows.filter(r => r.matched).length;
  
  document.getElementById('quotaExcelConfirmBody').innerHTML = `
    ${warningHtml}
    <p style="font-size:14px;margin-bottom:12px;">נמצאו <strong>${rows.length}</strong> שורות בקובץ, מתוכן <strong style="color:var(--success);">${matchCount}</strong> זוהו עובדים קיימים.</p>
    <div style="overflow-x:auto;border-radius:8px;border:1px solid var(--border);">
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <thead><tr style="background:var(--surface2);">
          <th style="padding:8px;text-align:right;">שם</th>
          <th style="padding:8px;text-align:center;">מכסה שנתית</th>
          <th style="padding:8px;text-align:center;">מכסה נוכחית</th>
          <th style="padding:8px;text-align:right;">זיהוי</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  
  // Store matched rows for apply
  pendingExcelQuotas = matchedRows;
  openModal('quotaExcelConfirmModal');
}

function applyExcelQuotas() {
  // Check if month confirmation required
  const now = new Date();
  const isJan = now.getMonth() === 0;
  if (!isJan) {
    const confirmed = document.getElementById('excelMonthConfirm');
    if (confirmed && !confirmed.checked) {
      showToast('⚠️ יש לאשר שהמכסה מתייחסת לחודש הנוכחי', 'warning');
      return;
    }
  }
  
  const db = getDB();
  const year = now.getFullYear();
  // balanceDate = first day of current month (the date the accountant's data reflects)
  const balanceMonth = now.getMonth() + 1;
  const balanceDateStr = `${year}-${String(balanceMonth).padStart(2,'0')}-01`;
  let updated = 0;
  
  pendingExcelQuotas.forEach(row => {
    if (row.matched) {
      const uname = row.matched.username;
      if (!db.users[uname].quotas) db.users[uname].quotas = {};
      const annual = row.annual;
      const monthly = annual / 12;
      // knownBalance = the value the accountant entered ("מכסה נוכחית")
      // initialBalance = reverse-calculated carry-over at Jan 1
      // carryOver = knownBalance - monthly * loadMonth
      const carryOver = row.currentQuota - monthly * balanceMonth;
      db.users[uname].quotas[String(year)] = {
        annual,
        initialBalance: carryOver,         // carry-over at Jan 1
        knownBalance:   row.currentQuota,  // as entered by accountant
        balanceDate:    balanceDateStr      // 01/current-month
      };
      updated++;
    }
  });
  
  saveDB(db);
  closeModal('quotaExcelConfirmModal');
  showToast(`✅ מכסות עודכנו בהצלחה ל-${updated} עובדים`, 'success');
  document.getElementById('quotaExcelFileName').textContent = 'לא נבחר קובץ';
  document.getElementById('quotaExcelInput').value = '';
  renderAdmin();
}

// ============================================================
// 🎉 SURPRISE FEATURE: SMART VACATION FORECAST
// Shows a beautiful forecast card predicting end-of-year balance
// ============================================================
function renderVacationForecast() {
  const el = document.getElementById('vacationForecastCard');
  if (!el) return;
  
  const year = calState.year || new Date().getFullYear();
  const now = new Date();
  const cb = calcBalance(currentUser.username, year);
  const { accrued, balance: currentBalance, monthly, projectedEndBalance, stats, quota, annual } = cb;
  
  const endOfYear = new Date(year, 11, 31);
  const startOfYear = new Date(year, 0, 1);
  const totalDaysInYear = (endOfYear - startOfYear) / (1000 * 60 * 60 * 24);
  const daysPassed = Math.max(0, Math.min(totalDaysInYear, (now - startOfYear) / (1000 * 60 * 60 * 24)));
  const remainingWorkDays = Math.round((totalDaysInYear - daysPassed) * 5 / 7);
  
  const monthsLeft = Math.max(0, 12 - cb.monthsElapsed);
  const recommended = monthsLeft > 0 ? Math.max(0, projectedEndBalance / monthsLeft).toFixed(1) : '0';
  
  // Color and status
  let statusEmoji, statusText, statusColor;
  if (projectedEndBalance > 5) {
    statusEmoji = '🟢'; statusText = 'קצב מצוין!'; statusColor = 'var(--success)';
  } else if (projectedEndBalance >= 0) {
    statusEmoji = '🟡'; statusText = 'בסדר גמור'; statusColor = 'var(--warning)';
  } else {
    statusEmoji = '🔴'; statusText = 'חריגה צפויה!'; statusColor = 'var(--danger)';
  }
  
  // Avg vacation days per month used
  const vacs = getVacations(currentUser.username);
  const monthsWithVacations = {};
  for (const [dt, type] of Object.entries(vacs)) {
    if (dt.startsWith(String(year)) && type !== 'wfh') {
      const m = dt.substring(0, 7);
      if (!monthsWithVacations[m]) monthsWithVacations[m] = 0;
      monthsWithVacations[m] += type === 'full' ? 1 : 0.5;
    }
  }
  const monthsUsed = Object.keys(monthsWithVacations).length;
  const avgPerMonth = monthsUsed > 0 ? (stats.total / monthsUsed).toFixed(1) : '0';
  
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <div class="section-title" style="margin-bottom:0;"><span class="section-title-icon">🔮</span> תחזית חופשה</div>
      <span style="background:${statusColor}22;color:${statusColor};padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700;border:1px solid ${statusColor}44;">${statusEmoji} ${statusText}</span>
    </div>
    
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">
      <div style="background:var(--primary-light);border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:var(--primary);">${accrued.toFixed(2)}</div>
        <div style="font-size:11px;color:var(--text-secondary);">צברתי עד כה</div>
      </div>
      <div style="background:${currentBalance < 0 ? 'var(--danger-light)' : 'var(--success-light)'};border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:${currentBalance < 0 ? 'var(--danger)' : 'var(--success)'};">${currentBalance.toFixed(2)}</div>
        <div style="font-size:11px;color:var(--text-secondary);">יתרה נוכחית</div>
      </div>
      <div style="background:#fef3c7;border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#d97706;">${recommended}</div>
        <div style="font-size:11px;color:var(--text-secondary);">ימים מומלצים/חודש</div>
      </div>
      <div style="background:#f3e8ff;border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#7c3aed;">${avgPerMonth}</div>
        <div style="font-size:11px;color:var(--text-secondary);">ממוצע בפועל/חודש</div>
      </div>
    </div>
    
    <!-- Progress bar -->
    <div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">
        <span>ניצול מול צבירה (${stats.total} ניצול / ${accrued.toFixed(2)} נצבר)</span>
        <span>${Math.round(stats.total / Math.max(1, accrued) * 100)}%</span>
      </div>
      <div style="height:10px;background:var(--border);border-radius:10px;overflow:hidden;">
        <div style="height:100%;width:${Math.min(100, stats.total / Math.max(0.01, accrued) * 100)}%;background:${stats.total > accrued ? 'var(--danger)' : 'var(--primary)'};border-radius:10px;transition:width 0.5s;"></div>
      </div>
    </div>
    <div style="font-size:12px;color:var(--text-muted);">
      📅 נותרו כ-${remainingWorkDays} ימי עבודה השנה &nbsp;|&nbsp; 
      🎯 יתרה צפויה בסוף שנה: <strong style="color:${projectedEndBalance < 0 ? 'var(--danger)' : 'var(--success)'};">${projectedEndBalance.toFixed(2)} ימים</strong> &nbsp;|&nbsp;
      ✈️ ניתן לנצל עוד ${Math.max(0, currentBalance).toFixed(2)} ימים כיום
    </div>
  `;
}

// ============================================================
// THEME SYSTEM
// ============================================================
function setTheme(theme, el) {
  // Only admin can change theme
  if (currentUser && currentUser.role !== 'admin') return;
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
  localStorage.setItem('vacSystem_theme', theme);
  // Save to DB so all users get it
  const db = getDB();
  if (!db.settings) db.settings = {};
  db.settings.theme = theme;
  saveDB(db);
  showToast('🎨 צבע הממשק עודכן לכל המשתמשים', 'success');
}

// Load theme — from DB first (company-wide), fallback to localStorage
function loadTheme() {
  const db = getDB();
  const theme = db.settings?.theme || localStorage.getItem('vacSystem_theme') || 'blue';
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
  const swatch = document.querySelector(`.theme-swatch[data-theme="${theme}"]`);
  if (swatch) swatch.classList.add('active');
}

// Load saved theme on startup
(function() {
  const saved = localStorage.getItem('vacSystem_theme') || 'blue';
  document.body.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => loadTheme());
})();

// ============================================================
// PASSWORD MANAGEMENT (ADMIN)
// ============================================================

function openResetPasswordModal(username) {
  const db = getDB();
  const user = db.users[username];
  if (!user) return;
  passwordTargetUser = username;
  document.getElementById('resetEmpName').textContent = user.fullName + ' (' + username + ')';
  document.getElementById('resetNewPass').value = '';
  openModal('resetPasswordModal');
}

function doResetPassword() {
  const newPass = document.getElementById('resetNewPass').value.trim();
  if (!newPass || newPass.length < 4) {
    showToast('⚠️ הסיסמה חייבת להיות לפחות 4 תווים', 'warning');
    return;
  }
  const db = getDB();
  _sha256(newPass).then(hash => {
    db.users[passwordTargetUser].password = hash;
    db.users[passwordTargetUser].mustChangePassword = true;
    saveDB(db);
    closeModal('resetPasswordModal');
    showToast(`✅ סיסמת ${db.users[passwordTargetUser].fullName} אופסה — יידרש שינוי בכניסה`, 'success');
  });
}

function openChangePasswordModal(username) {
  const db = getDB();
  const user = db.users[username];
  if (!user) return;
  passwordTargetUser = username;
  document.getElementById('changeEmpName').textContent = user.fullName + ' (' + username + ')';
  document.getElementById('changeEmpNewPass').value = '';
  document.getElementById('changeEmpNewPass2').value = '';
  openModal('changeEmpPasswordModal');
}

function doChangeEmpPassword() {
  const p1 = document.getElementById('changeEmpNewPass').value;
  const p2 = document.getElementById('changeEmpNewPass2').value;
  if (!p1 || p1.length < 4) {
    showToast('⚠️ הסיסמה חייבת להיות לפחות 4 תווים', 'warning');
    return;
  }
  if (p1 !== p2) {
    showToast('⚠️ הסיסמאות אינן תואמות', 'warning');
    return;
  }
  const db = getDB();
  _sha256(p1).then(hash => {
    db.users[passwordTargetUser].password = hash;
    saveDB(db);
    closeModal('changeEmpPasswordModal');
    showToast(`✅ סיסמת ${db.users[passwordTargetUser].fullName} שונתה בהצלחה`, 'success');
  });
}

async function changeAdminPassword() {
  const current = document.getElementById('adminCurrentPass').value;
  const newP = document.getElementById('adminNewPass').value;
  const newP2 = document.getElementById('adminNewPass2').value;
  const db = getDB();
  const adminUser = db.users['admin'];
  if (!adminUser) { showToast('⚠️ משתמש admin לא נמצא', 'warning'); return; }
  if (!newP || newP.length < 4) { showToast('⚠️ הסיסמה חייבת להיות לפחות 4 תווים', 'warning'); return; }
  if (newP !== newP2) { showToast('⚠️ הסיסמאות אינן תואמות', 'warning'); return; }
  const _legHash = p => { let h=0; for(let i=0;i<p.length;i++){h=((h<<5)-h)+p.charCodeAt(i);h=h&h;} return 'h'+Math.abs(h).toString(36)+p.length; };
  const sha256cur = await _sha256(current);
  if (adminUser.password !== sha256cur && adminUser.password !== _legHash(current)) {
    showToast('❌ הסיסמה הנוכחית שגויה', 'error'); return;
  }
  const newHash = await _sha256(newP);
  db.users['admin'].password = newHash;
  saveDB(db);
  document.getElementById('adminCurrentPass').value = '';
  document.getElementById('adminNewPass').value = '';
  document.getElementById('adminNewPass2').value = '';
  showToast('✅ סיסמת ADMIN שונתה בהצלחה! שמור אותה במקום בטוח.', 'success');
}

// ============================================================
// EMAIL SUBMIT FLOW
// ============================================================
function confirmSubmitRequest() {
  const note = document.getElementById('submitNote')?.value.trim() || '';
  closeModal('submitModal');
  doSubmitRequest(note);
  updateApprovalStatusBadge();
  showToast('📨 הבקשה נשלחה למנהל', 'success');
}

function updateApprovalStatusBadge() {
  const badge = document.getElementById('approvalStatusBadge');
  const btn   = document.getElementById('submitApprovalBtn');
  if(!badge || !currentUser) return;

  const {year, month} = calState;
  const db = getDB();
  const req = (db.approvalRequests || []).findLast ?
    (db.approvalRequests || []).findLast(r => r.username === currentUser.username && r.year === year && r.month === month) :
    [...(db.approvalRequests || [])].reverse().find(r => r.username === currentUser.username && r.year === year && r.month === month);

  if(!req) {
    badge.style.display = 'none';
    if(btn) { btn.style.display = ''; btn.textContent = '📨 שלח לאישור'; }
    return;
  }

  badge.style.display = '';
  if(btn) btn.style.display = ''; // reset visibility

  if(req.status === 'pending') {
    badge.textContent = '⏳ ממתין לאישור';
    badge.style.background = '#fef3c7';
    badge.style.color = '#92400e';
    badge.style.border = '1px solid #fbbf24';
    if(btn) btn.textContent = '🔄 שלח מחדש';
  } else if(req.status === 'approved') {
    badge.textContent = '✅ אושר';
    badge.style.background = 'var(--success-light)';
    badge.style.color = '#14532d';
    badge.style.border = '1px solid var(--success)';
    if(btn) btn.style.display = 'none';
  } else if(req.status === 'rejected') {
    badge.textContent = `❌ נדחה${req.rejectReason ? ' — ' + req.rejectReason : ''}`;
    badge.style.background = 'var(--danger-light)';
    badge.style.color = '#7f1d1d';
    badge.style.border = '1px solid #fca5a5';
    if(btn) btn.textContent = '📨 שלח מחדש';
  } else if(req.status === 'changed') {
    badge.textContent = '⚠️ הימים השתנו — יש לשלוח מחדש';
    badge.style.background = '#fff7ed';
    badge.style.color = '#9a3412';
    badge.style.border = '1px solid #fb923c';
    if(btn) btn.textContent = '📨 שלח לאישור מחדש';
  }
}


// ============================================================
// 🔒 PERMISSIONS ENGINE
// ============================================================

// All sections that can be permission-gated
// key: sectionId, label: display name, adminOnly: never shown to non-admin regardless
const PERMISSION_SECTIONS = [
  { key: 'companySettingsSection',     label: '🏢 הגדרות חברה',             adminOnly: true  },
  { key: 'timeClockExportSection',     label: '⏱️ ייצוא דיווחי שעות',       adminOnly: false },
  { key: 'pendingRegistrationsSection',label: '👥 אישור הרשמות',             adminOnly: false },
  { key: 'adminPasswordSection',       label: '🔐 שינוי סיסמת ADMIN',        adminOnly: true  },
  { key: 'dataResetSection',           label: '⚠️ איפוס נתונים',             adminOnly: true  },
  { key: 'deptMgmtSection',            label: '🏢 ניהול מחלקות ומנהלים',     adminOnly: false },
  { key: 'employeeListSection',        label: '👥 רשימת עובדים',             adminOnly: false },
  { key: 'allVacationsSection',        label: '📋 כל בקשות החופשה',          adminOnly: false },
  { key: 'approvalRequestsSection',    label: '📨 בקשות אישור',              adminOnly: false },
  { key: 'permissionsSection',         label: '🔒 ניהול הרשאות',             adminOnly: true  },
  { key: 'canSendAnnouncements',       label: '📢 שליחת הודעות לכל הצוות',   adminOnly: false, special: true },
];

// Get permissions for a user (returns object { sectionKey: true/false })
function getUserPermissions(username) {
  const db = getDB();
  return (db.permissions || {})[username] || {};
}

// Save permissions for a user
function saveUserPermissions(username, perms) {
  const db = getDB();
  if (!db.permissions) db.permissions = {};
  db.permissions[username] = perms;
  saveDB(db);
}

// Check if current user can see a section
function canSeeSectionPermission(sectionKey) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true; // admin always sees all

  const section = PERMISSION_SECTIONS.find(s => s.key === sectionKey);
  if (!section) return false;
  if (section.adminOnly) return false; // non-admins never see admin-only sections

  const perms = getUserPermissions(currentUser.username);
  return perms[sectionKey] === true;
}

// Apply permissions to all sections in admin tab
function applyPermissionsToAdminTab() {
  if (!currentUser) return;
  const isAdmin = currentUser.role === 'admin';

  // auditLogSection תמיד נשלט ע"י role בלבד — לא ניתן להאצלה
  const auditEl = document.getElementById('auditLogSection');
  if (auditEl) auditEl.style.display = isAdmin ? '' : 'none';

  PERMISSION_SECTIONS.forEach(({ key, adminOnly }) => {
    const el = document.getElementById(key);
    if (!el) return;
    if (isAdmin) {
      el.style.display = ''; // admin always sees everything
      return;
    }
    // Non-admin: check section.adminOnly and their specific permission
    if (adminOnly) {
      el.style.display = 'none';
    } else {
      const perms = getUserPermissions(currentUser.username);
      el.style.display = perms[key] ? '' : 'none';
    }
  });

  // Hide the permissions section itself from non-admins always
  const permSec = document.getElementById('permissionsSection');
  if (permSec) permSec.style.display = isAdmin ? '' : 'none';
}

// Check if user has ANY non-adminOnly permission → show admin tab at all
function userHasAnyAdminAccess(username) {
  if (!username) return false;
  const db = getDB();
  const user = db.users[username];
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'accountant') return true;
  const perms = getUserPermissions(username);
  return PERMISSION_SECTIONS.some(s => !s.adminOnly && perms[s.key] === true);
}

// Render permissions table for admin
function renderPermissionsTable() {
  const el = document.getElementById('permissionsTable');
  if (!el) return;
  const db = getDB();

  // Only show non-admin users (managers + employees)
  const users = Object.values(db.users).filter(u =>
    u.role !== 'admin' && isUserActive(u)
  ).sort((a, b) => a.fullName.localeCompare(b.fullName));

  if (!users.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">אין עובדים להצגה</div>';
    return;
  }

  const grantableSections = PERMISSION_SECTIONS.filter(s => !s.adminOnly);

  el.innerHTML = `
    <table style="border-collapse:collapse;width:100%;font-size:12px;min-width:600px;">
      <thead>
        <tr style="background:var(--surface2);">
          <th style="padding:10px 12px;text-align:right;font-size:13px;min-width:140px;">עובד / מנהל</th>
          <th style="padding:10px 8px;text-align:center;font-size:11px;min-width:50px;">גישה לניהול</th>
          ${grantableSections.map(s => `
            <th style="padding:10px 6px;text-align:center;font-size:10px;max-width:80px;white-space:normal;line-height:1.3;">${s.label}</th>
          `).join('')}
          <th style="padding:10px 8px;text-align:center;">שמור</th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => {
          const perms = getUserPermissions(u.username);
          const hasAny = grantableSections.some(s => perms[s.key]);
          return `
            <tr style="border-bottom:1px solid var(--border);" id="permRow_${u.username}">
              <td style="padding:10px 12px;">
                <div style="font-weight:700;">${u.fullName}</div>
                <div style="font-size:11px;color:var(--text-muted);">${u.role === 'manager' ? '👔 מנהל' : '👤 עובד'} · ${getUserDept(u) || ''}</div>
              </td>
              <td style="padding:10px 8px;text-align:center;">
                <span style="font-size:11px;padding:3px 8px;border-radius:10px;font-weight:700;background:${hasAny ? 'var(--success-light)' : 'var(--surface2)'};color:${hasAny ? 'var(--success)' : 'var(--text-muted)'};">
                  ${hasAny ? '✅ יש' : '—'}
                </span>
              </td>
              ${grantableSections.map(s => `
                <td style="padding:10px 6px;text-align:center;">
                  <input type="checkbox"
                    id="perm_${u.username}_${s.key}"
                    ${perms[s.key] ? 'checked' : ''}
                    style="width:16px;height:16px;cursor:pointer;"
                    onchange="onPermCheckChange('${u.username}')">
                </td>
              `).join('')}
              <td style="padding:10px 8px;text-align:center;">
                <button onclick="savePermRow('${u.username}')"
                  class="btn btn-primary"
                  style="padding:6px 14px;font-size:12px;border-radius:8px;">
                  💾
                </button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px;font-size:11px;color:var(--text-muted);">
      💡 סעיפים עם 🔒 (הגדרות חברה, סיסמת ADMIN, איפוס, הרשאות) — נגישים ל-ADMIN בלבד ולא ניתנים להאצלה.
    </div>`;
}

function quickGrantPermission() {
  const username = document.getElementById('quickPermUser').value;
  const level    = document.getElementById('quickPermLevel').value;
  if (!username) { showToast('⚠️ בחר עובד', 'warning'); return; }

  const presets = {
    reports:    { allVacationsSection: true, approvalRequestsSection: true },
    timeclock:  { timeClockExportSection: true },
    employees:  { employeeListSection: true, quotaUploadAdminSection: true, pendingRegistrationsSection: true },
    full:       { timeClockExportSection: true, pendingRegistrationsSection: true, deptMgmtSection: true,
                  quotaUploadAdminSection: true, employeeListSection: true, allVacationsSection: true, approvalRequestsSection: true }
  };

  const perms = presets[level] || {};
  saveUserPermissions(username, perms);
  const db   = getDB();
  const name = db.users[username]?.fullName || username;
  showToast(`✅ הרשאות הוענקו ל${name}`, 'success');
  auditLog('permissions_update', `הרשאת ${level} הוענקה ל${username}`);
  renderPermissionsTable();
}

function populateQuickPermUser() {
  const db = getDB();
  const users = Object.values(db.users)
    .filter(u => u.role !== 'admin' && isUserActive(u))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const opts = users.map(u => `<option value="${u.username}">${u.fullName} · ${Array.isArray(u.dept)?u.dept[0]:u.dept||''}</option>`).join('');

  const sel = document.getElementById('quickPermUser');
  if (sel) sel.innerHTML = '<option value="">בחר עובד...</option>' + opts;

  const permSel = document.getElementById('permEditSelect');
  if (permSel) permSel.innerHTML = '<option value="">— בחר עובד לעריכת הרשאות —</option>' + opts;
}


function onPermCheckChange(username) {
  const row = document.getElementById('permRow_' + username);
  if (row) row.style.background = 'var(--warning-light)';
}

function savePermRow(username) {
  const grantableSections = PERMISSION_SECTIONS.filter(s => !s.adminOnly);
  const perms = {};
  grantableSections.forEach(s => {
    const cb = document.getElementById(`perm_${username}_${s.key}`);
    if (cb) perms[s.key] = cb.checked;
  });
  saveUserPermissions(username, perms);

  const row = document.getElementById('permRow_' + username);
  if (row) row.style.background = 'var(--success-light)';
  setTimeout(() => { if (row) row.style.background = ''; }, 1500);

  const db = getDB();
  const name = db.users[username]?.fullName || username;
  showToast(`✅ הרשאות של ${name} נשמרו`, 'success');
  auditLog('permissions_update', `עודכנו הרשאות של ${username}`);

  // Re-render the access indicator column
  renderPermissionsTable();

  // If editing self (shouldn't happen since admin can't edit self here, but safety)
  if (username === currentUser?.username) {
    applyPermissionsToAdminTab();
  }
}


// ============================================================

let _bulkImportData = []; // parsed rows ready to import

// ============================================================
// 👔 CEO DASHBOARD — gmaneg user
// ============================================================
const CEO_USERNAME = 'gmaneg';

function isCeoUser() {
  return currentUser && currentUser.username === CEO_USERNAME;
}

function showCeoDashboard() {
  ['loginScreen','appScreen','timeClockScreen','moduleSelectorScreen','forcePasswordScreen'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('ceoDashboardScreen').classList.add('active');
  loadTheme();

  // Populate hero card (logo + company name) — same as module selector
  const s = getSettings();
  const logoImg  = document.getElementById('ceoLogoImg');
  const logoIcon = document.getElementById('ceoBrandIcon');
  if (s.companyLogo && logoImg) {
    logoImg.src = s.companyLogo; logoImg.style.display = 'block';
    if (logoIcon) logoIcon.style.display = 'none';
  } else {
    if (logoImg) logoImg.style.display = 'none';
    if (logoIcon) logoIcon.style.display = '';
  }
  const cnEl = document.getElementById('ceoCompanyName');
  if (cnEl && s.companyName) cnEl.textContent = s.companyName;

  populateCeoDashboard();

  // כפתור הודעות — מוצג רק למי שמורשה לשלוח/לנהל הודעות
  const annBtn = document.getElementById('ceoAnnBtn');
  if (annBtn) annBtn.style.display = canSendAnnouncement() ? '' : 'none';

  setTimeout(checkBirthdays, 800);
  checkHandoverNeeded();
  setTimeout(checkPendingHandovers, 2500);
}

function exitCeoDashboard() {
  document.getElementById('ceoDashboardScreen').classList.remove('active');
  // Return to module selector (not blank page)
  showModuleSelector();
}

function populateCeoDashboard() {
  const db    = getDB();
  const today = new Date();
  const days  = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const months= ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  // Greeting
  const h = today.getHours();
  const greeting = h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : 'ערב טוב';
  document.getElementById('ceoGreeting').textContent = `${greeting}, ${currentUser.fullName} ☀️`;
  document.getElementById('ceoDate').textContent = `יום ${days[today.getDay()]}, ${today.getDate()} ב${months[today.getMonth()]} ${today.getFullYear()}`;

  // ===== CARD 1: TODAY =====
  const todayStr  = today.toISOString().split('T')[0];
  let offCount=0, wfhCount=0, todayBdays=[];
  const allUsers  = Object.values(db.users).filter(u => isUserActive(u) && u.role !== 'admin');
  allUsers.forEach(u => {
    const vacs = getVacations(u.username);
    const type = vacs[todayStr];
    if (type === 'full' || type === 'half') offCount++;
    if (type === 'wfh') wfhCount++;
    if (u.birthday) {
      const parts = u.birthday.split('-');
      if (parts.length===3) {
        const mm = String(today.getMonth()+1).padStart(2,'0');
        const dd = String(today.getDate()).padStart(2,'0');
        if (`${parts[1]}-${parts[2]}` === `${mm}-${dd}`) todayBdays.push(u.fullName);
      }
    }
  });
  const pendingCount = (db.approvalRequests||[]).filter(r=>r.status==='pending').length;
  let todayText = `👤 ${allUsers.length} עובדים פעילים\n🏖️ ${offCount} בחופשה היום • 🏠 ${wfhCount} מהבית`;
  if (todayBdays.length) todayText += `\n🎂 יום הולדת: ${todayBdays.join(' + ')}`;
  if (pendingCount) todayText += `\n⏳ ${pendingCount} בקשות ממתינות לאישור`;
  document.getElementById('ceoTodayText').style.whiteSpace = 'pre-line';
  document.getElementById('ceoTodayText').textContent = todayText;
  // Update pending button
  document.getElementById('ceoPendingBtn').textContent = `⏳ בקשות ממתינות (${pendingCount})`;

  // Announcement ack summary in today card
  const latestAnn = (db.announcements||[])[0];
  if (latestAnn && latestAnn.acks) {
    const totalEmp = allUsers.length;
    const ackCount = Object.keys(latestAnn.acks).length;
    todayText += `\n📢 הודעה אחרונה: ${ackCount}/${totalEmp} אישרו קריאה`;
  }

  document.getElementById('ceoTodayText').textContent = todayText;
  // Check next 7 days dept load
  let riskLines = [];
  const depts = db.departments || [];
  depts.forEach(dept => {
    const deptUsers = allUsers.filter(u => {
      const d = Array.isArray(u.dept) ? u.dept : [u.dept||''];
      return d.includes(dept);
    });
    if (deptUsers.length < 2) return;
    let busyNext7 = 0;
    for (let i=0; i<7; i++) {
      const d = new Date(today); d.setDate(d.getDate()+i);
      const ds = d.toISOString().split('T')[0];
      deptUsers.forEach(u => {
        const t = getVacations(u.username)[ds];
        if (t === 'full' || t === 'half' || t === 'wfh') busyNext7++;
      });
    }
    const avgPerDay = busyNext7 / 7;
    const pct = Math.round((avgPerDay / deptUsers.length) * 100);
    if (pct >= 30) riskLines.push({ dept, pct, size: deptUsers.length });
  });
  riskLines.sort((a,b) => b.pct - a.pct);
  if (riskLines.length) {
    const top = riskLines[0];
    document.getElementById('ceoRiskText').style.whiteSpace = 'pre-line';
    document.getElementById('ceoRiskText').textContent =
      `⚠️ ${top.dept}: ${top.pct}% מהצוות (${top.size} עובדים) בחופש/WFH שבוע הבא\n💡 המלצה: בדוק פרויקטים קריטיים ושקול דחיית אישורים`
      + (riskLines.length>1 ? `\n+ ${riskLines.length-1} מחלקות נוספות בסיכון בינוני` : '');
  } else {
    document.getElementById('ceoRiskText').textContent = '✅ אין סיכון משמעותי השבוע — הצוות זמין!';
  }

  // ===== CARD 3: COST =====
  const curMonth = today.getMonth()+1;
  const curYear  = today.getFullYear();
  let vacCost = 0, wfhDays = 0, vacDays = 0;
  allUsers.forEach(u => {
    const dailySalary = u.dailySalary || 850; // fallback to average
    const vacs = getVacations(u.username);
    Object.entries(vacs).forEach(([dt, type]) => {
      if (!dt.startsWith(`${curYear}-${String(curMonth).padStart(2,'0')}`)) return;
      if (type === 'full')       { vacDays++; vacCost += dailySalary; }
      else if (type === 'half')  { vacDays += 0.5; vacCost += dailySalary * 0.5; }
      else if (type === 'wfh')   { wfhDays++; }
    });
  });
  const wfhSave = Math.round(wfhDays * 850 * 0.3);
  document.getElementById('ceoCostText').textContent =
    `📅 חופשות: ${vacDays} ימים — עלות ₪${Math.round(vacCost).toLocaleString()}\n🏠 WFH: ${wfhDays} ימים — חיסכון משוער ₪${wfhSave.toLocaleString()}\n💡 מבוסס על שכר יומי אישי לכל עובד`;

  // ===== CARD 4: BURNOUT =====
  const ninetyDaysAgo = new Date(today); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate()-90);
  const burnoutRisk = allUsers.filter(u => {
    const vacs = getVacations(u.username);
    const vacLast90 = Object.entries(vacs).filter(([dt]) => new Date(dt) >= ninetyDaysAgo).length;
    return vacLast90 === 0;
  });
  document.getElementById('ceoBurnoutText').style.whiteSpace = 'pre-line';
  if (burnoutRisk.length) {
    const names = burnoutRisk.slice(0,3).map(u=>u.fullName).join(', ');
    document.getElementById('ceoBurnoutText').textContent =
      `🚨 ${burnoutRisk.length} עובדים ללא חופשה ב-90 יום האחרונים:\n${names}${burnoutRisk.length>3?' ועוד...':''}\n💡 שקול שיחה אישית או חופשה כפויה`;
  } else {
    document.getElementById('ceoBurnoutText').textContent = '✅ כל העובדים לקחו חופשה ב-90 הימים האחרונים';
  }
}

function openCeoDayView() {
  const db    = getDB();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const months= ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  document.getElementById('ceoDayTitle').textContent = `${today.getDate()} ${months[today.getMonth()]}`;

  const allUsers = Object.values(db.users).filter(u => isUserActive(u) && u.role !== 'admin');
  const off=[], wfh=[], present=[];
  allUsers.forEach(u => {
    const t = getVacations(u.username)[todayStr];
    const dept = Array.isArray(u.dept)?u.dept[0]:u.dept||'';
    if (t==='full'||t==='half') off.push({...u,dept});
    else if (t==='wfh')          wfh.push({...u,dept});
    else                         present.push({...u,dept});
  });

  const section = (title, icon, color, users) => users.length ? `
    <div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:13px;color:${color};margin-bottom:8px;">${icon} ${title} (${users.length})</div>
      ${users.map(u=>`<div style="display:flex;justify-content:space-between;padding:8px 10px;background:var(--surface2);border-radius:8px;margin-bottom:4px;font-size:13px;">
        <span style="font-weight:600;">${u.fullName}</span>
        <span style="color:var(--text-muted);">${u.dept}</span>
      </div>`).join('')}
    </div>` : '';

  document.getElementById('ceoDayBody').innerHTML =
    section('בחופשה','🏖️','var(--danger)',off) +
    section('עבודה מהבית','🏠','var(--primary)',wfh) +
    section('במשרד','✅','var(--success)',present) ||
    '<div style="color:var(--text-muted);text-align:center;padding:24px;">אין נתונים להיום</div>';

  openModal('ceoDayModal');
}

function canSendAnnouncement() {
  if (!currentUser) return false;
  if (currentUser.role === 'admin' || currentUser.username === CEO_USERNAME) return true;
  const perms = getUserPermissions(currentUser.username);
  return perms['canSendAnnouncements'] === true;
}

function openCeoMessage() {
  if (!canSendAnnouncement()) { showToast('⛔ אין הרשאה לשלוח הודעות', 'error'); return; }
  document.getElementById('ceoMessageText').value = '';
  openModal('ceoMessageModal');
}

function sendCeoMessage() {
  const text = document.getElementById('ceoMessageText').value.trim();
  if (!text) { showToast('נא לכתוב הודעה', 'warning'); return; }
  const db = getDB();
  if (!db.announcements) db.announcements = [];
  const ann = {
    id: Date.now().toString(),
    from: currentUser.fullName,
    fromUsername: currentUser.username,
    text,
    ts: new Date().toISOString(),
    acks: {}  // { username: timestamp }
  };
  db.announcements.unshift(ann);
  saveDB(db);
  closeModal('ceoMessageModal');
  showToast('📢 ההודעה נשלחה לכל הצוות', 'success');
  auditLog('announcement_sent', `${currentUser.fullName} שלח הודעה: ${text.substring(0,50)}`);
}

// ===== HANDOVER PROTOCOL =====
let _lastKnownPending = null;
let _handoverPopupOpen = false;

function checkHandoverNeeded() {
  if (!currentUser) return;
  if (currentUser.role === 'manager' || currentUser.role === 'admin' || currentUser.role === 'accountant') return;
  if (_handoverPopupOpen) return;

  const db = getDB();
  const pending = db.handoverPending && db.handoverPending[currentUser.username];
  if (!pending || pending.submitted) return;

  // עדכן _lastKnownPending כדי שהפולר לא יפתח שוב
  _lastKnownPending = pending;

  // עדכן הודעת הפופאפ
  const msgEl = document.getElementById('handoverAlertMsg');
  if (msgEl && pending.firstDate) {
    const dateHeb = new Date(pending.firstDate + 'T00:00:00').toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long' });
    msgEl.textContent = `⏰ החופשה שלך (${dateHeb}) אושרה! לפני שתצא — שתף את הצוות במה שחשוב.`;
  }

  _handoverPopupOpen = true;
  const delay = /iPhone|iPad|Android/i.test(navigator.userAgent) ? 1800 : 900;
  setTimeout(() => {
    openModal('handoverModal');
    setTimeout(() => { _handoverPopupOpen = false; }, 600);
  }, delay);
}

// פולר — בודק כל 6 שניות אם הגיע handoverPending חדש (לאחר אישור מנהל)
let _handoverPollInterval = null;
function startHandoverPoller() {
  if (_handoverPollInterval) clearInterval(_handoverPollInterval);
  _handoverPollInterval = setInterval(() => {
    if (!currentUser || currentUser.role === 'manager' || currentUser.role === 'admin') return;
    const db = getDB();
    const pending = db.handoverPending?.[currentUser.username];
    if (!pending || pending.submitted) return;
    // אם הגיע pending חדש שעוד לא הוצג — פתח פופאפ
    const prevAt = _lastKnownPending?.approvedAt;
    if (pending.approvedAt !== prevAt) {
      _lastKnownPending = pending;
      _handoverPopupOpen = false; // אפס כדי לאפשר פתיחה
      checkHandoverNeeded();
    }
  }, 6000);
}

function saveHandover() {
  const t1 = document.getElementById('handover1').value.trim();
  const t2 = document.getElementById('handover2').value.trim();
  const t3 = document.getElementById('handover3').value.trim();
  const contact = document.getElementById('handoverContact').value.trim();
  const tasks = [t1,t2,t3].filter(Boolean);
  if (!tasks.length) { showToast('נא להזין לפחות משימה אחת', 'warning'); return; }

  const db = getDB();
  if (!db.handovers)        db.handovers = {};
  if (!db.handoversArchive) db.handoversArchive = {};

  // קבל תאריכי החופשה מה-handoverPending (לא בהכרח מחר)
  const pending = db.handoverPending && db.handoverPending[currentUser.username];
  const vacDates = pending?.dates || [];
  const firstDate = pending?.firstDate || (() => {
    const t = new Date(); t.setDate(t.getDate()+1); return t.toISOString().split('T')[0];
  })();
  const managerUsername = pending?.managerUsername || getDeptManagerForUser(currentUser.username);
  const managerUser = managerUsername ? db.users[managerUsername] : null;
  const managerName = managerUser?.fullName || 'המנהל';

  const dateHeb = new Date(firstDate + 'T00:00:00').toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const key = currentUser.username + '_' + firstDate;

  const record = {
    user: currentUser.username,
    fullName: currentUser.fullName,
    date: firstDate,
    dates: vacDates,
    tasks,
    contact,
    managerUsername,
    seenByManager: false,
    createdAt: new Date().toISOString()
  };

  // שמור לתצוגת מנהל (ניתן למחיקה ע"י מנהל — רק מהתצוגה)
  db.handovers[key] = record;

  // שמור archive לצמיתות — משמש ל-AI ולדוח האישי, לא נמחק לעולם
  db.handoversArchive[key] = { ...record, archivedAt: new Date().toISOString() };

  // סמן בקשה כ-"פרוטוקול הוגש" ונסה popupShown (לא יוצג שוב)
  if (db.handoverPending && db.handoverPending[currentUser.username]) {
    db.handoverPending[currentUser.username].submitted = true;
    db.handoverPending[currentUser.username].submittedAt = new Date().toISOString();
  }

  saveDB(db);
  closeModal('handoverModal');
  auditLog('handover', `${currentUser.fullName} הגיש פרוטוקול העברת מקל ל-${firstDate}`);
  showToast(`✅ פרוטוקול נשמר — ${managerName} יקבל התראה`, 'success');

  // רענן דוח אישי אם פתוח
  if (document.getElementById('tab-report')?.classList.contains('active')) renderReport();
}

// ── Show pending handovers to manager on login ──────────────────
function checkPendingHandovers() {
  if (!currentUser) return;
  if (currentUser.role !== 'manager' && currentUser.role !== 'admin' && !isUserDeptManager(currentUser.username)) return;
  const db = getDB();
  const handovers = db.handovers || {};

  // כל הפרוטוקולים שנשלחו למנהל זה ועדיין לא נראו (ללא סינון תאריך)
  const mine = Object.values(handovers).filter(h =>
    h.managerUsername === currentUser.username &&
    !h.seenByManager
  );

  if (!mine.length) return;

  // Mark all as seen
  mine.forEach(h => {
    const key = h.user + '_' + h.date;
    if (db.handovers[key]) db.handovers[key].seenByManager = true;
  });
  saveDB(db);

  // Build popup content
  let html = '';
  mine.forEach(h => {
    const dateHeb = new Date(h.date).toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long' });
    html += `<div style="background:var(--surface2);border-radius:12px;padding:14px;margin-bottom:12px;border-right:4px solid var(--primary);">`;
    html += `<div style="font-weight:800;font-size:15px;margin-bottom:6px;">👤 ${h.fullName} — ${dateHeb}</div>`;
    h.tasks.forEach((t,i) => {
      html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">${i+1}. ${t}</div>`;
    });
    if (h.contact) html += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">📞 מחליף: ${h.contact}</div>`;
    html += `</div>`;
  });

  // Show in a modal
  showHandoverNotificationModal(html, mine.length);
}

function showHandoverNotificationModal(html, count) {
  const existing = document.getElementById('handoverNotifModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'handoverNotifModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px;">
      <div style="text-align:center;font-size:36px;margin-bottom:6px;">📋</div>
      <div class="modal-title" style="justify-content:center;text-align:center;">
        פרוטוקולי העברת מקל
        <span style="background:var(--primary);color:white;border-radius:20px;padding:2px 10px;font-size:13px;margin-right:8px;">${count}</span>
      </div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;text-align:center;">
        ${count === 1 ? 'עובד אחד שלח פרוטוקול' : count + ' עובדים שלחו פרוטוקולים'} — הפרטים בלוח המנהל
      </div>
      <div id="handoverNotifBody" style="max-height:44vh;overflow-y:auto;margin-bottom:4px;"></div>
      <div class="modal-footer" style="justify-content:center;gap:10px;">
        <button class="btn btn-outline" onclick="closeModal('handoverNotifModal')">סגור</button>
        <button class="btn btn-primary" onclick="closeModal('handoverNotifModal');showTab('manager');setTimeout(()=>{ const s=document.getElementById('handoverSection');if(s)s.scrollIntoView({behavior:'smooth'}); },400);">📋 לוח מנהל ←</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
  document.getElementById('handoverNotifBody').innerHTML =
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">יש לך ${count} פרוטוקול${count>1?'ות':''} ממתין${count>1?'ים':''} לעיון:</div>` + html;
  setTimeout(() => openModal('handoverNotifModal'), 1800);
}


// ============================================================
// ============================================================
// 🤒 SICK DAY SYSTEM
// ============================================================
let _currentDayModalDate = null;

function toggleSickMode(checked) {
  const track = document.getElementById('sickToggleTrack');
  const thumb = document.getElementById('sickToggleThumb');
  const normalOpts = document.getElementById('dayModalOptions');
  const sickOpts   = document.getElementById('sickModeOptions');
  if (checked) {
    track.style.background = '#ef4444';
    thumb.style.left = '25px';
    normalOpts.style.display = 'none';
    sickOpts.style.display   = 'flex';
    sickOpts.innerHTML = `
      <button onclick="saveSickDay('${_currentDayModalDate}','full')" style="background:#fef2f2;border:2px solid #ef4444;border-radius:12px;padding:14px 18px;font-size:14px;font-weight:700;color:#991b1b;cursor:pointer;font-family:'Heebo',sans-serif;text-align:right;">
        🤒 יום מחלה מלא
      </button>
      <button onclick="saveSickDay('${_currentDayModalDate}','half')" style="background:#fef2f2;border:2px solid #f87171;border-radius:12px;padding:14px 18px;font-size:14px;font-weight:700;color:#991b1b;cursor:pointer;font-family:'Heebo',sans-serif;text-align:right;">
        🤒 חצי יום מחלה
      </button>`;
  } else {
    track.style.background = '#e5e7eb';
    thumb.style.left = '3px';
    normalOpts.style.display = 'flex';
    sickOpts.style.display   = 'none';
  }
}

function saveSickDay(dateStr, type) {
  const db = getDB();
  if (!db.sick) db.sick = {};
  db.sick[currentUser.username + '_' + dateStr] = {
    username: currentUser.username,
    fullName: currentUser.fullName,
    dept: Array.isArray(currentUser.dept) ? currentUser.dept[0] : (currentUser.dept || ''),
    date: dateStr, type,
    reportedAt: new Date().toISOString()
  };
  saveDB(db);
  closeModal('dayModal');
  renderCalendar();
  showToast('🤒 דיווח מחלה נשמר', 'info');
  auditLog('sick_report', `${currentUser.fullName} דיווח מחלה ל-${dateStr}`);
  updateSickCount();
}

function reportSickToday() {
  const today = new Date().toISOString().split('T')[0];
  const db = getDB();
  if (!db.sick) db.sick = {};
  const key = currentUser.username + '_' + today;
  if (db.sick[key]) { showToast('כבר דיווחת מחלה היום', 'info'); return; }
  db.sick[key] = {
    username: currentUser.username, fullName: currentUser.fullName,
    dept: Array.isArray(currentUser.dept) ? currentUser.dept[0] : (currentUser.dept || ''),
    date: today, type: 'full', reportedAt: new Date().toISOString()
  };
  saveDB(db);
  closeModal('sickTodayModal');
  showToast('🤒 דיווח מחלה נשמר', 'info');
  auditLog('sick_report', `${currentUser.fullName} דיווח מחלה להיום`);
  updateSickCount();
}

function openSickTodayFromSelector() {
  const today = new Date().toISOString().split('T')[0];
  const db = getDB();
  const sick = Object.values(db.sick || {}).filter(s => s.date === today);
  const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const d = new Date();
  document.getElementById('sickTodayDate').textContent = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  const list = document.getElementById('sickTodayList');
  if (!sick.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;">✅ אין דיווחי מחלה להיום</div>';
  } else {
    list.innerHTML = sick.map(s => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#fef2f2;border-radius:10px;margin-bottom:6px;border:1px solid #fca5a5;">
        <div>
          <div style="font-weight:700;font-size:13px;">🤒 ${s.fullName}</div>
          <div style="font-size:11px;color:var(--text-muted);">${s.dept} · ${s.type === 'full' ? 'יום מלא' : 'חצי יום'}</div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);">${new Date(s.reportedAt).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}</div>
      </div>`).join('');
  }
  openModal('sickTodayModal');
}

function updateSickCount() {
  const today = new Date().toISOString().split('T')[0];
  const db = getDB();
  const cnt = Object.values(db.sick || {}).filter(s => s.date === today).length;
  const el = document.getElementById('sickTodayModuleCount');
  if (el) el.textContent = cnt > 0 ? `🤒 ${cnt} עובד${cnt > 1 ? 'ים' : ''} חולה${cnt > 1 ? 'ים' : ''} היום` : 'לחץ לצפייה ודיווח מחלה';
}

// ============================================================
// 📍 DAILY STATUS (אני היום)
// ============================================================
function reportDailyStatus(status) {
  const today = new Date().toISOString().split('T')[0];
  const db = getDB();
  if (!db.dailyStatus) db.dailyStatus = {};
  const key = `${currentUser.username}_${today}`;
  db.dailyStatus[key] = { status, username: currentUser.username, date: today, updatedAt: new Date().toISOString() };
  saveDB(db);
  loadDailyStatusWidget();
  const labels = { office:'🏢 במשרד', home:'🏠 מהבית', out:'🚗 בחוץ' };
  showToast(`✅ ${labels[status]} — הסטטוס עודכן`, 'success');
}

function loadDailyStatusWidget() {
  const today = new Date().toISOString().split('T')[0];
  const db = getDB();
  const key = `${currentUser?.username}_${today}`;
  const current = db.dailyStatus?.[key]?.status;
  const colors = { office:'#16a34a', home:'#7c3aed', out:'#ea580c' };
  ['office','home','out'].forEach(s => {
    const btn = document.getElementById(`dsBtn_${s}`);
    if (!btn) return;
    if (s === current) {
      btn.style.background = colors[s];
      btn.style.borderColor = colors[s];
      btn.style.color = 'white';
      btn.style.transform = 'scale(1.04)';
    } else {
      btn.style.background = 'white';
      btn.style.borderColor = 'var(--border)';
      btn.style.color = 'var(--text)';
      btn.style.transform = '';
    }
  });
}
function openWhereIsEmployee() {
  document.getElementById('whereIsSearch').value = '';
  document.getElementById('whereIsResults').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">הקלד לפחות 2 תווים לחיפוש...</div>';
  openModal('whereIsModal');
  setTimeout(() => document.getElementById('whereIsSearch').focus(), 200);
}

function getEmployeeStatusToday(username) {
  const db    = getDB();
  const today = new Date().toISOString().split('T')[0];

  // 1. Check sick
  if (db.sick && db.sick[`${username}_${today}`]) {
    const s = db.sick[`${username}_${today}`];
    return { status: 'sick', label: s.type === 'half' ? '🤒 חצי יום מחלה' : '🤒 חולה היום', color: '#ef4444', bg: '#fef2f2' };
  }

  // 2. Check vacation
  if (db.vacations && db.vacations[username]) {
    const v = db.vacations[username][today];
    if (v) {
      if (v === 'wfh')  return { status: 'wfh',      label: '🏠 עובד מהבית',    color: '#7c3aed', bg: '#f5f3ff' };
      if (v === 'half') return { status: 'half',     label: '🌗 חצי יום חופש',  color: '#f59e0b', bg: '#fffbeb' };
      if (v === 'full') return { status: 'vacation', label: '🏖️ בחופשה היום',   color: '#1d4ed8', bg: '#eff6ff' };
    }
  }

  // 3. Check daily status (user self-report)
  const dailyKey = `${username}_${today}`;
  if (db.dailyStatus && db.dailyStatus[dailyKey]) {
    const ds = db.dailyStatus[dailyKey];
    const map = {
      office: { label: '🏢 במשרד',        color: '#16a34a', bg: '#f0fdf4' },
      home:   { label: '🏠 עובד מהבית',   color: '#7c3aed', bg: '#f5f3ff' },
      out:    { label: '🚗 מחוץ למשרד',   color: '#ea580c', bg: '#fff7ed' },
    };
    return map[ds.status] || { label: ds.status, color: '#6b7280', bg: '#f9fafb' };
  }

  return { status: 'unknown', label: '❓ אין מידע להיום', color: '#9ca3af', bg: '#f9fafb' };
}

function renderWhereIsResults() {
  const query = (document.getElementById('whereIsSearch').value || '').trim().toLowerCase();
  const container = document.getElementById('whereIsResults');

  // Show nothing until user types
  if (query.length < 2) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">הקלד לפחות 2 תווים לחיפוש...</div>';
    return;
  }

  const db = getDB();
  const users = Object.values(db.users).filter(u =>
    u.role !== 'admin' && isUserActive(u) &&
    (u.fullName.toLowerCase().includes(query) ||
     u.username.toLowerCase().includes(query) ||
     u.fullName.toLowerCase().split(' ').some(part => part.includes(query)))
  ).sort((a,b) => a.fullName.localeCompare(b.fullName));

  if (!users.length) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">לא נמצאו עובדים תואמים</div>';
    return;
  }

  container.innerHTML = users.map(u => {
    const s = getEmployeeStatusToday(u.username);
    const dept = getUserDept(u) || '';
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:${s.bg};border-radius:12px;border:1px solid ${s.color}22;">
      <div style="width:38px;height:38px;border-radius:50%;background:${s.color}22;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">${s.label.split(' ')[0]}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:14px;color:var(--text);">${u.fullName}</div>
        <div style="font-size:11px;color:var(--text-muted);">${dept}</div>
      </div>
      <div style="font-size:12px;font-weight:700;color:${s.color};white-space:nowrap;">${s.label.split(' ').slice(1).join(' ')}</div>
    </div>`;
  }).join('');
}

// ============================================================
// 📢 CEO ANNOUNCEMENTS MANAGEMENT
// ============================================================
function openCeoAnnouncementsModal() {
  if (!canSendAnnouncement()) { showToast('⛔ אין הרשאה לצפות בהודעות', 'error'); return; }
  const db = getDB();
  const allUsers = Object.values(db.users).filter(u => isUserActive(u) && u.role !== 'admin');
  const ann = db.announcements || [];
  const list = document.getElementById('ceoAnnouncementsList');
  if (!ann.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;">אין הודעות עדיין</div>';
  } else {
    list.innerHTML = ann.map(a => {
      const d = new Date(a.ts);
      const dateStr = `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const ackCount = Object.keys(a.acks || {}).length;
      const total    = allUsers.length;
      const pct      = total > 0 ? Math.round(ackCount / total * 100) : 0;
      return `
        <div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">
            <div style="font-size:13px;font-weight:700;color:var(--text);flex:1;">${a.text}</div>
            <button onclick="deleteAnnouncement('${a.id}')" style="background:var(--danger-light);color:var(--danger);border:none;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;white-space:nowrap;">🗑️ מחק</button>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">מאת: ${a.from} · ${dateStr}</div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
            <div style="font-size:12px;font-weight:700;margin-bottom:4px;">אישורי קריאה: ${ackCount}/${total} (${pct}%)</div>
            <div style="background:#e5e7eb;border-radius:4px;height:6px;overflow:hidden;">
              <div style="background:var(--success);height:100%;width:${pct}%;transition:width 0.5s;border-radius:4px;"></div>
            </div>
          </div>
        </div>`;
    }).join('');
  }
  openModal('ceoAnnouncementsModal');
}

function deleteAnnouncement(id) {
  if (!canSendAnnouncement()) { showToast('⛔ אין הרשאה למחוק הודעות', 'error'); return; }
  if (!confirm('למחוק הודעה זו?')) return;
  const db = getDB();
  db.announcements = (db.announcements || []).filter(a => a.id !== id);
  saveDB(db);
  openCeoAnnouncementsModal();
  showToast('🗑️ ההודעה נמחקה', 'info');
}

// ============================================================
function checkBirthdays() {
  // Show once per user per calendar day
  const today = new Date().toISOString().split('T')[0];
  const username = currentUser ? currentUser.username : 'guest';
  const key = `birthdayShown_${username}_${today}`;
  if (localStorage.getItem(key)) return;

  const db  = getDB();
  const mm  = String(new Date().getMonth() + 1).padStart(2, '0');
  const dd  = String(new Date().getDate()).padStart(2, '0');
  const todayMD = `${mm}-${dd}`;

  const celebrants = Object.values(db.users).filter(u => {
    if (!u.birthday || !isUserActive(u)) return false;
    const parts = u.birthday.split('-');
    if (parts.length < 3) return false;
    return `${parts[1]}-${parts[2]}` === todayMD;
  });

  if (!celebrants.length) return;
  const names = celebrants.map(u => u.fullName).join('\n');
  document.getElementById('birthdayNames').textContent = names;
  const emojis = ['🎂','🎉','🥳','🎈','🎊'];
  document.getElementById('birthdayEmoji').textContent = emojis[Math.floor(Math.random() * emojis.length)];
  document.getElementById('birthdayPopup').style.display = 'flex';
  localStorage.setItem(key, '1');
  startConfetti();
}

function closeBirthdayPopup() {
  document.getElementById('birthdayPopup').style.display = 'none';
  stopConfetti();
}

let _confettiInterval = null;
function startConfetti() {
  const canvas  = document.getElementById('birthdayCanvas');
  if (!canvas) return;
  const ctx     = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  const particles = Array.from({length: 60}, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height - canvas.height,
    r: Math.random() * 6 + 2,
    d: Math.random() * 3 + 1,
    color: `hsl(${Math.random()*360},80%,60%)`,
    tiltAngle: 0
  }));
  _confettiInterval = setInterval(() => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.tiltAngle += 0.1;
      p.y += p.d;
      p.x += Math.sin(p.tiltAngle) * 1.5;
      if (p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; }
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.ellipse(p.x, p.y, p.r, p.r/2, Math.sin(p.tiltAngle)*0.3, 0, Math.PI*2);
      ctx.fill();
    });
  }, 30);
}

function stopConfetti() {
  if (_confettiInterval) { clearInterval(_confettiInterval); _confettiInterval = null; }
  const canvas = document.getElementById('birthdayCanvas');
  if (canvas) canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
}

// ============================================================
// 🗑️ CLEAR AUDIT LOG (Admin only)
// ============================================================
function clearAuditLog() {
  if (currentUser?.role !== 'admin') return;
  if (!confirm('למחוק את כל יומן השינויים? פעולה זו בלתי הפיכה.')) return;
  const db = getDB();
  db.auditLog = [];
  saveDB(db);
  renderAuditLog();
  showToast('🗑️ יומן השינויים נמחק', 'info');
}

// ============================================================
// 🔐 FIREBASE AUTH — Password Reset (replaces all manual steps)
// ============================================================
async function ensureFirebaseAuth() {
  // Always ensure firebase-app is loaded first
  if (!window.firebase) {
    await loadScript('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
  }
  // Always ensure firebase-auth is loaded (separate from firestore)
  if (!firebase.auth) {
    await loadScript('https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js');
  }
  if (!firebase.apps?.length) firebase.initializeApp(FIREBASE_CONFIG);
  return firebase.auth();
}

async function sendFirebasePasswordReset(email) {
  try {
    const auth = await ensureFirebaseAuth();
    await auth.sendPasswordResetEmail(email);
    return { success: true };
  } catch(err) {
    return { success: false, error: err.code };
  }
}

async function createFirebaseAuthUser(email, password) {
  try {
    const auth = await ensureFirebaseAuth();
    await auth.createUserWithEmailAndPassword(email, password);
    return { success: true };
  } catch(err) {
    if (err.code === 'auth/email-already-in-use') return { success: true, existing: true };
    return { success: false, error: err.message };
  }
}

// ============================================================
function openBulkImportModal() {
  _bulkImportData = [];
  document.getElementById('bulkImportPreview').style.display = 'none';
  document.getElementById('bulkImportBtn').style.display = 'none';
  document.getElementById('bulkExcelFile').value = '';
  openModal('bulkImportModal');
  // Load saved temp password and show it in modal
  const saved = getSettings().tempPassword || 'Welcome1';
  const tp = document.getElementById('tempPasswordSetting');
  if (tp) tp.value = saved;
  // Update password display inside modal
  const modalPassEl = document.getElementById('bulkModalTempPass');
  if (modalPassEl) modalPassEl.textContent = saved;
}

function handleBulkDrop(e) {
  e.preventDefault();
  document.getElementById('bulkDropZone').style.borderColor = 'var(--border)';
  const file = e.dataTransfer.files[0];
  if (file) parseBulkFile(file);
}

function handleBulkImportFile(input) {
  const file = input.files[0];
  if (file) parseBulkFile(file);
}

async function parseBulkFile(file) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type: 'binary' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) { showToast('⚠️ הקובץ ריק או לא תקין', 'warning'); return; }

      const db     = getDB();
      const depts  = db.departments || [];
      const parsed = [];
      const errors = [];

      rows.slice(1).forEach((row, i) => {
        if (!row || row.every(c => !String(c).trim())) return;
        const firstName   = String(row[0] || '').trim();
        const lastName    = String(row[1] || '').trim();
        const deptRaw     = String(row[2] || '').trim();
        const email       = String(row[3] || '').trim();
        const annualRaw   = row[4];
        const balanceRaw  = row[5];
        const salaryRaw   = row[6];
        const birthdayRaw = String(row[7] || '').trim();

        if (!firstName || !lastName) {
          errors.push(`שורה ${i+2}: חסר שם פרטי או משפחה`);
          return;
        }

        const dept    = depts.find(d => d === deptRaw) || (deptRaw || 'כללי');
        const annual  = (annualRaw !== '' && !isNaN(Number(annualRaw))) ? Number(annualRaw) : null;
        const balance = (balanceRaw !== '' && !isNaN(Number(balanceRaw))) ? Number(balanceRaw) : null;
        const salary  = (salaryRaw !== '' && !isNaN(Number(salaryRaw))) ? Number(salaryRaw) : null;
        // Support DD/MM/YYYY or YYYY-MM-DD
        let birthday = '';
        if (birthdayRaw) {
          if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(birthdayRaw)) {
            const [d,m,y] = birthdayRaw.split('/');
            birthday = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw)) {
            birthday = birthdayRaw;
          }
        }

        // Check if user already exists by full name match
        const existingUser = Object.values(db.users).find(u =>
          u.fullName === `${firstName} ${lastName}`
        );

        let username;
        let isUpdate = false;
        if (existingUser) {
          username = existingUser.username;
          isUpdate = true;
        } else {
          let base = hebrewToLatin(firstName + lastName).toLowerCase().replace(/[^a-z0-9]/g,'');
          if (!base) base = `user${Date.now()}`;
          username = base;
          let counter = 2;
          while (db.users[username] || parsed.find(p => p.username === username)) {
            username = base + counter++;
          }
        }

        const fullName = `${firstName} ${lastName}`;
        parsed.push({ firstName, lastName, fullName, username, dept, email, annual, balance, salary, birthday, isUpdate, status: 'ok' });
      });

      _bulkImportData = parsed;

      const previewEl = document.getElementById('bulkImportPreview');
      const summaryEl = document.getElementById('bulkImportSummary');
      const tableEl   = document.getElementById('bulkImportTable');
      previewEl.style.display = '';

      const newCount    = parsed.filter(p => !p.isUpdate).length;
      const updateCount = parsed.filter(p => p.isUpdate).length;
      summaryEl.innerHTML =
        `<span style="color:var(--success);">✅ ${newCount} עובדים חדשים</span>` +
        (updateCount ? `<span style="color:var(--primary);margin-right:12px;">🔄 ${updateCount} יעודכנו</span>` : '') +
        (errors.length ? `<span style="color:var(--danger);margin-right:12px;">⚠️ ${errors.length} שגיאות</span>` : '');

      const year = new Date().getFullYear();
      tableEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:var(--surface2);">
            <th style="padding:6px 8px;text-align:right;">שם מלא</th>
            <th style="padding:6px 8px;text-align:right;">משתמש</th>
            <th style="padding:6px 8px;text-align:right;">מחלקה</th>
            <th style="padding:6px 8px;text-align:center;">מכסה ${year}</th>
            <th style="padding:6px 8px;text-align:center;">יתרה</th>
            <th style="padding:6px 8px;text-align:center;">שכר יומי</th>
            <th style="padding:6px 8px;text-align:center;">יום הולדת</th>
            <th style="padding:6px 8px;text-align:center;">סטטוס</th>
          </tr></thead>
          <tbody>
            ${parsed.map(p => `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 8px;font-weight:600;">${p.fullName}</td>
              <td style="padding:6px 8px;color:var(--primary);direction:ltr;">${p.username}</td>
              <td style="padding:6px 8px;">${p.dept}</td>
              <td style="padding:6px 8px;text-align:center;">${p.annual !== null ? p.annual : '—'}</td>
              <td style="padding:6px 8px;text-align:center;">${p.balance !== null ? p.balance : '—'}</td>
              <td style="padding:6px 8px;text-align:center;">${p.salary !== null ? '₪' + p.salary : '—'}</td>
              <td style="padding:6px 8px;text-align:center;">${p.birthday ? p.birthday.split('-').reverse().join('/') : '—'}</td>
              <td style="padding:6px 8px;text-align:center;">${p.isUpdate
                ? '<span style="color:var(--primary);font-size:11px;">🔄 עדכון</span>'
                : '<span style="color:var(--success);font-size:11px;">✨ חדש</span>'}</td>
            </tr>`).join('')}
            ${errors.map(e => `<tr style="background:var(--danger-light);"><td colspan="6" style="padding:6px 8px;color:var(--danger);font-size:11px;">${e}</td></tr>`).join('')}
          </tbody>
        </table>`;

      document.getElementById('bulkImportBtn').style.display = parsed.length ? '' : 'none';
    } catch(err) {
      showToast('❌ שגיאה בקריאת הקובץ: ' + err.message, 'error');
    }
  };
  reader.readAsBinaryString(file);
}

function applyBulkImport() {
  if (!_bulkImportData.length) return;

  // Read temp password directly from the field
  const tpField  = document.getElementById('tempPasswordSetting');
  const tempPass = (tpField && tpField.value.trim()) ? tpField.value.trim()
                   : (getSettings().tempPassword || 'Welcome1');

  // *** Pause real-time listener so it doesn't overwrite our save ***
  if (_fbUnsubscribe) { _fbUnsubscribe(); _fbUnsubscribe = null; }

  const db   = getDB();
  const year = new Date().getFullYear();

  // Persist the temp password
  if (!db.settings) db.settings = {};
  db.settings.tempPassword = tempPass;

  let added = 0, updated = 0;
  const hashedPass = hashPass(tempPass);

  _bulkImportData.forEach(p => {
    if (p.isUpdate) {
      const u = db.users[p.username];
      if (!u) return;
      if (!u.quotas) u.quotas = {};
      if (!u.quotas[year]) u.quotas[year] = { annual: 0, initialBalance: 0 };
      if (p.annual  !== null) u.quotas[year].annual         = p.annual;
      if (p.balance !== null) u.quotas[year].initialBalance = p.balance;
      if (p.salary  !== null) u.dailySalary                 = p.salary;
      if (p.birthday)         u.birthday                    = p.birthday;
      if (p.email && !u.email) u.email = p.email;
      updated++;
    } else {
      if (db.users[p.username]) return;
      const quotas = { [year]: {
        annual:         p.annual  !== null ? p.annual  : 0,
        initialBalance: p.balance !== null ? p.balance : 0
      }};
      db.users[p.username] = {
        fullName: p.fullName,
        username: p.username,
        password: hashedPass,
        dept: p.dept,
        role: 'employee',
        status: 'active',
        email: p.email || '',
        mustChangePassword: true,
        dailySalary: p.salary !== null ? p.salary : 0,
        birthday: p.birthday || '',
        quotas,
        registeredAt: new Date().toISOString()
      };
      if (!db.departments.includes(p.dept)) db.departments.push(p.dept);
      added++;
    }
  });

  // Save locally first
  _saveDBLocal(db);

  // Push to Firebase and restart listener only after push completes
  if (firebaseConnected && firebaseDB) {
    pushToFirebase().then(() => {
      startRealtimeListener(); // restart listener only after push
    }).catch(err => {
      console.warn('Firebase push error:', err);
      startRealtimeListener();
    });
  }

  closeModal('bulkImportModal');
  const msg = [
    added   ? `✅ נוספו ${added} עובדים`   : '',
    updated ? `🔄 עודכנו ${updated} עובדים` : ''
  ].filter(Boolean).join(' | ');
  showToast(msg + (added ? ` — סיסמה: "${tempPass}"` : ''), 'success', 8000);
  auditLog('bulk_import', `${added} נוספו, ${updated} עודכנו — סיסמה: ${tempPass}`);
  renderAdmin();
  _bulkImportData = [];
}

function deleteImportedEmployees() {
  const db = getDB();
  const users = db.users || {};

  // Count employees eligible for deletion (not admin/accountant/manager roles, not built-in)
  const toDelete = Object.values(users).filter(u =>
    u.username !== 'admin' &&
    u.role !== 'accountant' &&
    u.role !== 'ceo'
  );

  if (!toDelete.length) {
    showToast('⚠️ אין עובדים למחיקה', 'warning');
    return;
  }

  const names = toDelete.slice(0, 5).map(u => u.fullName).join(', ');
  const more  = toDelete.length > 5 ? ` ועוד ${toDelete.length - 5}...` : '';

  if (!confirm(
    `🗑️ מחיקת ${toDelete.length} עובדים\n\n` +
    `${names}${more}\n\n` +
    `⚠️ יימחקו גם:\n• כל ימי החופשה שלהם\n• כל דיווחי השעות שלהם\n• מחלקות שנשארו ריקות\n\n` +
    `פעולה זו בלתי הפיכה. להמשיך?`
  )) return;

  // Delete users
  toDelete.forEach(u => {
    delete db.users[u.username];
    // Delete their vacations
    if (db.vacations) delete db.vacations[u.username];
    // Delete their timeclock records
    if (db.timeClockRecords) delete db.timeClockRecords[u.username];
    if (db.timeclock)        delete db.timeclock[u.username];
    // Delete their sick records
    if (db.sick) {
      db.sick = Object.fromEntries(
        Object.entries(db.sick).filter(([,s]) => s.username !== u.username)
      );
    }
    // Remove from approval requests
    if (db.approvalRequests) {
      db.approvalRequests = db.approvalRequests.filter(r => r.username !== u.username);
    }
    // Remove from dept managers
    if (db.deptManagers) {
      Object.keys(db.deptManagers).forEach(dept => {
        if (db.deptManagers[dept] === u.username) delete db.deptManagers[dept];
      });
    }
  });

  // Remove departments that are now empty
  const remainingDepts = new Set(
    Object.values(db.users)
      .map(u => getUserDept(u))
      .filter(Boolean)
  );
  const deptsBefore = (db.departments || []).length;
  db.departments = (db.departments || []).filter(d => remainingDepts.has(d));
  const deptsRemoved = deptsBefore - db.departments.length;

  saveDB(db);
  auditLog('bulk_delete', `נמחקו ${toDelete.length} עובדים ו-${deptsRemoved} מחלקות`);
  showToast(
    `✅ נמחקו ${toDelete.length} עובדים` + (deptsRemoved ? ` + ${deptsRemoved} מחלקות ריקות` : ''),
    'success', 5000
  );
  renderAdmin();
}

// Hebrew → Latin transliteration for username generation
function hebrewToLatin(str) {
  const map = {
    'א':'a','ב':'b','ג':'g','ד':'d','ה':'h','ו':'v','ז':'z','ח':'ch','ט':'t',
    'י':'y','כ':'k','ך':'k','ל':'l','מ':'m','ם':'m','נ':'n','ן':'n','ס':'s',
    'ע':'a','פ':'p','ף':'f','צ':'tz','ץ':'tz','ק':'k','ר':'r','ש':'sh','ת':'t'
  };
  return str.split('').map(c => map[c] || c).join('');
}

// Save temp password in settings
function saveTempPassword() {
  const val = document.getElementById('tempPasswordSetting')?.value.trim();
  if (!val) { showToast('⚠️ הזן סיסמה זמנית', 'warning'); return; }
  const db = getDB();
  if (!db.settings) db.settings = {};
  db.settings.tempPassword = val;
  saveDB(db);
  showToast('✅ סיסמה זמנית נשמרה', 'success');
}

// ============================================================
// 🔐 FORCE PASSWORD CHANGE (first login)
// ============================================================
function showForcePasswordChange() {
  ['loginScreen','appScreen','moduleSelectorScreen','timeClockScreen'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('forcePasswordScreen').classList.add('active');
  document.getElementById('forcePassNew').value = '';
  document.getElementById('forcePassNew2').value = '';
  document.getElementById('forcePassError').style.display = 'none';
}

function doForcePasswordChange() {
  const pass  = document.getElementById('forcePassNew').value;
  const pass2 = document.getElementById('forcePassNew2').value;
  const errEl = document.getElementById('forcePassError');
  errEl.style.display = 'none';

  if (pass.length < 4) {
    errEl.textContent = 'הסיסמה חייבת להיות לפחות 4 תווים';
    errEl.style.display = 'block'; return;
  }
  if (pass !== pass2) {
    errEl.textContent = 'הסיסמאות אינן תואמות';
    errEl.style.display = 'block'; return;
  }

  const db = getDB();
  const savedUsername = currentUser.username;
  _sha256(pass).then(sha256hash => {
    db.users[savedUsername].password = sha256hash;
    db.users[savedUsername].mustChangePassword = false;
    saveDB(db);
    auditLog('force_pass_change', `${savedUsername} שינה סיסמה זמנית`);
    pushToFirebase();
    currentUser = null;
    document.getElementById('forcePasswordScreen').classList.remove('active');
    showToast('✅ סיסמה עודכנה! התחבר עם הסיסמה החדשה.', 'success');
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('loginUsername').value = savedUsername;
    document.getElementById('loginPassword').value = '';
    try { document.getElementById('loginError').style.display = 'none'; } catch(e) {}
  });
}


// ============================================================
function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-dark') === 'true';
  const newVal = !isDark;
  document.documentElement.setAttribute('data-dark', newVal);
  localStorage.setItem('darkMode', newVal);
  document.getElementById('darkModeBtn').textContent = newVal ? '☀️' : '🌙';
}

function initDarkMode() {
  const saved = localStorage.getItem('darkMode') === 'true';
  if (saved) {
    document.documentElement.setAttribute('data-dark', 'true');
    const btn = document.getElementById('darkModeBtn');
    if (btn) btn.textContent = '☀️';
  }
}

// ============================================================
// 👤 PROFILE EDIT
// ============================================================
function openProfile() {
  const db   = getDB();
  const user = db.users[currentUser.username];
  document.getElementById('profileEmail').value     = user.email || '';
  document.getElementById('profileBirthday').value  = user.birthday || '';
  document.getElementById('profileError').style.display = 'none';
  openModal('profileModal');
}

function saveProfile() {
  const email    = document.getElementById('profileEmail').value.trim();
  const birthday = document.getElementById('profileBirthday').value;
  const errEl    = document.getElementById('profileError');
  errEl.style.display = 'none';

  const db   = getDB();
  const user = db.users[currentUser.username];
  const oldEmail = user.email;
  user.email    = email;
  user.birthday = birthday;
  saveDB(db);
  currentUser = user;

  // If email changed and Firebase available — create/update Auth user
  if (email && email !== oldEmail) {
    createFirebaseAuthUser(email, '').then(() => {});
  }

  closeModal('profileModal');
  showToast('✅ פרופיל עודכן בהצלחה', 'success');
  auditLog('profile_update', `${currentUser.username} עדכן פרטי פרופיל`);
}

// ============================================================
// 👥 PENDING REGISTRATIONS
// ============================================================
function renderPendingRegistrations() {
  const db = getDB();
  const pending = Object.values(db.users).filter(u => u.status === 'pending');
  const listEl  = document.getElementById('pendingRegList');
  const badgeEl = document.getElementById('pendingRegBadge');
  const cbEl    = document.getElementById('requireRegApproval');

  if (cbEl) cbEl.checked = getSettings().requireRegistrationApproval !== false;
  if (badgeEl) {
    badgeEl.textContent  = pending.length;
    badgeEl.style.display = pending.length ? '' : 'none';
  }
  if (!listEl) return;

  if (!pending.length) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">אין הרשמות ממתינות ✅</div>';
    return;
  }

  listEl.innerHTML = pending.map(u => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--warning-light);border-radius:10px;margin-bottom:8px;flex-wrap:wrap;">
      <div style="flex:1;">
        <div style="font-weight:700;font-size:14px;">${u.fullName}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${u.username} · ${u.dept} · ${u.email||'אין מייל'}</div>
        <div style="font-size:11px;color:var(--text-muted);">${u.registeredAt ? new Date(u.registeredAt).toLocaleString('he-IL') : ''}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button onclick="approveRegistration('${u.username}')" class="btn btn-success" style="padding:7px 14px;font-size:13px;border-radius:8px;">✅ אשר</button>
        <button onclick="rejectRegistration('${u.username}')" class="btn btn-outline" style="padding:7px 14px;font-size:13px;border-radius:8px;color:var(--danger);border-color:var(--danger);">❌ דחה</button>
      </div>
    </div>
  `).join('');
}

function approveRegistration(username) {
  const db = getDB();
  if (!db.users[username]) return;
  db.users[username].status = 'active';
  saveDB(db);
  showToast(`✅ ${db.users[username].fullName} אושר/ה`, 'success');
  auditLog('approve_user', `אושרה הרשמה של ${username}`);
  renderPendingRegistrations();
}

function rejectRegistration(username) {
  const db = getDB();
  const name = db.users[username]?.fullName || username;
  if (!confirm(`למחוק את הרשמת ${name}?`)) return;
  delete db.users[username];
  saveDB(db);
  showToast(`🗑️ הרשמת ${name} נמחקה`, 'info');
  auditLog('reject_user', `נדחתה הרשמה של ${username}`);
  renderPendingRegistrations();
}

function toggleRegApproval(cb) {
  const db = getDB();
  if (!db.settings) db.settings = {};
  db.settings.requireRegistrationApproval = cb.checked;
  saveDB(db);
  showToast(cb.checked ? '🔒 אישור מנהל פעיל' : '🔓 הרשמה חופשית', 'info');
}

function backToPendingLogin() {
  document.getElementById('pendingApprovalScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
}

// Block pending users from logging in
function isUserActive(user) {
  return !user.status || user.status === 'active';
}

// ============================================================
// 📶 OFFLINE MODE
// ============================================================
function initOfflineDetection() {
  function update() {
    const online = navigator.onLine;
    const badge  = document.getElementById('firebaseBadge');
    // Show offline toast only when going offline
    if (!online) {
      showToast('⚠️ אין חיבור לאינטרנט — עובד במצב לא מקוון', 'warning', 5000);
    } else {
      showToast('✅ חיבור לאינטרנט חזר', 'success', 3000);
    }
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
}

// ============================================================
// 🤖 AI — חיזוי מחסור כוח אדם (למנהל)
// ============================================================
function renderAIStaffingForecast() {
  const el = document.getElementById('aiStaffingForecast');
  if (!el) return;
  const db  = getDB();
  const today = new Date();
  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'accountant';
  // Scope depts to what this manager manages
  const myManagedDepts = isAdmin ? null : Object.entries(db.deptManagers || {})
    .filter(([, mgr]) => mgr === currentUser.username).map(([dept]) => dept);
  const depts = (db.departments || []).filter(d => !myManagedDepts || myManagedDepts.length === 0 || myManagedDepts.includes(d));

  // Build next 8 weeks map: week → dept → count absent
  const weeks = [];
  for (let w = 0; w < 8; w++) {
    const ws = new Date(today);
    ws.setDate(today.getDate() + w * 7 - today.getDay()); // Sunday of week
    const we = new Date(ws); we.setDate(ws.getDate() + 4); // Friday
    const dates = [];
    for (let d = 0; d < 5; d++) {
      const dd = new Date(ws); dd.setDate(ws.getDate() + d);
      dates.push(dd.toISOString().slice(0,10));
    }
    weeks.push({ ws, we, dates });
  }

  const alerts = [];
  const heatData = []; // { label, deptCounts }

  weeks.forEach(({ ws, we, dates }, wi) => {
    const label = `${ws.getDate()}/${ws.getMonth()+1}`;
    const deptCounts = {};
    depts.forEach(dept => {
      const deptUsers = Object.values(db.users).filter(u => {
        const d = getUserDept(u);
        return d === dept && u.role !== 'admin' && isUserActive(u);
      });
      if (!deptUsers.length) return;
      let maxAbsent = 0;
      dates.forEach(dt => {
        let absent = 0;
        deptUsers.forEach(u => {
          const v = (db.vacations[u.username] || {})[dt];
          if (v && v !== 'wfh') absent++;
        });
        if (absent > maxAbsent) maxAbsent = absent;
      });
      const pct = Math.round(maxAbsent / deptUsers.length * 100);
      deptCounts[dept] = { absent: maxAbsent, total: deptUsers.length, pct };
      if (pct >= 50) alerts.push({ wi, label, dept, pct, absent: maxAbsent, total: deptUsers.length });
    });
    heatData.push({ label, deptCounts });
  });

  const DEPT_COLORS = ['#1a56e8','#16a34a','#7c3aed','#0891b2','#dc2626','#d97706'];

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <div class="section-title" style="margin-bottom:0;"><span class="section-title-icon">🤖</span> AI — חיזוי מחסור כוח אדם</div>
      <span style="font-size:11px;background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:12px;font-weight:700;">8 שבועות קדימה</span>
    </div>

    ${alerts.length ? `
    <div style="margin-bottom:14px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">⚠️ התראות מחסור</div>
      ${alerts.map(a => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${a.pct>=70?'var(--danger-light)':'var(--warning-light)'};border-radius:10px;margin-bottom:6px;">
          <div style="font-size:20px;">${a.pct >= 70 ? '🔴' : '🟡'}</div>
          <div style="flex:1;">
            <div style="font-weight:700;font-size:13px;">${a.dept} — שבוע ${a.label}</div>
            <div style="font-size:12px;color:var(--text-secondary);">${a.absent} מתוך ${a.total} עובדים בחופשה (${a.pct}%)</div>
          </div>
        </div>
      `).join('')}
    </div>` : `<div style="background:var(--success-light);border-radius:10px;padding:12px;margin-bottom:14px;font-size:13px;color:#14532d;">✅ לא זוהו מחסורים צפויים ב-8 השבועות הקרובים</div>`}

    ${depts.length ? `
    <div>
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">מפת עומס 8 שבועות</div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table style="border-collapse:collapse;min-width:500px;width:100%;font-size:12px;">
          <thead>
            <tr>
              <th style="padding:6px 8px;text-align:right;white-space:nowrap;">מחלקה</th>
              ${heatData.map(w => `<th style="padding:6px 4px;text-align:center;white-space:nowrap;">${w.label}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${depts.map((dept, di) => `
              <tr>
                <td style="padding:6px 8px;font-weight:600;white-space:nowrap;color:${DEPT_COLORS[di%DEPT_COLORS.length]};">${dept}</td>
                ${heatData.map(w => {
                  const dc = w.deptCounts[dept] || { pct: 0 };
                  const bg = dc.pct >= 70 ? '#fca5a5' : dc.pct >= 40 ? '#fde68a' : dc.pct >= 10 ? '#bbf7d0' : 'var(--surface2)';
                  return `<td style="padding:6px 4px;text-align:center;background:${bg};border-radius:4px;">${dc.pct > 0 ? dc.pct+'%' : '—'}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--text-muted);">
        <span>🟥 70%+</span><span>🟨 40-70%</span><span>🟩 10-40%</span><span>⬜ נקי</span>
      </div>
    </div>` : ''}
  `;
}

// ============================================================
// 🏆 AI — ציון עובד (Employee Wellbeing Score)
// ============================================================
function renderEmployeeScores() {
  const el = document.getElementById('employeeScoresSection');
  if (!el) return;
  const db = getDB();
  const year = new Date().getFullYear();
  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'accountant';
  const users = Object.values(db.users).filter(u => {
    if (!isUserActive(u) || u.role === 'admin' || u.role === 'accountant') return false;
    if (isAdmin) return true;
    return managerManagesUser(currentUser.username, u, db);
  });

  const scores = users.map(u => {
    const vacs   = db.vacations[u.username] || {};
    const cb     = calcBalance(u.username, year);
    const total  = Object.values(vacs).filter(t => t==='full'||t==='half').length;
    const wfh    = Object.values(vacs).filter(t => t==='wfh').length;
    const daysSince = calcDaysSinceLastVacation(vacs);
    const burnout   = calcBurnoutScore(daysSince, total, wfh, u);
    const usagePct  = cb.quota > 0 ? Math.round(total/cb.quota*100) : 0;
    const wellbeing = Math.max(0, 100 - burnout);
    return { u, burnout, wellbeing, usagePct, daysSince, total, balance: cb.balance };
  }).sort((a,b) => a.wellbeing - b.wellbeing); // worst first

  if (!scores.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">אין עובדים להצגה</div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <div class="section-title" style="margin-bottom:0;"><span class="section-title-icon">🏆</span> AI — ציוני רווחת עובדים</div>
      <span style="font-size:11px;background:var(--primary-light);color:var(--primary);padding:4px 10px;border-radius:12px;font-weight:700;">מסודר לפי סיכון</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
    ${scores.map(({ u, wellbeing, burnout, usagePct, daysSince, balance }) => {
      const color = wellbeing < 30 ? '#dc2626' : wellbeing < 60 ? '#f59e0b' : '#16a34a';
      const icon  = wellbeing < 30 ? '🔴' : wellbeing < 60 ? '🟡' : '🟢';
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:10px;flex-wrap:wrap;">
          <div style="font-size:20px;">${icon}</div>
          <div style="flex:1;min-width:120px;">
            <div style="font-weight:700;font-size:13px;">${u.fullName}</div>
            <div style="font-size:11px;color:var(--text-muted);">${Array.isArray(u.dept)?u.dept[0]:u.dept||''} · ${daysSince} ימים ללא חופשה</div>
          </div>
          <div style="text-align:center;min-width:48px;">
            <div style="font-size:18px;font-weight:800;color:${color};">${wellbeing}</div>
            <div style="font-size:10px;color:var(--text-muted);">ציון</div>
          </div>
          <div style="text-align:center;min-width:48px;">
            <div style="font-size:15px;font-weight:700;">${usagePct}%</div>
            <div style="font-size:10px;color:var(--text-muted);">ניצול</div>
          </div>
          <div style="text-align:center;min-width:48px;">
            <div style="font-size:15px;font-weight:700;color:${balance<0?'var(--danger)':'var(--text)'};">${balance.toFixed(1)}</div>
            <div style="font-size:10px;color:var(--text-muted);">יתרה</div>
          </div>
        </div>`;
    }).join('')}
    </div>
  `;
}


// ============================================================

function showModuleSelector() {
  ['loginScreen','appScreen','timeClockScreen','ceoDashboardScreen'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });

  // CEO user gets special dashboard
  if (isCeoUser()) {
    showCeoDashboard();
    return;
  }

  const s = getSettings();
  const logoImg  = document.getElementById('moduleLogoImg');
  const logoIcon = document.getElementById('moduleBrandIcon');
  if (s.companyLogo) {
    logoImg.src = s.companyLogo; logoImg.style.display = 'block';
    logoIcon.style.display = 'none';
  } else {
    logoImg.style.display = 'none'; logoIcon.style.display = '';
  }
  const cnEl = document.getElementById('moduleCompanyName');
  if (cnEl && s.companyName) cnEl.textContent = s.companyName;
  const wEl = document.getElementById('moduleWelcome');
  if (wEl) wEl.innerHTML = `👋 שלום, ${currentUser.fullName}`;
  document.getElementById('moduleSelectorScreen').classList.add('active');
  loadTheme();
  updateSickCount();

  // Populate stats row
  (function() {
    try {
      const db = getDB();
      const users = Object.values(db.users || {}).filter(u => u.role !== 'admin' && u.status === 'active');
      const today = new Date().toISOString().split('T')[0];
      const sick = Object.values(db.sick || {}).filter(s => s.date === today).length;
      const vacs = db.vacations || {};
      const onVac = users.filter(u => vacs[u.username] && vacs[u.username][today]).length;
      const statsEl = document.getElementById('msStatsRow');
      if (statsEl) {
        const canAnn = canSendAnnouncement();
        statsEl.innerHTML =
          '<div class="ms-stat-pill"><div class="stat-ico">👥</div><div class="stat-num">' + users.length + '</div><div class="stat-lbl">עובדים</div></div>' +
          '<div class="ms-stat-pill"><div class="stat-ico">🏖️</div><div class="stat-num">' + onVac + '</div><div class="stat-lbl">בחופשה</div></div>' +
          '<div class="ms-stat-pill"><div class="stat-ico">🤒</div><div class="stat-num">' + sick + '</div><div class="stat-lbl">חולה</div></div>' +
          (canAnn ? '<div class="ms-stat-pill ms-stat-ann" onclick="openCeoMessage()" title="שלח הודעה"><div class="stat-ico">📢</div><div class="stat-num" style="font-size:12px;font-weight:700;color:#fff;line-height:1.2;margin-top:2px;">שלח<br>הודעה</div></div>' : '');
      }
    } catch(e) {}
  })();
  // Show announcement popup if any unseen
  setTimeout(renderAnnouncements, 700);
  setTimeout(checkBirthdays, 600);
  setTimeout(checkHandoverNeeded, 1500);
  setTimeout(checkPendingHandovers, 2500);
  setTimeout(renderMyHandoverCard, 500);
  startHandoverPoller(); // פולר — מזהה אישור מנהל גם ללא Firebase
}

// Open AI panel from module selector
function openAIFromSelector() {
  const panel = document.getElementById('aiPanel');
  if (!panel) return;
  _aiPanelOpen = true;
  panel.classList.add('open');
  // Only show welcome if chat is empty (first open)
  const messages = document.getElementById('aiMessages');
  if (messages && !messages.querySelector('.ai-msg')) {
    messages.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon">🤖</div><p>שלום! אני Dazura AI.<br>שאל אותי כל שאלה הקשורה לחופשות, נוכחות ומידע ארגוני.</p></div>';
  }
  setTimeout(() => {
    document.getElementById('aiInput')?.focus();
    scrollAIToBottom();
  }, 300);
}

function enterModule(module) {
  // Remove active from ALL screens first
  ['loginScreen','moduleSelectorScreen','ceoDashboardScreen','timeClockScreen','forcePasswordScreen','pendingApprovalScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  if (module === 'vacation') {
    document.getElementById('appScreen').classList.add('active');
    showApp(true);
    // Scroll to top on iOS
    const mc = document.querySelector('.main-content');
    if (mc) mc.scrollTop = 0;
  } else if (module === 'timeclock') {
    document.getElementById('timeClockScreen').classList.add('active');
    initTimeClock();
  }
}

function initTimeClock() {
  document.getElementById('tcUserName').textContent = currentUser.fullName;
  setTCToday();
  renderTCHistory();
}

function setTCToday() {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('tcDate').value = today;
  // Max date = today + 1 (allow tomorrow for night shift)
  document.getElementById('tcDate').max = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  loadTCRecord();
}

function loadTCRecord() {
  const date = document.getElementById('tcDate').value;
  if (!date) return;
  const db = getDB();
  const records = db.timeClockRecords || {};
  const rec = records[currentUser.username]?.[date];
  document.getElementById('tcEntry').value = rec?.entry || '';
  document.getElementById('tcExit').value  = rec?.exit  || '';
  document.getElementById('tcNote').value  = rec?.note  || '';
  calcTCHours();
  const status = document.getElementById('tcSaveStatus');
  if (rec) {
    status.innerHTML = `<span style="color:var(--success);">✅ דיווח קיים — ניתן לעדכן</span>`;
  } else {
    status.innerHTML = '';
  }
}

function calcTCHours() {
  const entry = document.getElementById('tcEntry').value;
  const exit  = document.getElementById('tcExit').value;
  const disp  = document.getElementById('tcTotalDisplay');
  const total = document.getElementById('tcTotalHours');
  if (entry && exit) {
    const [eh,em] = entry.split(':').map(Number);
    const [xh,xm] = exit.split(':').map(Number);
    let mins = (xh*60+xm) - (eh*60+em);
    if (mins < 0) mins += 24*60; // overnight
    const h = Math.floor(mins/60);
    const m = mins % 60;
    total.textContent = `${h}:${String(m).padStart(2,'0')}`;
    disp.style.display = '';
    // Color by hours
    total.style.color = mins < 240 ? 'var(--danger)' : mins > 600 ? 'var(--warning)' : 'var(--primary)';
  } else {
    disp.style.display = 'none';
  }
}

function saveTCRecord() {
  const date  = document.getElementById('tcDate').value;
  const entry = document.getElementById('tcEntry').value;
  const exit  = document.getElementById('tcExit').value;
  const note  = document.getElementById('tcNote').value.trim();
  const status = document.getElementById('tcSaveStatus');

  if (!date)  { status.innerHTML = '<span style="color:var(--danger);">⚠️ בחר תאריך</span>'; return; }
  if (!entry) { status.innerHTML = '<span style="color:var(--danger);">⚠️ הזן שעת כניסה</span>'; return; }
  if (!exit)  { status.innerHTML = '<span style="color:var(--danger);">⚠️ הזן שעת יציאה</span>'; return; }

  // Calc total
  const [eh,em] = entry.split(':').map(Number);
  const [xh,xm] = exit.split(':').map(Number);
  let mins = (xh*60+xm) - (eh*60+em);
  if (mins < 0) mins += 24*60;
  const totalStr = `${Math.floor(mins/60)}:${String(mins%60).padStart(2,'0')}`;

  const db = getDB();
  if (!db.timeClockRecords) db.timeClockRecords = {};
  if (!db.timeClockRecords[currentUser.username]) db.timeClockRecords[currentUser.username] = {};

  db.timeClockRecords[currentUser.username][date] = {
    entry, exit, note,
    total: totalStr,
    totalMins: mins,
    fullName: currentUser.fullName,
    dept: Array.isArray(currentUser.dept) ? currentUser.dept[0] : currentUser.dept || '',
    savedAt: new Date().toISOString()
  };
  saveDB(db);
  auditLog('timeclock_save', `${currentUser.fullName} דיווח שעות ${date}: ${entry}–${exit} (${totalStr})`);
  status.innerHTML = `<span style="color:var(--success);">✅ נשמר בהצלחה — ${totalStr} שעות</span>`;
  renderTCHistory();
}

function renderTCHistory() {
  const db = getDB();
  const records = (db.timeClockRecords || {})[currentUser.username] || {};
  const el = document.getElementById('tcHistory');
  if (!el) return;

  const sorted = Object.entries(records).sort((a,b) => b[0].localeCompare(a[0])).slice(0, 14);
  if (!sorted.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">אין דיווחים עדיין</div>';
    return;
  }

  const DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const MONTHS = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];

  el.innerHTML = sorted.map(([date, rec]) => {
    const d = new Date(date + 'T00:00:00');
    const isToday = date === new Date().toISOString().slice(0,10);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${isToday?'var(--primary-light)':'var(--surface2)'};border-radius:10px;cursor:pointer;" onclick="document.getElementById('tcDate').value='${date}';loadTCRecord();">
      <div style="text-align:center;min-width:36px;">
        <div style="font-size:17px;font-weight:800;color:${isToday?'var(--primary)':'var(--text)'};">${d.getDate()}</div>
        <div style="font-size:10px;color:var(--text-muted);">${MONTHS[d.getMonth()]}</div>
      </div>
      <div style="flex:1;">
        <div style="font-size:12px;color:var(--text-muted);">${DAYS[d.getDay()]}${isToday?' · היום':''}</div>
        <div style="font-size:13px;font-weight:700;">${rec.entry} – ${rec.exit}</div>
        ${rec.note ? `<div style="font-size:11px;color:var(--text-muted);">${rec.note}</div>` : ''}
      </div>
      <div style="font-size:16px;font-weight:800;color:var(--primary);">${rec.total}</div>
    </div>`;
  }).join('');
}

// ---- Export (accountant/admin) ----
function exportTimeClock(range) {
  const today = new Date();
  let from, to;
  if (range === 'today') {
    from = to = today.toISOString().slice(0,10);
  } else if (range === 'week') {
    const day = today.getDay();
    const sun = new Date(today); sun.setDate(today.getDate() - day);
    const sat = new Date(sun);  sat.setDate(sun.getDate() + 6);
    from = sun.toISOString().slice(0,10);
    to   = sat.toISOString().slice(0,10);
  } else if (range === 'month') {
    from = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    const lastDay = new Date(today.getFullYear(), today.getMonth()+1, 0);
    to = lastDay.toISOString().slice(0,10);
  } else {
    from = document.getElementById('tcExportFrom').value;
    to   = document.getElementById('tcExportTo').value;
    if (!from || !to) { showToast('⚠️ בחר טווח תאריכים', 'warning'); return; }
    if (from > to)    { showToast('⚠️ תאריך התחלה גדול מהסיום', 'warning'); return; }
  }

  const db = getDB();
  const allRecords = db.timeClockRecords || {};
  const rows = [];

  Object.entries(allRecords).forEach(([username, dates]) => {
    Object.entries(dates).forEach(([date, rec]) => {
      if (date >= from && date <= to) {
        rows.push({ username, date, ...rec });
      }
    });
  });

  if (!rows.length) { showToast('⚠️ אין דיווחים בטווח זה', 'warning'); return; }

  rows.sort((a,b) => a.date.localeCompare(b.date) || a.fullName.localeCompare(b.fullName));

  const header = 'שם עובד,מחלקה,תאריך,כניסה,יציאה,סה"כ שעות,הערה';
  const csvRows = rows.map(r =>
    [r.fullName, r.dept||'', r.date, r.entry||'', r.exit||'', r.total||'', (r.note||'').replace(/,/g,'；')]
    .map(v => `"${v}"`).join(',')
  );

  const BOM = '\uFEFF';
  const csv = BOM + [header, ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `דיווח_שעות_${from}_עד_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`✅ יוצאו ${rows.length} דיווחים`, 'success');
  auditLog('timeclock_export', `ייצוא דיווחי שעות ${from} עד ${to} — ${rows.length} רשומות`);
}

function renderTCTodayPreview() {
  const el = document.getElementById('tcTodayPreview');
  if (!el) return;
  const today = new Date().toISOString().slice(0,10);
  const db = getDB();
  const allRecords = db.timeClockRecords || {};
  const rows = [];
  Object.entries(allRecords).forEach(([username, dates]) => {
    if (dates[today]) rows.push({ username, ...dates[today] });
  });
  if (!rows.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">אין דיווחים להיום עדיין</div>';
    return;
  }
  rows.sort((a,b) => a.fullName?.localeCompare(b.fullName));
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:var(--surface2);">
      <th style="padding:8px;text-align:right;">עובד</th>
      <th style="padding:8px;text-align:right;">מחלקה</th>
      <th style="padding:8px;text-align:center;">כניסה</th>
      <th style="padding:8px;text-align:center;">יציאה</th>
      <th style="padding:8px;text-align:center;">סה"כ</th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;font-weight:600;">${r.fullName||r.username}</td>
      <td style="padding:8px;color:var(--text-secondary);">${r.dept||''}</td>
      <td style="padding:8px;text-align:center;">${r.entry||'—'}</td>
      <td style="padding:8px;text-align:center;">${r.exit||'—'}</td>
      <td style="padding:8px;text-align:center;font-weight:700;color:var(--primary);">${r.total||'—'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}


// ============================================================
function renderVacationDNA() {
  const el = document.getElementById('vacationDNACard');
  if (!el) return;
  const db = getDB();
  const username = currentUser.username;
  const vacs = db.vacations[username] || {};
  const currentYear = new Date().getFullYear();
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  const allEntries = Object.entries(vacs);
  const thisYear   = allEntries.filter(([dt]) => dt.startsWith(String(currentYear)));

  const monthDays = new Array(12).fill(0);
  const wfhDays   = new Array(12).fill(0);
  thisYear.forEach(([dt, type]) => {
    const m = new Date(dt + 'T00:00:00').getMonth();
    if (type === 'full') monthDays[m]++;
    else if (type === 'half') monthDays[m] += 0.5;
    else if (type === 'wfh') wfhDays[m]++;
  });

  const totalVacDays = monthDays.reduce((a,b) => a+b, 0);
  const totalWFH     = wfhDays.reduce((a,b) => a+b, 0);
  const currentMonth = new Date().getMonth();
  const monthsPassed = currentMonth + 1;
  const avgPerMonth  = monthsPassed > 0 ? (totalVacDays / monthsPassed).toFixed(1) : 0;
  const peakMonthIdx = monthDays.indexOf(Math.max(...monthDays));

  const daysSinceVac  = calcDaysSinceLastVacation(vacs);
  const burnoutScore  = calcBurnoutScore(daysSinceVac, totalVacDays, totalWFH, currentUser);
  const burnoutColor  = burnoutScore >= 75 ? '#dc2626' : burnoutScore >= 50 ? '#f59e0b' : '#16a34a';
  const burnoutLabel  = burnoutScore >= 75 ? '🔴 גבוה — ממליצים על חופשה בקרוב' : burnoutScore >= 50 ? '🟡 בינוני — כדאי לתכנן חופשה' : '🟢 תקין';

  const pattern        = detectVacationPattern(vacs, currentYear);
  const recommendation = suggestNextVacation(vacs, db, currentYear);

  const maxBar = Math.max(...monthDays, 1);

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <div class="section-title" style="margin-bottom:0;"><span class="section-title-icon">🧬</span> Vacation DNA — טביעת האצבע שלך</div>
      <span style="font-size:11px;background:var(--primary-light);color:var(--primary);padding:4px 10px;border-radius:12px;font-weight:700;">AI Personal</span>
    </div>

    <div style="background:var(--surface2);border-radius:12px;padding:14px;margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:700;font-size:13px;">🔋 מד שחיקה אישי</span>
        <span style="font-size:14px;font-weight:800;color:${burnoutColor};">${burnoutScore}/100</span>
      </div>
      <div style="background:#e2e8f0;border-radius:6px;height:12px;overflow:hidden;">
        <div style="height:100%;width:${burnoutScore}%;background:${burnoutColor};border-radius:6px;"></div>
      </div>
      <div style="font-size:12px;color:${burnoutColor};margin-top:6px;font-weight:600;">${burnoutLabel}</div>
      ${daysSinceVac > 0 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">ימים מאז חופשה אחרונה: <strong>${daysSinceVac}</strong></div>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">
      <div style="background:var(--surface2);border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:var(--primary);">${totalVacDays}</div>
        <div style="font-size:11px;color:var(--text-muted);">ימי חופשה</div>
      </div>
      <div style="background:var(--surface2);border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#ca8a04;">${totalWFH}</div>
        <div style="font-size:11px;color:var(--text-muted);">ימי WFH</div>
      </div>
      <div style="background:var(--surface2);border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:var(--success);">${avgPerMonth}</div>
        <div style="font-size:11px;color:var(--text-muted);">ממוצע/חודש</div>
      </div>
    </div>

    <div style="margin-bottom:14px;">
      <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:8px;">דפוס חופשות לפי חודש</div>
      <div style="display:flex;gap:3px;align-items:flex-end;height:64px;">
        ${monthDays.map((v, i) => {
          const h = Math.max(3, Math.round(v / maxBar * 52));
          const isNow  = i === currentMonth;
          const isPeak = i === peakMonthIdx && v > 0;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:64px;" title="${MONTHS[i]}: ${v} ימים">
            <div style="width:100%;height:${h}px;background:${isPeak?'var(--warning)':isNow?'var(--primary)':'var(--primary-light)'};border-radius:3px 3px 0 0;"></div>
            <div style="font-size:7px;color:var(--text-muted);margin-top:2px;">${MONTHS[i].slice(0,2)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    ${pattern ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:12px;margin-bottom:10px;font-size:13px;">
      <span style="font-weight:700;color:#15803d;">🔍 דפוס שזוהה: </span>${pattern}
    </div>` : ''}

    ${recommendation ? `<div style="background:var(--primary-light);border:1px solid var(--primary);border-radius:10px;padding:12px;font-size:13px;">
      <span style="font-weight:700;color:var(--primary-dark);">💡 המלצה: </span>${recommendation}
    </div>` : ''}
  `;
}

function calcDaysSinceLastVacation(vacs) {
  const today = new Date();
  const vacDates = Object.entries(vacs)
    .filter(([,t]) => t === 'full' || t === 'half')
    .map(([dt]) => new Date(dt + 'T00:00:00'))
    .filter(d => d <= today)
    .sort((a,b) => b - a);
  return vacDates.length ? Math.floor((today - vacDates[0]) / 86400000) : 60;
}

function calcBurnoutScore(daysSince, totalDays, wfhDays, user) {
  let score = 0;
  score += Math.min(40, Math.round(daysSince / 2));
  const cb = calcBalance(user.username, new Date().getFullYear());
  const usagePct = cb.quota > 0 ? (totalDays / cb.quota) : 0;
  score += Math.round((1 - Math.min(usagePct, 1)) * 30);
  const avgWFH = wfhDays / (new Date().getMonth() + 1);
  score += avgWFH < 1 ? 30 : avgWFH < 2 ? 15 : 0;
  return Math.min(100, score);
}

function detectVacationPattern(vacs, year) {
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const entries = Object.entries(vacs).filter(([dt]) => dt.startsWith(String(year)));
  if (entries.length < 3) return null;
  const dowCount = [0,0,0,0,0,0,0];
  entries.forEach(([dt]) => dowCount[new Date(dt+'T00:00:00').getDay()]++);
  const maxDow = dowCount.indexOf(Math.max(...dowCount));
  const dowNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  if (dowCount[maxDow] >= 3) return `לוקח חופשה לרוב ביום ${dowNames[maxDow]} (${dowCount[maxDow]} פעמים)`;
  const monthCount = {};
  entries.forEach(([dt]) => {
    const m = new Date(dt+'T00:00:00').getMonth();
    monthCount[m] = (monthCount[m]||0)+1;
  });
  const top = Object.entries(monthCount).sort((a,b)=>b[1]-a[1])[0];
  if (top && top[1] >= 3) return `מרכז חופשות ב${MONTHS[top[0]]} (${top[1]} ימים)`;
  return null;
}

function suggestNextVacation(vacs, db, year) {
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const today = new Date();
  const dept = Array.isArray(currentUser.dept) ? currentUser.dept[0] : currentUser.dept;
  const deptUsers = Object.values(db.users).filter(u => {
    const d = getUserDept(u);
    return d === dept && u.username !== currentUser.username;
  });
  let bestWeek = null, bestScore = 999;
  for (let w = 1; w <= 8; w++) {
    const ws = new Date(today);
    ws.setDate(today.getDate() + w * 7);
    let conflicts = 0;
    for (let d = 0; d < 5; d++) {
      const dd = new Date(ws); dd.setDate(ws.getDate() + d);
      const dtStr = dd.toISOString().slice(0,10);
      deptUsers.forEach(u => {
        const uv = db.vacations[u.username] || {};
        if (uv[dtStr] && uv[dtStr] !== 'wfh') conflicts++;
      });
    }
    if (conflicts < bestScore) { bestScore = conflicts; bestWeek = new Date(ws); }
  }
  if (!bestWeek) return null;
  return `שבוע ${bestWeek.getDate()} ${MONTHS[bestWeek.getMonth()]} פנוי יחסית במחלקתך — זמן מצוין לחופשה`;
}

// ============================================================
// FIREBASE INTEGRATION
// ============================================================

// ============================================================
// AUTH — FORGOT PASSWORD & CHANGE PASSWORD
// ============================================================

let _forgotUser = null;       // username being reset
let _forgotEmailCode = null;  // generated code
let _forgotCodeExpiry = null; // expiry timestamp
let _forgotVerified = false;  // passed verification


// --- Open forgot password flow ---
// ============================================================
// 🔑 FORGOT PASSWORD — Firebase Auth (replaces manual steps)
// ============================================================
function showForgotPassword() {
  _forgotUser = null;
  document.getElementById('forgotUsername').value = '';
  const errEl = document.getElementById('forgotStep1Error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  document.getElementById('forgotStep1Body').style.display = '';
  document.getElementById('forgotStep2Body').style.display = 'none';
  openModal('forgotStep1Modal');
}

async function forgotStep1Next() {
  const username = (document.getElementById('forgotUsername').value || '').trim().toLowerCase();
  const errEl    = document.getElementById('forgotStep1Error');
  errEl.style.display = 'none';

  if (!username) { errEl.textContent = 'נא להזין שם משתמש'; errEl.style.display = 'block'; return; }

  const db   = getDB();
  const user = db.users[username];
  if (!user) { errEl.textContent = 'שם משתמש לא נמצא במערכת'; errEl.style.display = 'block'; return; }
  if (!user.email) {
    errEl.innerHTML = '⚠️ אין מייל רשום לחשבון זה.<br><strong>פנה למנהל המערכת לאיפוס ידני.</strong>';
    errEl.style.display = 'block'; return;
  }

  // Show sending state
  const btn = document.querySelector('#forgotStep1Body .btn-primary');
  if (btn) { btn.textContent = '⏳ שולח...'; btn.disabled = true; }

  const result = await sendFirebasePasswordReset(user.email);

  if (btn) { btn.textContent = 'שלח מייל איפוס 📧'; btn.disabled = false; }

  if (result.success) {
    _forgotUser = username;
    document.getElementById('forgotUsernameDisplay').textContent = user.fullName || username;
    document.getElementById('forgotNewPass').value  = '';
    document.getElementById('forgotNewPass2').value = '';
    document.getElementById('forgotStep1Body').style.display = 'none';
    document.getElementById('forgotStep2Body').style.display = '';
    auditLog('password_reset_sent', `${username} ביקש איפוס סיסמה`);
  } else {
    const msgs = {
      'auth/user-not-found':    '⚠️ חשבון לא נמצא ב-Firebase — פנה למנהל',
      'auth/invalid-email':     '⚠️ כתובת מייל לא תקינה',
      'auth/too-many-requests': '⚠️ יותר מדי ניסיונות — נסה שוב מאוחר יותר',
      'auth/operation-not-allowed': '⚠️ שחזור מייל לא מופעל — פנה למנהל'
    };
    errEl.textContent = msgs[result.error] || `⚠️ שגיאה: ${result.error}`;
    errEl.style.display = 'block';
  }
}

function forgotSetNewPassword() {
  const errEl = document.getElementById('forgotStep1Error');
  const p1 = document.getElementById('forgotNewPass').value;
  const p2 = document.getElementById('forgotNewPass2').value;
  errEl.style.display = 'none';

  if (!p1 || p1.length < 4) { errEl.textContent = 'סיסמה חייבת להיות לפחות 4 תווים'; errEl.style.display = 'block'; return; }
  if (p1 !== p2) { errEl.textContent = 'הסיסמאות אינן תואמות'; errEl.style.display = 'block'; return; }

  const db = getDB();
  if (!db.users[_forgotUser]) { errEl.textContent = 'שגיאה — נסה שוב'; errEl.style.display = 'block'; return; }
  _sha256(p1).then(hash => {
    db.users[_forgotUser].password = hash;
    saveDB(db);
    closeModal('forgotStep1Modal');
    showToast('✅ הסיסמה סונכרנה בהצלחה — כעת תוכל להיכנס', 'success', 5000);
    auditLog('password_reset_synced', `${_forgotUser} סינכרן סיסמה חדשה`);
    _forgotUser = null;
  });
}

// --- Change password (logged in) ---
function openChangePassword() {
  document.getElementById('changePassCurrent').value = '';
  document.getElementById('changePassNew').value = '';
  document.getElementById('changePassNew2').value = '';
  const errEl = document.getElementById('changePassError');
  if (errEl) errEl.style.display = 'none';
  openModal('changePasswordModal');
}

function doChangePassword() {
  const current = document.getElementById('changePassCurrent').value;
  const newPass  = document.getElementById('changePassNew').value;
  const newPass2 = document.getElementById('changePassNew2').value;
  const errEl = document.getElementById('changePassError');
  errEl.style.display = 'none';
  const db = getDB();
  const user = db.users[currentUser.username];
  if (newPass.length < 4) { errEl.textContent = 'הסיסמה החדשה חייבת להיות לפחות 4 תווים'; errEl.style.display = 'block'; return; }
  if (newPass !== newPass2) { errEl.textContent = 'הסיסמאות אינן תואמות'; errEl.style.display = 'block'; return; }
  const _legHash2 = p => { let h=0; for(let i=0;i<p.length;i++){h=((h<<5)-h)+p.charCodeAt(i);h=h&h;} return 'h'+Math.abs(h).toString(36)+p.length; };
  _sha256(current).then(sha256cur => {
    if (user.password !== sha256cur && user.password !== _legHash2(current)) {
      errEl.textContent = 'הסיסמה הנוכחית שגויה'; errEl.style.display = 'block'; return;
    }
    _sha256(newPass).then(newHash => {
      user.password = newHash;
      saveDB(db);
      closeModal('changePasswordModal');
      auditLog('password_change', `${currentUser.username} שינה סיסמה`);
      showToast('✅ הסיסמה עודכנה בהצלחה', 'success');
    });
  });
}


// ============================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDV8uPvrVPIDBk4giazmQSdC11zhf9NQFE",
  authDomain: "vaction-system.firebaseapp.com",
  projectId: "vaction-system",
  storageBucket: "vaction-system.firebasestorage.app",
  messagingSenderId: "893730496578",
  appId: "1:893730496578:web:697573196d2732ae98cddb"
};

let firebaseDB = null;
let firebaseConnected = false;
let _fbUnsubscribe = null;   // real-time listener cleanup

// Called once on page load — connects silently in background
async function initFirebase() {
  try {
    if (!window.firebase) {
      await loadScript('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js');
    }
    if (!firebase.apps?.length) firebase.initializeApp(FIREBASE_CONFIG);

    // Sign in anonymously so Firestore security rules are satisfied
    const auth = firebase.auth();
    if (!auth.currentUser) {
      await auth.signInAnonymously();
    }

    firebaseDB = firebase.firestore();
    firebaseConnected = true;

    // Pull latest data from cloud FIRST, then start listening
    await pullFromFirebase();
    startRealtimeListener();

    updateFirebaseBadge(true);
  } catch(err) {
    console.warn('⚠️ Firebase offline — using local storage only:', err.message);
    updateFirebaseBadge(false);
  }
}

// Pull cloud → local (on connect / forced refresh)
async function pullFromFirebase() {
  if (!firebaseConnected || !firebaseDB) return;
  try {
    const doc = await firebaseDB.collection('vacationSystem').doc('data').get();
    if (doc.exists) {
      const data = doc.data();
      const cloudDB = {
        users:            JSON.parse(data.users       || '{}'),
        vacations:        JSON.parse(data.vacations   || '{}'),
        departments:      JSON.parse(data.departments || '[]'),
        approvalRequests: JSON.parse(data.approvalRequests || '[]'),
        deptManagers:     JSON.parse(data.deptManagers || '{}'),
        auditLog:         JSON.parse(data.auditLog    || '[]'),
        settings:         JSON.parse(data.settings    || '{}'),
        permissions:      JSON.parse(data.permissions || '{}'),
        announcements:    JSON.parse(data.announcements || '[]'),
        sick:             JSON.parse(data.sick        || '{}'),
        dailyStatus:      JSON.parse(data.dailyStatus  || '{}'),
        handovers:        JSON.parse(data.handovers        || '{}'),
        handoversArchive: JSON.parse(data.handoversArchive || '{}'),
        handoverPending:  JSON.parse(data.handoverPending  || '{}'),
        orgTree:          JSON.parse(data.orgTree          || '{}'),
        timeClockRecords: JSON.parse(data.timeClockRecords || '{}'),
        customQA:         JSON.parse(data.customQA         || '[]'),
      };
      // Always guarantee admin exists even if Firebase was wiped
      ensureAdminExists(cloudDB);
      _saveDBLocal(cloudDB);
      // Refresh permissions UI if admin tab is open
      if (document.getElementById('tab-admin')?.classList.contains('active')) {
        renderPermissionsTable();
        populateQuickPermUser();
      }
    } else {
      // First time — push local to cloud
      await pushToFirebase();
    }
  } catch(err) {
    console.warn('Pull error:', err.message);
  }
}

// Push local → cloud
async function pushToFirebase() {
  if (!firebaseConnected || !firebaseDB) return;
  try {
    const db = getDB();
    await firebaseDB.collection('vacationSystem').doc('data').set({
      users:            JSON.stringify(db.users || {}),
      vacations:        JSON.stringify(db.vacations || {}),
      departments:      JSON.stringify(db.departments || []),
      approvalRequests: JSON.stringify(db.approvalRequests || []),
      deptManagers:     JSON.stringify(db.deptManagers || {}),
      auditLog:         JSON.stringify((db.auditLog || []).slice(0, 200)),
      settings:         JSON.stringify(db.settings || {}),
      permissions:      JSON.stringify(db.permissions || {}),
      announcements:    JSON.stringify(db.announcements || []),
      sick:             JSON.stringify(db.sick || {}),
      dailyStatus:      JSON.stringify(db.dailyStatus || {}),
      handovers:        JSON.stringify(db.handovers || {}),
      handoversArchive: JSON.stringify(db.handoversArchive || {}),
      handoverPending:  JSON.stringify(db.handoverPending || {}),
      orgTree:          JSON.stringify(db.orgTree || {}),
      timeClockRecords: JSON.stringify(db.timeClockRecords || {}),
      customQA:         JSON.stringify(db.customQA || []),
      updatedAt:        new Date().toISOString(),
      updatedBy:        currentUser?.username || 'system'
    });
  } catch(err) {
    console.warn('Push error:', err.message);
  }
}

// Real-time listener — updates UI when any other device saves
function startRealtimeListener() {
  if (_fbUnsubscribe) _fbUnsubscribe(); // cleanup old listener
  _fbUnsubscribe = firebaseDB.collection('vacationSystem').doc('data')
    .onSnapshot(doc => {
      if (!doc.exists) return;
      const data = doc.data();
      // Don't apply if this was our own write (updatedBy = us, within 2s)
      const updatedBy = data.updatedBy;
      const updatedAt = data.updatedAt ? new Date(data.updatedAt) : null;
      const isOwnWrite = updatedBy === currentUser?.username
                      && updatedAt && (Date.now() - updatedAt.getTime()) < 2000;
      if (isOwnWrite) return;

      // Update local storage with cloud data
      const cloudDB = {
        users:            JSON.parse(data.users            || '{}'),
        vacations:        JSON.parse(data.vacations        || '{}'),
        departments:      JSON.parse(data.departments      || '[]'),
        approvalRequests: JSON.parse(data.approvalRequests || '[]'),
        deptManagers:     JSON.parse(data.deptManagers     || '{}'),
        auditLog:         JSON.parse(data.auditLog         || '[]'),
        settings:         JSON.parse(data.settings         || '{}'),
        permissions:      JSON.parse(data.permissions      || '{}'),
        announcements:    JSON.parse(data.announcements    || '[]'),
        sick:             JSON.parse(data.sick             || '{}'),
        dailyStatus:      JSON.parse(data.dailyStatus      || '{}'),
        handovers:        JSON.parse(data.handovers        || '{}'),
        handoversArchive: JSON.parse(data.handoversArchive || '{}'),
        handoverPending:  JSON.parse(data.handoverPending  || '{}'),
        orgTree:          JSON.parse(data.orgTree          || '{}'),
        timeClockRecords: JSON.parse(data.timeClockRecords || '{}'),
        customQA:         JSON.parse(data.customQA         || '[]'),
      };
      ensureAdminExists(cloudDB);
      _saveDBLocal(cloudDB);

      // Refresh current visible tab
      if (currentUser) {
        refreshCurrentTab();
        // בדוק אם התווסף handoverPending לעובד הנוכחי מ-Firebase (מנהל אישר)
        // אפס throttle כדי לאפשר פופאפ מיידי אם יש pending חדש
        const newPending = cloudDB.handoverPending?.[currentUser.username];
        const prevAt     = _lastKnownPending?.approvedAt;
        const newAt      = newPending?.approvedAt;
        // אם הגיע pending חדש שלא הוגש — פתח פופאפ מיד
        if (newPending && !newPending.submitted && newAt !== prevAt) {
          _lastKnownPending = newPending;
          _handoverPopupOpen = false;
          setTimeout(checkHandoverNeeded, 800);
        } else {
          checkHandoverNeeded();
        }
        renderMyHandoverCard();
      }
      // Silent sync — no toast notification needed
    }, err => {
      console.warn('Listener error:', err.message);
    });
}

function refreshCurrentTab() {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
  if (!activeTab) return;
  if (activeTab === 'dashboard') renderDashboard();
  else if (activeTab === 'calendar') renderCalendar();
  else if (activeTab === 'yearly') renderYearly();
  else if (activeTab === 'report') renderReport();
  else if (activeTab === 'admin') renderAdmin();
  else if (activeTab === 'manager') renderManagerDashboard();
}

function updateFirebaseBadge(connected) {
  firebaseConnected = connected;
  const badge = document.getElementById('firebaseBadge');
  const text  = document.getElementById('firebaseStatusText');
  if (badge) badge.className = connected ? 'firebase-badge connected' : 'firebase-badge';
  if (text)  text.textContent = connected ? '🔥 מחובר' : '⚠️ לא מחובר';
}

// Override saveDB — every save goes to cloud automatically
function saveDB(db) {
  _saveDBLocal(db);
  if (firebaseConnected) pushToFirebase().catch(e => console.warn('saveDB push error:', e));
}

// Firebase admin modal (for manual ops like reset)
function openFirebaseModal() {
  const statusDiv = document.getElementById('firebaseStatusDiv');
  if (firebaseConnected) {
    statusDiv.innerHTML = '<div class="alert alert-success"><span class="alert-icon">✅</span><span>מחובר ל-Firebase בזמן אמת — כל שינוי מסונכרן אוטומטית לכל המכשירים</span></div>';
    document.getElementById('fbDisconnectBtn').style.display = '';
    document.getElementById('fbResetBtn').style.display = '';
  } else {
    statusDiv.innerHTML = '<div class="alert" style="background:var(--danger-light);color:var(--danger);border:1px solid #fca5a5;"><span class="alert-icon">⚠️</span><span>לא מחובר — עובד במצב לא מקוון. הנתונים נשמרים מקומית בלבד.</span></div>';
    document.getElementById('fbDisconnectBtn').style.display = 'none';
    document.getElementById('fbResetBtn').style.display = 'none';
  }
  openModal('firebaseModal');
}

async function connectFirebase() {
  const btn = document.querySelector('#firebaseModal .btn-primary');
  if(btn) { btn.textContent = '⏳ מתחבר...'; btn.disabled = true; }
  await initFirebase();
  if(btn) { btn.textContent = '🔥 התחבר ל-Firebase'; btn.disabled = false; }
  openFirebaseModal();
}

function disconnectFirebase() {
  if (_fbUnsubscribe) { _fbUnsubscribe(); _fbUnsubscribe = null; }
  firebaseConnected = false;
  firebaseDB = null;
  updateFirebaseBadge(false);
  document.getElementById('fbDisconnectBtn').style.display = 'none';
  document.getElementById('fbResetBtn').style.display = 'none';
  document.getElementById('firebaseStatusDiv').innerHTML =
    '<div class="alert alert-info"><span class="alert-icon">🔌</span><span>נותק. הנתונים נשמרים מקומית בלבד.</span></div>';
  showToast('🔌 נותק מ-Firebase', 'warning');
}

async function resetFirebase() {
  if (!firebaseConnected || !firebaseDB) { showToast('⚠️ לא מחובר ל-Firebase', 'warning'); return; }
  if (!confirm('⚠️ איפוס Firebase\n\nימחק את כל הנתונים בענן ויסנכרן מחדש מהנתונים המקומיים.\n\nלהמשיך?')) return;
  try {
    await firebaseDB.collection('vacationSystem').doc('data').delete();
    await pushToFirebase();
    showToast('✅ Firebase אופס ומסונכרן מחדש', 'success');
  } catch(err) {
    showToast('❌ שגיאה: ' + err.message, 'error');
  }
}

// Legacy alias
async function syncToFirebase() { return pushToFirebase(); }
async function syncFromFirebase() { return pullFromFirebase(); }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}


document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('loginScreen').classList.contains('active')) {
    doLogin();
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
});

// Auto-update selects year when year changes in dashboard
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  initDarkMode();
  initOfflineDetection();
});

// ============================================================
// DEPT POPULATE (simple select)
// ============================================================

// ============================================================
// SUBMIT REQUEST TO MANAGER
// ============================================================
function openSubmitModal() {
  const {year, month} = calState;
  const vacs = getVacations(currentUser.username);
  const monthStr = String(month).padStart(2,'0');
  const monthVacs = Object.entries(vacs).filter(([dt]) => dt.startsWith(`${year}-${monthStr}`));
  
  if (!monthVacs.length) {
    showToast('⚠️ אין ימי חופשה בחודש זה לשליחה', 'warning');
    return;
  }
  
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  let html = `<div style="background:var(--surface2);border-radius:10px;padding:16px;margin-bottom:12px;">
    <div style="font-weight:700;margin-bottom:8px;">📅 ${MONTHS[month-1]} ${year} — ${currentUser.fullName}</div>`;
  
  let totalDays = 0;
  monthVacs.sort(([a],[b]) => a.localeCompare(b)).forEach(([dt, type]) => {
    const d = new Date(dt + 'T00:00:00');
    const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
    const typeLabel = type === 'full' ? 'יום מלא' : type === 'half' ? 'חצי יום' : 'WFH';
    const days = type === 'full' ? 1 : type === 'half' ? 0.5 : 0;
    totalDays += days;
    const payM = getPayrollMonth(dt, getSettings()).month;
    html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${d.getDate()}/${d.getMonth()+1} (${dayNames[d.getDay()]})</span>
      <span>${typeLabel}</span>
      <span style="color:var(--text-muted);">תלוש: ${MONTHS[payM-1]}</span>
    </div>`;
  });
  html += `<div style="font-weight:700;margin-top:8px;color:var(--primary);">סה"כ: ${totalDays} ימים</div></div>`;

  // Show who will receive this request
  const db = getDB();
  const managerUsername = getDeptManagerForUser(currentUser.username);
  const managerName = managerUsername ? db.users[managerUsername]?.fullName : null;
  if (managerName) {
    html += `<div style="background:var(--primary-light);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--primary-dark);margin-bottom:4px;">
      👤 הבקשה תועבר למנהל/ת: <strong>${managerName}</strong>
    </div>`;
  } else {
    html += `<div style="background:#fef3c7;border-radius:8px;padding:10px 14px;font-size:13px;color:#92400e;margin-bottom:4px;">
      ⚠️ לא הוגדר מנהל למחלקה שלך — הבקשה תועבר לאדמין
    </div>`;
  }
  
  document.getElementById('submitPreview').innerHTML = html;
  document.getElementById('submitNote').value = '';
  openModal('submitModal');
}

function doSubmitRequest(note) {
  const {year, month} = calState;
  const vacs = getVacations(currentUser.username);
  const monthStr = String(month).padStart(2,'0');
  const monthVacs = Object.entries(vacs).filter(([dt]) => dt.startsWith(`${year}-${monthStr}`));
  
  if (!monthVacs.length) {
    showToast('⚠️ אין ימי חופשה בחודש זה לשליחה', 'warning');
    return;
  }

  const db = getDB();
  if (!db.approvalRequests) db.approvalRequests = [];
  
  // Remove old pending for same month/user
  db.approvalRequests = db.approvalRequests.filter(r =>
    !(r.username === currentUser.username && r.year === year && r.month === month && r.status === 'pending')
  );
  
  const dates = monthVacs.map(([dt]) => dt);
  const totalDays = monthVacs.reduce((sum,[,type]) => sum + (type==='full'?1:type==='half'?0.5:0), 0);
  
  db.approvalRequests.push({
    id: 'req_' + Date.now(),
    username: currentUser.username,
    fullName: currentUser.fullName,
    dept: (currentUser.dept?.[0] || currentUser.dept || ''),
    assignedManager: getDeptManagerForUser(currentUser.username), // auto-assign manager
    year, month,
    dates,
    dateRange: dates.length===1 ? dates[0] : `${dates[0]} – ${dates[dates.length-1]}`,
    days: totalDays,
    vacations: Object.fromEntries(monthVacs),
    note: note || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  // ── בקשה חדשה — אפס מצב פרוטוקול כדי שיתחיל מחדש לאחר אישור ──
  if (db.handoverPending && db.handoverPending[currentUser.username]) {
    delete db.handoverPending[currentUser.username];
  }
  // מחק גם פרוטוקול ישן לתאריכים אלה כדי לא לבלבל
  dates.forEach(dt => {
    const k = currentUser.username + '_' + dt;
    if (db.handovers && db.handovers[k]) delete db.handovers[k];
  });

  saveDB(db);
  auditLog('vacation_request', `${currentUser.fullName} הגיש בקשה — ${totalDays} ימים`);
}

async function resetLocalData() {
  const confirmed = confirm(
    '⚠️ איפוס מלא של כל הנתונים\n\n' +
    'פעולה זו תמחק:\n' +
    '• כל העובדים (חוץ מ-admin)\n' +
    '• כל ימי החופשה\n' +
    '• כל המכסות\n' +
    '• גם מ-Firebase!\n\n' +
    'הנתונים יחזרו למצב ברירת המחדל.\n' +
    'האם להמשיך?'
  );
  if (!confirmed) return;

  // Stop real-time listener before wiping to prevent it from restoring data
  if (_fbUnsubscribe) { _fbUnsubscribe(); _fbUnsubscribe = null; }

  // Keep ONLY admin password — wipe everything else including settings/departments
  const currentDB = getDB();
  const adminUser  = currentDB.users?.admin || null;

  // Start from a completely clean default DB
  const freshDB = initDB();
  if (adminUser) freshDB.users['admin'] = adminUser; // preserve only admin password

  // Override to truly empty — no departments, no settings
  freshDB.departments = [];
  freshDB.settings    = {};

  // Save locally
  localStorage.setItem(DB_KEY, JSON.stringify(freshDB));

  // Push truly empty state to Firebase
  if (firebaseDB) {
    try {
      const payload = {
        users:            JSON.stringify(freshDB.users),
        vacations:        JSON.stringify({}),
        departments:      JSON.stringify(freshDB.departments),
        approvalRequests: JSON.stringify([]),
        deptManagers:     JSON.stringify({}),
        auditLog:         JSON.stringify([]),
        settings:         JSON.stringify({}),
        permissions:      JSON.stringify({}),
        announcements:    JSON.stringify([]),
        sick:             JSON.stringify({}),
        dailyStatus:      JSON.stringify({}),
        handovers:        JSON.stringify({}),
        updatedAt:        new Date().toISOString(),
        updatedBy:        'system_reset'
      };
      await firebaseDB.collection('vacationSystem').doc('data').set(payload);
      showToast('✅ כל הנתונים אופסו — מקומית ו-Firebase. מרענן...', 'success');
    } catch(e) {
      showToast('⚠️ אופס מקומית. שגיאת Firebase: ' + e.message, 'warning');
    }
  } else {
    showToast('✅ הנתונים אופסו. מרענן...', 'success');
  }
  setTimeout(() => location.reload(), 1500);
}

function importBackup(input) {
  const file = input.files[0];
  if (!file) return;
  if (!confirm('⚠️ שחזור גיבוי יחליף את כל הנתונים הקיימים.\n\nהאם להמשיך?')) {
    input.value = ''; return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object' || !data.users) {
        showToast('❌ קובץ לא תקין — חסר מידע עובדים', 'error'); return;
      }
      const curDB = getDB();
      if (!data.users.admin && curDB.users.admin) data.users.admin = curDB.users.admin;
      _saveDBLocal(data);
      pushToFirebase().catch(() => {});
      auditLog('backup_restored', 'גיבוי שוחזר מקובץ: ' + file.name);
      showToast('✅ גיבוי שוחזר בהצלחה — טוען מחדש...', 'success');
      setTimeout(() => location.reload(), 1500);
    } catch(err) {
      showToast('❌ שגיאה בקריאת הקובץ: ' + err.message, 'error');
    }
  };
  reader.readAsText(file, 'utf-8');
  input.value = '';
}

function exportBackup() {
  const db = getDB();
  const json = JSON.stringify(db, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  a.download = `vacation_backup_${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('💾 גיבוי הורד בהצלחה', 'success');
}

// ============================================================

function renderApprovalRequests() {
  // Redirect to manager dashboard which has the full approval UI
  renderManagerDashboard();
}

function openApprovalModal(reqId) {
  const db = getDB();
  const req = (db.approvalRequests || []).find(r => r.id == reqId);
  if (!req) return;
  currentApprovalId = reqId;
  const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const DAY_NAMES = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

  document.getElementById('approvalModalTitle').textContent = `📋 בקשת חופשה — ${req.fullName}`;

  let html = `<div style="background:var(--surface2);border-radius:10px;padding:16px;margin-bottom:12px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:14px;">
      <div><strong>עובד:</strong> ${req.fullName}</div>
      <div><strong>מחלקה:</strong> ${req.dept||''}</div>
      <div><strong>תקופה:</strong> ${req.dateRange || (MONTHS[(req.month||1)-1] + ' ' + req.year)}</div>
      <div><strong>נשלח:</strong> ${new Date(req.createdAt||req.submittedAt).toLocaleDateString('he-IL')}</div>
    </div>`;

  if (req.note) html += `<div style="background:var(--warning-light);padding:10px;border-radius:8px;font-size:13px;margin-bottom:12px;">💬 <strong>הערה:</strong> ${req.note}</div>`;

  const vacsObj = req.vacations || Object.fromEntries((req.dates||[]).map(d=>[d,req.type||'full']));
  let total = 0;
  html += `<table style="width:100%;font-size:13px;border-collapse:collapse;">
    <thead><tr style="background:var(--surface2);">
      <th style="padding:8px;text-align:right;">תאריך</th><th style="padding:8px;text-align:right;">יום</th>
      <th style="padding:8px;text-align:right;">סוג</th><th style="padding:8px;text-align:right;">תלוש</th>
    </tr></thead><tbody>`;
  Object.entries(vacsObj).sort(([a],[b])=>a.localeCompare(b)).forEach(([dt,type])=>{
    const d = new Date(dt+'T00:00:00');
    const typeLabel = type==='full'?'יום מלא':type==='half'?'חצי יום':'WFH';
    total += type==='full'?1:type==='half'?0.5:0;
    const payM = getPayrollMonth(dt, getSettings()).month;
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}</td>
      <td style="padding:8px;">${DAY_NAMES[d.getDay()]}</td>
      <td style="padding:8px;">${typeLabel}</td>
      <td style="padding:8px;color:var(--text-muted);">${MONTHS[payM-1]}</td>
    </tr>`;
  });
  html += `</tbody><tfoot><tr style="font-weight:700;background:var(--primary-light);">
    <td colspan="2" style="padding:8px;">סה"כ</td>
    <td colspan="2" style="padding:8px;color:var(--primary);">${total} ימים</td>
  </tr></tfoot></table></div>
  <div class="modal-footer">
    <button class="btn btn-outline" onclick="closeModal('approvalModal')">סגור</button>
    <button class="btn" style="background:var(--danger-light);color:var(--danger);border:1px solid #fca5a5;" onclick="rejectRequestPrompt('${req.id}');closeModal('approvalModal');">❌ דחה</button>
    <button class="btn btn-success" onclick="approveRequest('${req.id}');closeModal('approvalModal');">✅ אשר</button>
  </div>`;

  document.getElementById('approvalModalContent').innerHTML = html;
  openModal('approvalModal');
}



// ============================================================
// EMPLOYEE LIST — SELECT + SINGLE ROW EDIT
// ============================================================
let _currentEditEmp = null;

function renderSelectedEmployee() {
  const sel = document.getElementById('empListSelect');
  const username = sel ? sel.value : '';
  const editRow = document.getElementById('empListEditRow');
  if (!editRow) return;

  if (!username) {
    editRow.style.display = 'none';
    _currentEditEmp = null;
    return;
  }

  const db = getDB();
  const u = db.users[username];
  if (!u) return;
  _currentEditEmp = username;

  const cb = calcBalance(username, new Date().getFullYear());
  const roleLabel = u.role === 'admin' ? '🛡️ מנהל' : u.role === 'accountant' ? '💼 חשבות' : '👤 עובד';
  const roleBadge = u.role === 'admin' ? 'badge-admin' : u.role === 'accountant' ? 'badge-accountant' : 'badge-user';

  document.getElementById('empEditName').textContent = u.fullName;
  document.getElementById('empEditRole').innerHTML = `<span class="badge ${roleBadge}" style="font-size:11px;">${roleLabel}</span>`;
  document.getElementById('empEditDept').textContent = u.dept || '';
  document.getElementById('empEditUsername').textContent = username;
  document.getElementById('empEditBirthday').value = u.birthday || '';
  document.getElementById('empEditSalary').value = u.dailySalary || '';
  document.getElementById('empEditQuota').textContent = cb.annual + ' ימים';
  document.getElementById('empEditUsed').textContent = cb.stats.total;
  document.getElementById('empEditBalance').innerHTML = `<span class="badge ${cb.balance < 0 ? 'badge-negative' : 'badge-positive'}">${cb.balance.toFixed(1)}</span>`;

  // Disable delete for admin
  const delBtn = document.getElementById('empEditDelete');
  if (delBtn) delBtn.disabled = username === 'admin';

  editRow.style.display = 'block';
  editRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEmpEdit() {
  const editRow = document.getElementById('empListEditRow');
  if (editRow) editRow.style.display = 'none';
  const sel = document.getElementById('empListSelect');
  if (sel) sel.value = '';
  _currentEditEmp = null;
}

function saveEmpBirthdayEdit() {
  if (!_currentEditEmp) return;
  const val = document.getElementById('empEditBirthday').value;
  saveEmpBirthday(_currentEditEmp, val);
}

function saveEmpSalaryEdit() {
  if (!_currentEditEmp) return;
  const val = document.getElementById('empEditSalary').value;
  saveEmpSalary(_currentEditEmp, val);
}

function openResetPasswordModalEdit() {
  if (!_currentEditEmp) return;
  openResetPasswordModal(_currentEditEmp);
}

function openChangePasswordModalEdit() {
  if (!_currentEditEmp) return;
  openChangePasswordModal(_currentEditEmp);
}

function deleteEmployeeEdit() {
  if (!_currentEditEmp) return;
  closeEmpEdit();
  deleteEmployee(_currentEditEmp);
}


// ============================================================
// PERMISSIONS — SELECT + SINGLE EMPLOYEE EDIT
// ============================================================
function renderPermForEmployee() {
  const sel = document.getElementById('permEditSelect');
  const container = document.getElementById('permEditRow');
  if (!sel || !container) return;

  const username = sel.value;
  if (!username) {
    container.style.display = 'none';
    return;
  }

  const db = getDB();
  const u = db.users[username];
  if (!u) return;

  const perms = getUserPermissions(username);
  const grantableSections = PERMISSION_SECTIONS.filter(s => !s.adminOnly);
  const hasAccess = grantableSections.some(s => perms[s.key]);

  container.innerHTML = `
    <div style="background:var(--surface);border:1.5px solid var(--primary);border-radius:14px;padding:18px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <div>
          <span style="font-size:16px;font-weight:900;">${u.fullName}</span>
          <span style="font-size:12px;color:var(--text-muted);margin-right:8px;">${u.role === 'manager' ? '👔 מנהל' : '👤 עובד'} · ${Array.isArray(u.dept)?u.dept[0]:u.dept||''}</span>
          <span style="font-size:11px;padding:3px 10px;border-radius:10px;font-weight:700;background:${hasAccess ? 'var(--success-light)' : 'var(--surface2)'};color:${hasAccess ? 'var(--success)' : 'var(--text-muted)'};">${hasAccess ? '✅ יש גישה' : '— אין גישה'}</span>
        </div>
        <button onclick="document.getElementById('permEditRow').style.display='none';document.getElementById('permEditSelect').value='';"
          style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 14px;cursor:pointer;font-family:'Heebo',sans-serif;font-size:13px;font-weight:700;">✕ סגור</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        ${grantableSections.map(s => `
          <label style="display:flex;align-items:center;gap:6px;background:var(--surface2);border:1.5px solid ${perms[s.key] ? 'var(--primary)' : 'var(--border)'};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:12px;font-weight:600;transition:border-color 0.15s;">
            <input type="checkbox" id="perm_${username}_${s.key}" ${perms[s.key] ? 'checked' : ''}
              onchange="updatePermCheckbox('${username}','${s.key}',this.checked,this)"
              style="width:15px;height:15px;accent-color:var(--primary);">
            ${s.label}
          </label>
        `).join('')}
      </div>
      <button onclick="savePermissionsForUser('${username}')"
        style="background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:white;border:none;border-radius:10px;padding:10px 24px;font-size:14px;font-weight:800;cursor:pointer;font-family:'Heebo',sans-serif;">
        💾 שמור הרשאות
      </button>
    </div>`;

  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updatePermCheckbox(username, key, checked, el) {
  // Update border color visually
  if (el) {
    const label = el.closest('label');
    if (label) label.style.borderColor = checked ? 'var(--primary)' : 'var(--border)';
  }
}

function savePermissionsForUser(username) {
  const db = getDB();
  const grantableSections = PERMISSION_SECTIONS.filter(s => !s.adminOnly);
  const perms = {};
  grantableSections.forEach(s => {
    const cb = document.getElementById(`perm_${username}_${s.key}`);
    if (cb) perms[s.key] = cb.checked;
  });
  if (!db.permissions) db.permissions = {};
  db.permissions[username] = perms;
  saveDB(db);
  pushToFirebase();
  showToast('✅ הרשאות נשמרו', 'success');
  // Refresh the row
  renderPermForEmployee();
}



// ============================================================
// DAZURA SPLASH SCREEN — 2030 FUTURISTIC
// ============================================================
window.addEventListener('load', function() {
  const splash = document.getElementById('dazura-splash');
  if (!splash) return;

  // Apply saved splash theme
  try {
    const raw = localStorage.getItem('vacSystem_v3');
    if (raw) {
      const db = JSON.parse(raw);

      // Apply saved splash theme
      const savedTheme = db.settings?.splashTheme || 1;
      splash.className = `splash-theme-${savedTheme}`;

      // System name
      const sysName = db.settings?.systemName?.trim() || 'Dazura';
      const titleEl = document.getElementById('dazuraTitle');
      if (titleEl) titleEl.textContent = sysName;

      // Company name
      const company = (db.settings?.companyName && db.settings.companyName !== 'החברה שלי')
        ? db.settings.companyName : '';
      const compEl = document.getElementById('dazuraCompany');
      if (compEl) compEl.textContent = company;

      // Live stats — today
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const todayKey = `${yyyy}-${mm}-${dd}`;

      let vacation = 0, wfh = 0, sick = 0;
      for (const uname of Object.keys(db.users || {})) {
        const type = (db.vacations?.[uname] || {})[todayKey];
        if (type === 'full' || type === 'half') vacation++;
        else if (type === 'wfh') wfh++;
        else if (type === 'sick') sick++;
      }
      document.getElementById('dazNum0').textContent = vacation;
      document.getElementById('dazNum1').textContent = wfh;
      document.getElementById('dazNum2').textContent = sick;
    }
  } catch(e) {}

  // Generate particles
  const particles = document.getElementById('splashParticles');
  if (particles) {
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('div');
      p.className = 'splash-particle';
      const size = Math.random() * 3 + 1;
      p.style.cssText = `
        left:${Math.random()*100}%;top:${Math.random()*100}%;
        width:${size}px;height:${size}px;
        --dur:${2+Math.random()*4}s;
        --delay:-${Math.random()*4}s;
        opacity:${0.2+Math.random()*0.8};
      `;
      particles.appendChild(p);
    }
  }

  // Progress bar animation
  const progressBar = document.getElementById('splashProgressBar');
  const duration = (() => {
    try {
      const db = JSON.parse(localStorage.getItem('vacSystem_v3') || '{}');
      return (db.settings?.splashTiming || 2) * 1000;
    } catch(e) { return 2000; }
  })();

  if (progressBar) {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(100, (elapsed / duration) * 100);
      progressBar.style.width = pct + '%';
      if (pct >= 100) clearInterval(interval);
    }, 50);
  }

  setTimeout(function() {
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    setTimeout(() => {
      splash.style.display = 'none';
      if(splash.parentNode) splash.remove();
    }, 700);
  }, duration);
});





function toggleAIPanel() {
  const panel = document.getElementById('aiPanel');
  const btn   = document.getElementById('aiFloatBtn');
  if (!panel) return;
  _aiPanelOpen = !_aiPanelOpen;
  panel.classList.toggle('open', _aiPanelOpen);
  if (_aiPanelOpen) {
    setTimeout(() => { document.getElementById('aiInput')?.focus(); }, 300);
    scrollAIToBottom();
  }
}

async function sendAIMessage() {
  const input = document.getElementById('aiInput');
  const msg = input?.value.trim();
  if (!msg) return;
  if (!currentUser) { showToast('⚠️ יש להתחבר כדי להשתמש ב-AI', 'warning'); return; }

  input.value = '';

  appendAIMessage(msg, 'user');
  showAITyping();

  const delay = 350 + Math.random() * 300;

  try {
    const db = getDB();
    const freshUser = (db.users && db.users[currentUser.username]) ? db.users[currentUser.username] : currentUser;

    // DazuraAI v5 — pipeline מלא כולל Fuse
    setTimeout(() => {
      hideAITyping();
      let response;
      try {
        response = DazuraAI.respond(msg, freshUser, db);
      } catch(e) {
        response = 'אירעה שגיאה בעיבוד השאלה. נסה שוב.';
      }
      appendAIMessage(response, 'ai');
      scrollAIToBottom();
    }, delay);
  } catch(e) {
    setTimeout(() => {
      hideAITyping();
      appendAIMessage('אירעה שגיאה. נסה שוב.', 'ai');
    }, delay);
  }
}

function appendAIMessage(text, role) {
  const messages = document.getElementById('aiMessages');
  if (!messages) return;

  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';

  // Safe HTML render: bold + bullets + newlines
  const safe = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  bubble.innerHTML = safe;

  div.appendChild(bubble);
  messages.appendChild(div);
  scrollAIToBottom();
}

let _typingEl = null;
function showAITyping() {
  const messages = document.getElementById('aiMessages');
  if (!messages) return;
  _typingEl = document.createElement('div');
  _typingEl.className = 'ai-msg ai';
  _typingEl.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
  messages.appendChild(_typingEl);
  scrollAIToBottom();
}
function hideAITyping() {
  if (_typingEl) { _typingEl.remove(); _typingEl = null; }
}

function scrollAIToBottom() {
  const messages = document.getElementById('aiMessages');
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function clearAIChat() {
  const messages = document.getElementById('aiMessages');
  if (messages) {
    messages.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon">🤖</div><p>שיחה חדשה. שאל אותי כל שאלה!</p></div>';
  }
  if (typeof DazuraAI !== 'undefined') DazuraAI.clearHistory();
  if (typeof DazuraFuse !== 'undefined') DazuraFuse.clearHistory();
}

// Show AI button after login
function showAIButton() {
  const btn = document.getElementById('aiFloatBtn');
  if (btn) btn.style.display = '';
}
function hideAIButton() {
  const btn = document.getElementById('aiFloatBtn');
  if (btn) btn.style.display = 'none';
  const panel = document.getElementById('aiPanel');
  if (panel) panel.classList.remove('open');
  _aiPanelOpen = false;
}

// ============================================================
// SPLASH SETTINGS (ADMIN)
// ============================================================
let _selectedSplash = 1;
function selectSplash(n) {
  _selectedSplash = n;
  document.querySelectorAll('.splash-option').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.splash) === n);
  });
}
function openSplashSelector() {
  const db = getDB();
  const saved = db.settings?.splashTheme || 1;
  _selectedSplash = saved;
  const timing = db.settings?.splashTiming || 2;
  const inp = document.getElementById('splashTimingInput');
  const val = document.getElementById('splashTimingVal');
  if (inp) inp.value = timing;
  if (val) val.textContent = timing;
  document.querySelectorAll('.splash-option').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.splash) === saved);
  });
  openModal('splashSelectorModal');
}
function saveSplashSettings() {
  const timing = parseInt(document.getElementById('splashTimingInput')?.value || 2);
  const db = getDB();
  db.settings.splashTheme = _selectedSplash;
  db.settings.splashTiming = timing;
  saveDB(db);
  closeModal('splashSelectorModal');
  showToast('✅ הגדרות Splash נשמרו', 'success');
}


// ============================================================
// 📋 HANDOVER PROTOCOLS — Manager Tab
// ============================================================

function renderHandoverList() {
  const el = document.getElementById('handoverList');
  if (!el) return;
  const db = getDB();
  const handovers = db.handovers || {};
  const today = new Date().toISOString().split('T')[0];

  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'accountant';
  const isManager = currentUser.role === 'manager' || isUserDeptManager(currentUser.username);

  // Get departments this manager manages
  const myDepts = (() => {
    const deptManagers = db.deptManagers || {};
    return Object.entries(deptManagers)
      .filter(([dept, mgr]) => mgr === currentUser.username)
      .map(([dept]) => dept);
  })();

  const list = Object.values(handovers).filter(h => {
    if (isAdmin) return true; // admin sees all
    // Manager sees: explicitly assigned to them, OR employee in their dept
    if (h.managerUsername === currentUser.username) return true;
    if (isManager && myDepts.length > 0) {
      const empUser = db.users[h.user];
      if (empUser) {
        const empDepts = Array.isArray(empUser.dept) ? empUser.dept : [empUser.dept].filter(Boolean);
        return empDepts.some(d => myDepts.includes(d));
      }
    }
    // role=manager with no dept assignment — see all handovers
    if (currentUser.role === 'manager') return true;
    return false;
  }).sort((a, b) => a.date.localeCompare(b.date));

  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:14px;">אין פרוטוקולים ממתינים 🎉</div>';
    return;
  }

  // עדכן badge
  const badge = document.getElementById('handoverBadge');
  if (badge) {
    const newCount = list.filter(h => !h.seenByManager).length;
    if (newCount > 0) { badge.textContent = newCount + ' חדש'; badge.style.display = 'inline'; }
    else badge.style.display = 'none';
  }

  el.innerHTML = list.map(h => {
    const dateHeb = new Date(h.date + 'T00:00:00').toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long' });
    const isPast = h.date < today;
    const seen = h.seenByManager ? '<span style="color:var(--success);font-size:11px;">✅ נקרא</span>' : '<span style="color:var(--warning);font-size:11px;">🔔 חדש</span>';
    const pastTag = isPast ? '<span style="color:var(--text-muted);font-size:11px;">• עבר</span>' : '';
    const tasks = h.tasks.map((t,i) => `<div style="font-size:13px;color:var(--text-secondary);padding:3px 0;">${i+1}. ${t}</div>`).join('');
    const contact = h.contact ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">📞 מחליף/ה: ${h.contact}</div>` : '';
    const key = h.user + '_' + h.date;
    return `
      <div style="background:var(--surface2);border-radius:14px;padding:16px;margin-bottom:10px;border-right:4px solid ${isPast ? 'var(--border-strong)' : 'var(--primary)'};opacity:${isPast ? 0.6 : 1}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div>
            <div style="font-weight:800;font-size:15px;">👤 ${h.fullName}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">📅 ${dateHeb} ${pastTag}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${seen}
            <button onclick="printHandoverPDF('${key}')" style="background:none;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;color:var(--primary);padding:4px 8px;font-family:'Heebo',sans-serif;" title="שמור כ-PDF">📄 PDF</button>
            <button onclick="deleteHandover('${key}')" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--danger);padding:4px;" title="מחק מהתצוגה">🗑️</button>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:10px;">${tasks}${contact}</div>
      </div>`;
  }).join('');
}

function printHandoverPDF(key) {
  const db = getDB();
  // חפש ב-archive קודם, אחר כך ב-handovers
  const h = (db.handoversArchive && db.handoversArchive[key]) || (db.handovers && db.handovers[key]);
  if (!h) { showToast('פרוטוקול לא נמצא', 'error'); return; }

  const dateHeb = new Date(h.date + 'T00:00:00').toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const createdHeb = h.createdAt ? new Date(h.createdAt).toLocaleDateString('he-IL', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
  const tasksHtml = h.tasks.map((t,i) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;width:28px;">${i+1}.</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${t}</td></tr>`
  ).join('');

  const win = window.open('', '_blank', 'width=720,height=600');
  win.document.write(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8">
<title>פרוטוקול העברת מקל — ${h.fullName}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  body{font-family:'Heebo',sans-serif;direction:rtl;margin:0;padding:32px;color:#1e293b;background:#fff;}
  h1{font-size:22px;font-weight:800;color:#1a56e8;margin-bottom:4px;}
  .sub{font-size:13px;color:#64748b;margin-bottom:24px;}
  .card{background:#f8fafc;border-radius:12px;padding:20px 24px;margin-bottom:20px;border:1px solid #e2e8f0;}
  .label{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
  .value{font-size:15px;font-weight:600;color:#1e293b;}
  table{width:100%;border-collapse:collapse;margin-top:8px;}
  .footer{margin-top:32px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px;}
  @media print{body{padding:16px;}}
</style></head>
<body>
<h1>📋 פרוטוקול העברת מקל</h1>
<div class="sub">נוצר: ${createdHeb}</div>
<div class="card">
  <div style="display:flex;gap:32px;flex-wrap:wrap;">
    <div><div class="label">שם העובד</div><div class="value">👤 ${h.fullName}</div></div>
    <div><div class="label">תאריך חופשה</div><div class="value">📅 ${dateHeb}</div></div>
    ${h.contact ? `<div><div class="label">מחליף/ה</div><div class="value">📞 ${h.contact}</div></div>` : ''}
  </div>
</div>
<div class="card">
  <div class="label">משימות לטיפול</div>
  <table><tbody>${tasksHtml}</tbody></table>
</div>
<div class="footer">Dazura — מערכת ניהול חופשות | הופק אוטומטית</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}

// הצג פרוטוקול בדוח האישי של העובד
function renderMyHandoverCard() {
  if (!currentUser) return;
  // רק לעובדים — לא למנהל/אדמין
  const isEmployee = currentUser.role === 'employee' || !currentUser.role;
  const btn       = document.getElementById('myHandoverBtn');
  const mobileBtn = document.getElementById('myHandoverBtnMobile');

  if (!isEmployee) {
    if (btn)       btn.style.display = 'none';
    if (mobileBtn) mobileBtn.style.display = 'none';
    return;
  }

  const db = getDB();
  const today = new Date().toISOString().split('T')[0];

  // חפש בarchive ובhandovers
  const seen = new Set();
  const myRecords = [
    ...Object.values(db.handoversArchive || {}),
    ...Object.values(db.handovers || {})
  ]
  .filter(h => h.user === currentUser.username)
  .filter(h => {
    const k = h.user + '_' + h.date;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .filter(h => {
    const vacDates = Array.isArray(h.dates) && h.dates.length > 0 ? h.dates : [h.date];
    return vacDates.slice().sort().pop() >= today;
  });

  const hasActive = myRecords.length > 0;

  // כפתור desktop — תמיד גלוי לעובד, כחול כשיש פרוטוקול פעיל
  if (btn) {
    btn.style.display = '';
    btn.style.color = hasActive ? 'var(--primary)' : '';
    btn.style.fontWeight = hasActive ? '800' : '';
  }

  // כפתור מובייל — תמיד גלוי לעובד
  if (mobileBtn) {
    mobileBtn.style.display = '';
    mobileBtn.style.color = hasActive ? 'var(--primary)' : '';
  }
}

function openMyHandoverPopup() {
  const db = getDB();
  const today = new Date().toISOString().split('T')[0];

  const allSources = [
    ...Object.values(db.handoversArchive || {}),
    ...Object.values(db.handovers || {})
  ];
  const seen2 = new Set();
  const myRecords = allSources
    .filter(h => h.user === currentUser.username)
    .filter(h => {
      const k = h.user + '_' + h.date;
      if (seen2.has(k)) return false;
      seen2.add(k);
      return true;
    })
    .filter(h => {
      const vacDates = Array.isArray(h.dates) && h.dates.length > 0 ? h.dates : [h.date];
      return vacDates.slice().sort().pop() >= today;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const el = document.getElementById('myHandoverPopupContent');
  if (!el) return;

  if (!myRecords.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">אין פרוטוקול פעיל כרגע.</div>';
    openModal('myHandoverPopup');
    return;
  }

  el.innerHTML = `
    <div style="text-align:center;font-size:32px;margin-bottom:6px;">📋</div>
    <div class="modal-title" style="justify-content:center;margin-bottom:18px;">פרוטוקול העברת מקל שלי</div>
  ` + myRecords.map(h => {
    const vacDates = (Array.isArray(h.dates) && h.dates.length > 0 ? h.dates : [h.date]).slice().sort();
    const firstDate = vacDates[0];
    const lastDate  = vacDates[vacDates.length - 1];
    const totalDays = vacDates.length;

    const fmtDate      = dt => new Date(dt + 'T00:00:00').toLocaleDateString('he-IL', { day:'numeric', month:'long', year:'numeric' });
    const fmtDateShort = dt => new Date(dt + 'T00:00:00').toLocaleDateString('he-IL', { day:'numeric', month:'long' });
    const rangeLabel   = firstDate === lastDate ? fmtDate(firstDate) : `${fmtDateShort(firstDate)} – ${fmtDate(lastDate)}`;

    const isActive   = today >= firstDate && today <= lastDate;
    const statusText = isActive ? '🟢 בחופשה עכשיו' : '⏳ מתוכננת';
    const statusBg   = isActive ? '#dcfce7' : 'var(--primary-light)';
    const statusClr  = isActive ? '#166534' : 'var(--primary-dark)';

    const tasks = h.tasks.map((t, i) =>
      `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:12px;color:var(--text-muted);min-width:18px;">${i+1}.</span>
        <span style="font-size:13px;color:var(--text);">${t}</span>
      </div>`
    ).join('');

    const contact = h.contact
      ? `<div style="display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 14px;background:var(--primary-light);border-radius:10px;">
           <span style="font-size:18px;">👤</span>
           <div>
             <div style="font-size:11px;color:var(--primary-dark);font-weight:700;">ממלא/ת מקום</div>
             <div style="font-size:14px;font-weight:800;color:var(--text);">${h.contact}</div>
           </div>
         </div>`
      : '';

    return `
      <div style="background:var(--surface2);border-radius:14px;overflow:hidden;margin-bottom:10px;border:1px solid var(--border);">
        <div style="background:linear-gradient(135deg,var(--primary),var(--primary-dark));padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:800;color:white;">📅 ${rangeLabel}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.8);margin-top:2px;">${totalDays} יום${totalDays>1?'ים':''}</div>
          </div>
          <span style="background:${statusBg};color:${statusClr};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;">${statusText}</span>
        </div>
        <div style="padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">משימות להעברה</div>
          ${tasks}
          ${contact}
          <div style="margin-top:10px;font-size:11px;color:var(--text-muted);">🔒 ישמר עד ${fmtDateShort(lastDate)}</div>
        </div>
      </div>`;
  }).join('');

  openModal('myHandoverPopup');
}


function deleteHandover(key) {
  if (!confirm('להסיר פרוטוקול זה מהתצוגה?')) return;
  const db = getDB();
  if (db.handovers && db.handovers[key]) {
    delete db.handovers[key]; // מוחק מתצוגת מנהל בלבד; archive נשמר
    saveDB(db);
    showToast('🗑️ פרוטוקול הוסר מהתצוגה', 'success');
    renderHandoverList();
  }
}

function clearAllHandovers() {
  if (!confirm('להסיר את כל הפרוטוקולים מהתצוגה?')) return;
  const db = getDB();
  const isAdmin = currentUser.role === 'admin';
  Object.keys(db.handovers || {}).forEach(key => {
    const h = db.handovers[key];
    if (isAdmin || h.managerUsername === currentUser.username) {
      delete db.handovers[key]; // archive נשמר
    }
  });
  saveDB(db);
  showToast('🗑️ כל הפרוטוקולים הוסרו מהתצוגה', 'success');
  renderHandoverList();
}

function exportHandoversExcel() {
  const db = getDB();
  const handovers = db.handovers || {};
  const today = new Date().toISOString().split('T')[0];
  const isAdmin = currentUser.role === 'admin';

  const list = Object.values(handovers).filter(h =>
    (isAdmin || h.managerUsername === currentUser.username) && h.date >= today
  ).sort((a, b) => a.date.localeCompare(b.date));

  if (!list.length) { showToast('אין פרוטוקולים לייצוא', 'warning'); return; }

  // Build CSV (Excel-compatible with BOM for Hebrew)
  const BOM = '\uFEFF';
  const headers = ['שם עובד', 'תאריך חופשה', 'משימה 1', 'משימה 2', 'משימה 3', 'מחליף/ה', 'נקרא'];
  const rows = list.map(h => [
    h.fullName,
    h.date,
    h.tasks[0] || '',
    h.tasks[1] || '',
    h.tasks[2] || '',
    h.contact || '',
    h.seenByManager ? 'כן' : 'לא'
  ]);

  const csv = BOM + [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `פרוטוקולי_העברת_מקל_${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📊 הקובץ הורד בהצלחה', 'success');
}


// ============================================================
// CUSTOM Q&A MANAGEMENT
// ============================================================

function renderCustomQAList() {
  const el = document.getElementById('customQAList');
  if (!el) return;
  const db = getDB();
  const qa = db.customQA || [];

  if (!qa.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">אין שאלות מוגדרות עדיין. הוסף שאלות למעלה.</div>';
    return;
  }

  el.innerHTML = qa.map((entry, idx) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">
        <div style="flex:1;">
          <div style="font-weight:700;font-size:13px;color:var(--primary);">❓ ${entry.question}</div>
          ${entry.tags ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">🏷️ ${entry.tags}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button onclick="editCustomQAEntry(${idx})" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;font-family:'Heebo',sans-serif;">✏️</button>
          <button onclick="deleteCustomQAEntry(${idx})" style="background:var(--danger-light);color:var(--danger);border:1px solid #fca5a5;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;font-family:'Heebo',sans-serif;">🗑️</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text);background:var(--surface2);border-radius:8px;padding:8px 12px;">💬 ${entry.answer}</div>
    </div>
  `).join('');
}

function saveCustomQAEntry() {
  const questionRaw = document.getElementById('qaNewQuestion')?.value.trim();
  const answer      = document.getElementById('qaNewAnswer')?.value.trim();
  const tagsRaw     = document.getElementById('qaNewTags')?.value.trim();

  if (!questionRaw || !answer) {
    showToast('⚠️ נא למלא שאלה ותשובה', 'warning'); return;
  }

  // Support multiple question phrasings separated by comma
  const questions = questionRaw.split(',').map(q => q.trim()).filter(Boolean);
  const primaryQ  = questions[0];
  const aliases   = questions.slice(1);
  const tags      = tagsRaw || '';

  const db = getDB();
  if (!db.customQA) db.customQA = [];

  const editIdx = document.getElementById('qaNewQuestion').dataset.editIdx;
  if (editIdx !== undefined && editIdx !== '') {
    db.customQA[parseInt(editIdx)] = { question: primaryQ, aliases, answer, tags };
    showToast('✅ שאלה עודכנה', 'success');
  } else {
    db.customQA.push({ question: primaryQ, aliases, answer, tags });
    showToast('✅ שאלה נוספה ל-AI', 'success');
  }

  saveDB(db);
  pushToFirebase().catch(() => {});
  auditLog('custom_qa_save', `שאלה נוספה/עודכנה: "${primaryQ}"`);

  // Clear form
  document.getElementById('qaNewQuestion').value = '';
  document.getElementById('qaNewQuestion').removeAttribute('data-edit-idx');
  document.getElementById('qaNewAnswer').value = '';
  document.getElementById('qaNewTags').value = '';

  renderCustomQAList();
}

function editCustomQAEntry(idx) {
  const db = getDB();
  const entry = (db.customQA || [])[idx];
  if (!entry) return;

  const q = document.getElementById('qaNewQuestion');
  const a = document.getElementById('qaNewAnswer');
  const t = document.getElementById('qaNewTags');
  if (!q || !a) return;

  const allQ = [entry.question, ...(entry.aliases||[])].join(', ');
  q.value = allQ;
  q.dataset.editIdx = idx;
  a.value = entry.answer;
  if (t) t.value = entry.tags || '';

  q.scrollIntoView({ behavior: 'smooth', block: 'center' });
  q.focus();
}

function deleteCustomQAEntry(idx) {
  const db = getDB();
  const entry = (db.customQA || [])[idx];
  if (!entry) return;
  if (!confirm(`למחוק את השאלה: "${entry.question}"?`)) return;
  db.customQA.splice(idx, 1);
  saveDB(db);
  pushToFirebase().catch(() => {});
  renderCustomQAList();
  showToast('🗑️ שאלה נמחקה', 'info');
}

function exportCustomQA() {
  const db = getDB();
  const qa = db.customQA || [];
  if (!qa.length) { showToast('אין שאלות לייצוא', 'warning'); return; }

  const BOM = '﻿';
  const header = 'שאלה,ניסוחים נוספים,תשובה,תגיות';
  const rows = qa.map(e => [
    '"' + (e.question||'').replace(/"/g,'""') + '"',
    '"' + (e.aliases||[]).join('|').replace(/"/g,'""') + '"',
    '"' + (e.answer||'').replace(/"/g,'""') + '"',
    '"' + (e.tags||'').replace(/"/g,'""') + '"'
  ].join(','));
  const csv = BOM + [header, ...rows].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'custom_qa_' + new Date().toISOString().split('T')[0] + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('📤 ייצוא הושלם', 'success');
}

function importCustomQA(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const db = getDB();
      if (!db.customQA) db.customQA = [];
      let added = 0;

      if (file.name.endsWith('.json')) {
        const data = JSON.parse(e.target.result);
        const arr = Array.isArray(data) ? data : (data.customQA || []);
        arr.forEach(item => {
          if (item.question && item.answer) { db.customQA.push(item); added++; }
        });
      } else {
        // CSV
        const lines = e.target.result.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1);
        lines.forEach(line => {
          if (!line.trim()) return;
          const cols = [];
          let cur = '', inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"' && !inQ) { inQ = true; }
            else if (ch === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
            else if (ch === '"' && inQ) { inQ = false; }
            else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
            else { cur += ch; }
          }
          cols.push(cur);
          const [question, aliasesRaw, answer, tags] = cols;
          if (question && answer) {
            const aliases = aliasesRaw ? aliasesRaw.split('|').filter(Boolean) : [];
            db.customQA.push({ question: question.trim(), aliases, answer: answer.trim(), tags: (tags||'').trim() });
            added++;
          }
        });
      }

      saveDB(db);
      pushToFirebase().catch(() => {});
      showToast('✅ יובאו ' + added + ' שאלות', 'success');
      renderCustomQAList();
    } catch(err) {
      showToast('❌ שגיאה בקריאת הקובץ: ' + err.message, 'error');
    }
  };
  reader.readAsText(file, 'utf-8');
  input.value = '';
}
