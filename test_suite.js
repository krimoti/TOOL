// ============================================================
// DAZURA AI — Test Suite v1.0
// בדיקת דיוק הצ'אטבוט על 60 שאילתות מייצגות
// ============================================================

// ── Mock DB ──────────────────────────────────────────────────
const today = new Date();
const todayKey = today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
const tomorrowD = new Date(today); tomorrowD.setDate(today.getDate()+1);
const tomorrowKey = tomorrowD.getFullYear()+'-'+String(tomorrowD.getMonth()+1).padStart(2,'0')+'-'+String(tomorrowD.getDate()).padStart(2,'0');

const MOCK_DB = {
  users: {
    'moshe': { username:'moshe', fullName:'משה לוי', dept:'פיתוח', role:'employee', status:'active', quotas:{ [today.getFullYear()]: { annual:24, initialBalance:0 } } },
    'sarah': { username:'sarah', fullName:'שרה כהן', dept:'מכירות', role:'manager', status:'active', quotas:{ [today.getFullYear()]: { annual:18, initialBalance:3 } } },
    'david': { username:'david', fullName:'דוד מזרחי', dept:'פיתוח', role:'employee', status:'active', quotas:{ [today.getFullYear()]: { annual:21, initialBalance:0 } } },
    'admin': { username:'admin', fullName:'אדמין מערכת', dept:'', role:'admin', status:'active', quotas:{ [today.getFullYear()]: { annual:24, initialBalance:5 } } },
  },
  vacations: {
    'sarah': { [todayKey]: 'full' },
    'david': { [todayKey]: 'wfh', [tomorrowKey]: 'sick' },
  },
  departments: ['פיתוח', 'מכירות', 'HR'],
  deptManagers: { 'מכירות': 'sarah', 'פיתוח': 'admin' },
  approvalRequests: [
    { username:'moshe', fullName:'משה לוי', date: tomorrowKey, status:'pending', submittedAt: new Date().toISOString() }
  ],
};

const USER_EMPLOYEE = MOCK_DB.users['moshe'];
const USER_ADMIN    = MOCK_DB.users['admin'];
const USER_MANAGER  = MOCK_DB.users['sarah'];

// ── Load ai.js ────────────────────────────────────────────────
// Stubs for browser globals
global.window = {};
global.HOLIDAYS = {
  ['2026-4-2']: { n:'פסח', blocked:true },
  ['2026-5-22']: { n:'שבועות', blocked:true },
};
global.AI_KNOWLEDGE = []; // נטען מ-knowledge.js — כאן ריק לבדיקת ai.js בלבד

const { respond, clearHistory } = require('/home/claude/ai.js');

// ── Test Runner ───────────────────────────────────────────────
let passed = 0, failed = 0, warnings = 0;
const results = [];

function test(category, query, user, expectedKeywords, forbiddenKeywords = [], matchMode = 'AND') {
  clearHistory();
  const response = respond(query, user, MOCK_DB);
  const res = response || '';

  const hasExpected = matchMode === 'OR' ? expectedKeywords.some(kw => res.includes(kw)) : expectedKeywords.every(kw => res.includes(kw));
  const hasForbidden = forbiddenKeywords.some(kw => res.includes(kw));

  const status = (hasExpected && !hasForbidden) ? 'PASS' : 'FAIL';
  if (status === 'PASS') passed++; else failed++;

  results.push({ category, query, status, response: res.slice(0,120).replace(/\n/g,' ') });

  if (status === 'FAIL') {
    console.log(`❌ [${category}] "${query}"`);
    if (!hasExpected) console.log(`   חסר: ${expectedKeywords.filter(k=>!res.includes(k)).join(', ')}`);
    if (hasForbidden) console.log(`   אסור: ${forbiddenKeywords.filter(k=>res.includes(k)).join(', ')}`);
    console.log(`   תגובה: ${res.slice(0,100)}`);
  }
  return status;
}

// ════════════════════════════════════════════════════════════
// CATEGORY 1 — שיחה חופשית (אסור לחזור תשובות KB)
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 1: שיחה חופשית\n');
test('שיחה', 'שלום',          USER_EMPLOYEE, ['משה'],               ['יום מלא','יתרה ידועה','חצי יום']);
test('שיחה', 'היי',           USER_EMPLOYEE, ['משה'],               ['יום מלא','מנוכה']);
test('שיחה', 'מה נשמע',       USER_EMPLOYEE, ['משה'],               ['יום מלא','חצי יום','0.5','מנוכה']);
test('שיחה', 'מה שלומך',      USER_EMPLOYEE, ['משה'],               ['יום מלא','חצי יום']);
test('שיחה', 'מה קורה',       USER_EMPLOYEE, ['משה'],               ['יום מלא','חצי יום','0.5']);
test('שיחה', 'תודה',          USER_EMPLOYEE, ['😊','בשמחה','הנאה שלי','על לא דבר'], [], 'OR');
test('שיחה', 'להתראות',       USER_EMPLOYEE, ['להתראות','ביי','שלום'], ['יום מלא'], 'OR');
test('שיחה', 'בוקר טוב',      USER_EMPLOYEE, ['משה'],               ['יום מלא']);
test('שיחה', 'מי יצר אותך',   USER_EMPLOYEE, ['מוטי'],              []);
test('שיחה', 'ספר בדיחה',     USER_EMPLOYEE, ['😄'],                ['יתרה']);

// ════════════════════════════════════════════════════════════
// CATEGORY 2 — יתרה וצבירה
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 2: יתרה וצבירה\n');
test('יתרה', 'מה היתרה שלי',        USER_EMPLOYEE, ['משה','ימים','מכסה'],      []);
test('יתרה', 'כמה ימים יש לי',       USER_EMPLOYEE, ['ימים','מכסה'],           []);
test('יתרה', 'יתרה',                  USER_EMPLOYEE, ['ימים'],                  ['מי בחופשה','מי WFH','היום — חופשה']);
test('יתרה', 'כמה ניצלתי השנה',      USER_EMPLOYEE, ['ניצול'],                 []);
test('יתרה', 'תחזית',                 USER_EMPLOYEE, ['תחזית','דצמבר','ימים'], []);
test('יתרה', 'מה תחזית היתרה שלי',   USER_EMPLOYEE, ['תחזית','ימים'],         []);
test('יתרה', 'כמה ימי חופש מגיעים לי', USER_EMPLOYEE, ['24','ימים'],           []);

// ════════════════════════════════════════════════════════════
// CATEGORY 3 — נוכחות צוות
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 3: נוכחות\n');
test('נוכחות', 'מי בחופשה היום',   USER_ADMIN, ['שרה'],              ['יום מלא = 1','מנוכה','חצי יום = 0.5']);
test('נוכחות', 'מי WFH היום',       USER_ADMIN, ['דוד'],              ['יום מלא','מנוכה']);
test('נוכחות', 'מי חולה מחר',       USER_ADMIN, ['דוד'],              ['יום מלא','מנוכה']);
test('נוכחות', 'מי עובד',           USER_ADMIN, ['צוות','משרד'],      ['מחלה לא נרשמ','נרשמים בנפרד','מנוכה']);
test('נוכחות', 'מצב הצוות היום',    USER_ADMIN, ['חופשה','WFH'],      []);
test('נוכחות', 'מי נמצא במשרד',     USER_ADMIN, ['משרד'],             ['יום מלא','מנוכה']);
test('נוכחות', 'כמה אנשים במשרד',   USER_ADMIN, ['משרד','WFH'],       []);

// ════════════════════════════════════════════════════════════
// CATEGORY 4 — מחלקות ועובדים
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 4: מחלקות ועובדים\n');
test('מחלקות', 'מחלקות',              USER_ADMIN, ['פיתוח','מכירות'],  []);
test('מחלקות', 'איזה מחלקות יש',      USER_ADMIN, ['פיתוח','מכירות'],  []);
test('מחלקות', 'מי בצוות שלי',        USER_EMPLOYEE, ['פיתוח'],        []);
test('מחלקות', 'מי המנהל שלי',        USER_EMPLOYEE, ['מנהל'],          []);
test('מחלקות', 'כמה עובדים יש',       USER_ADMIN, ['עובדים'],           []);
test('מחלקות', 'רשימת עובדים',        USER_ADMIN, ['משה','שרה','דוד'], []);

// ════════════════════════════════════════════════════════════
// CATEGORY 5 — שאלות מערכת (KB)
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 5: שאלות מערכת\n');
test('מערכת', 'איך מגישים בקשת חופשה',  USER_EMPLOYEE, ['לוח','תאריך'],   []);
test('מערכת', 'איך מבטלים חופשה',        USER_EMPLOYEE, ['בטל'],           []);
test('מערכת', 'מה ההבדל בין חופשה ל WFH', USER_EMPLOYEE, ['WFH','יתרה'],   []);
test('מערכת', 'מה ההבדל בין יום מלא לחצי יום', USER_EMPLOYEE, ['0.5','יום'], []);
test('מערכת', 'האם ימי מחלה נספרים ביתרה', USER_EMPLOYEE, ['לא'],          []);
test('מערכת', 'איך מוסיפים עובד חדש',    USER_ADMIN,    ['ניהול'],         []);
test('מערכת', 'איך מחברים Firebase',      USER_ADMIN,    ['Firebase','API'], []);
test('מערכת', 'מה זה Dazura',             USER_EMPLOYEE, ['Dazura'],        []);

// ════════════════════════════════════════════════════════════
// CATEGORY 6 — הקשר שיחה (Context Memory)
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 6: הקשר שיחה\n');

// מבחן 1: שאל על חופשה → המשך עם "ומחר?"
clearHistory();
respond('מי בחופשה היום', USER_ADMIN, MOCK_DB);
const ctxResp1 = respond('ומחר?', USER_ADMIN, MOCK_DB);
const ctx1Pass = ctxResp1 && (ctxResp1.includes('מחר') || ctxResp1.includes('דוד') || ctxResp1.includes('חופשה') || ctxResp1.includes('אין'));
console.log(ctx1Pass ? '✅ [הקשר] "מי בחופשה" → "ומחר?" — ענה על מחר' : '❌ [הקשר] "מי בחופשה" → "ומחר?" — לא ענה על מחר');
ctx1Pass ? passed++ : failed++;

// מבחן 2: שאל יתרה → "ואני?"
clearHistory();
respond('מה היתרה שלי', USER_ADMIN, MOCK_DB);
const ctxResp2 = respond('ואני?', USER_ADMIN, MOCK_DB);
const ctx2Pass = ctxResp2 && ctxResp2.includes('ימים');
console.log(ctx2Pass ? '✅ [הקשר] "מה היתרה" → "ואני?" — ענה עם ימים' : '❌ [הקשר] "מה היתרה" → "ואני?" — לא ענה נכון');
ctx2Pass ? passed++ : failed++;

// מבחן 3: שאל "מי WFH" → "והשבוע?"
clearHistory();
respond('מי WFH היום', USER_ADMIN, MOCK_DB);
const ctxResp3 = respond('והשבוע?', USER_ADMIN, MOCK_DB);
const ctx3Pass = ctxResp3 && (ctxResp3.includes('שבוע') || ctxResp3.includes('WFH') || ctxResp3.includes('אין'));
console.log(ctx3Pass ? '✅ [הקשר] "מי WFH" → "והשבוע?" — ענה על שבוע' : '❌ [הקשר] "מי WFH" → "והשבוע?" — לא ענה על שבוע');
ctx3Pass ? passed++ : failed++;

// ════════════════════════════════════════════════════════════
// CATEGORY 7 — הרשאות
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 7: הרשאות\n');
test('הרשאות', 'רשימת עובדים', USER_EMPLOYEE, ['אין לך הרשאה'], []);
test('הרשאות', 'רשימת עובדים', USER_ADMIN,    ['משה','שרה'],    ['אין לך הרשאה']);
test('הרשאות', 'בקשות ממתינות', USER_MANAGER, ['ממתינות','משה'], ['אין לך הרשאה']);

// ════════════════════════════════════════════════════════════
// CATEGORY 8 — Fallback חכם
// ════════════════════════════════════════════════════════════
console.log('\n📋 CATEGORY 8: Fallback\n');
test('fallback', 'בלה בלה בלה שטויות',  USER_EMPLOYEE, ['נסה','שאלה','עזרה'], ['יום מלא = 1','חצי יום = 0.5']);
test('fallback', 'xyz123nonsense',        USER_EMPLOYEE, ['משה'],               ['יום מלא = 1']);
test('fallback', 'מה',                    USER_EMPLOYEE, ['מה'],                []);

// ════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════
const total = passed + failed;
const pct = Math.round(passed/total*100);

console.log('\n' + '═'.repeat(50));
console.log(`📊 תוצאות סופיות:`);
console.log(`   ✅ עברו: ${passed}/${total} (${pct}%)`);
console.log(`   ❌ נכשלו: ${failed}/${total} (${100-pct}%)`);
console.log('═'.repeat(50));

// לפי קטגוריה
const cats = {};
results.forEach(r => {
  if (!cats[r.category]) cats[r.category] = {p:0,f:0};
  r.status==='PASS' ? cats[r.category].p++ : cats[r.category].f++;
});
// הוסף context ו-hרשאות
console.log('\n📈 לפי קטגוריה:');
for (const [cat, {p,f}] of Object.entries(cats)) {
  const total2 = p+f;
  const pct2 = Math.round(p/total2*100);
  const bar = '█'.repeat(Math.round(pct2/10)) + '░'.repeat(10-Math.round(pct2/10));
  console.log(`   ${cat.padEnd(10)} [${bar}] ${pct2}% (${p}/${total2})`);
}
