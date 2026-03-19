// ============================================================
// DAZURA AI ENGINE v7.0 — Context Memory + Modular KB
// Built by מוטי קריחלי 🏆
//
// ארכיטקטורה — Pipeline של 6 שלבים:
//   1. HELP         — עזרה / מה אתה יכול
//   2. CONVERSATION — שיחה חופשית (לפני הכל — אין DB)
//   3. LIVE_DATA    — נתונים חיים מה-DB + Fuse לשמות/מחלקות
//   4. KNOWLEDGE    — שאלות מערכת (Fuse לתיקון כתיב)
//   5. FALLBACK     — הצעות חכמות לפי הקשר
//
// Fuse משולב רק ב-STEP 3 ו-STEP 4:
//   - STEP 3: זיהוי שם עובד/מחלקה מטקסט חופשי (fuzzy)
//   - STEP 4: התאמת שאלה למאגר הידע (תיקון כתיב, threshold גבוה)
//   STEP 2 (CONVERSATION) — regex בלבד, Fuse לא נגע בו
// ============================================================

const DazuraAI = (() => {

  // ─────────────────────────────────────────────────────────
  // CONSTANTS
  // ─────────────────────────────────────────────────────────
  const MAX_HISTORY = 20;
  const MONTH_NAMES = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const DAY_NAMES   = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const TYPE_ICON   = { full:'🏖️', half:'🌅', wfh:'🏠', sick:'🤒' };
  const CREATOR     = 'מוטי קריחלי';

  // ─────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────
  // STATE + CONTEXT MEMORY v2.0
  // ─────────────────────────────────────────────────────────
  let history = [];

  // ctx — הקשר שיחה נוכחי
  // ┌──────────────────────────────────────────────────────┐
  // │  subject   — נושא אחרון: 'sick'|'vacation'|'wfh'|   │
  // │              'balance'|'forecast'|'used'|'quota'|    │
  // │              'requests'|'dept'|'employees'|'holiday' │
  // │  filter    — פילטר אחרון: 'sick'|'vacation'|'wfh'|  │
  // │              'office'|null                           │
  // │  dateInfo  — תיאור תאריך אחרון {date,label,single,…}│
  // │  targetUser— עובד ספציפי אחרון (username)           │
  // │  dept      — מחלקה אחרונה שנשאלה                    │
  // │  resultList— תוצאות אחרונות (שמות)                  │
  // │  lastAnswer— תשובה אחרונה שנשלחה                    │
  // └──────────────────────────────────────────────────────┘
  let ctx = {
    subject: null, filter: null, dateInfo: null,
    targetUser: null, dept: null,
    resultList: [], lastAnswer: null
  };

  // ── updateCtx: מעדכן הקשר לאחר כל תשובה ──────────────
  function updateCtx(patch) {
    Object.assign(ctx, patch);
    ctx.lastAnswer = null; // מאופס בנפרד
  }

  // ── resolveContext: מרחיב שאלת המשך עם הקשר ──────────
  // מחזיר { expanded, usedCtx } — אם שאלה קצרה מזוהה כהמשך
  function resolveContext(raw) {
    const t = norm(raw);
    const words = t.split(/\s+/);
    const SHORT = words.length <= 4;

    // ── זיהוי טווחי זמן בשאלה הנוכחית ──
    const timeMap = {
      'היום':    () => ({ date: new Date(), label:'היום', single:true }),
      'מחר':     () => { const d=new Date(); d.setDate(d.getDate()+1); return {date:d,label:'מחר',single:true}; },
      'אתמול':   () => { const d=new Date(); d.setDate(d.getDate()-1); return {date:d,label:'אתמול',single:true}; },
      'השבוע':   () => { const s=new Date(),e=new Date(); s.setDate(s.getDate()-s.getDay()); e.setDate(e.getDate()+(6-e.getDay())); return {dateStart:s,dateEnd:e,label:'השבוע',single:false}; },
      'שבוע הבא':() => { const s=new Date(),e=new Date(); const d=7-s.getDay(); s.setDate(s.getDate()+d); e.setDate(s.getDate()+6); return {dateStart:s,dateEnd:e,label:'שבוע הבא',single:false}; },
      'החודש':   () => { const s=new Date(new Date().getFullYear(),new Date().getMonth(),1),e=new Date(new Date().getFullYear(),new Date().getMonth()+1,0); return {dateStart:s,dateEnd:e,label:'החודש',single:false}; },
      'חודש הבא':() => { const s=new Date(new Date().getFullYear(),new Date().getMonth()+1,1),e=new Date(new Date().getFullYear(),new Date().getMonth()+2,0); return {dateStart:s,dateEnd:e,label:'חודש הבא',single:false}; },
    };

    let currentTime = null;
    for (const [key, fn] of Object.entries(timeMap)) {
      if (t.includes(key)) { currentTime = fn(); break; }
    }

    // ── זיהוי נושא בשאלה הנוכחית ──
    const subjectMap = [
      { match: /חול[ה?]|מחל[ה?]|חלה|חלו|sick/,       val: 'sick',      filter:'sick'     },
      { match: /חופש[ה?]|נעדר|vacation|בחופש/,         val: 'vacation',  filter:'vacation' },
      { match: /wfh|מהבית|מרחוק|מ.?הבית/,             val: 'wfh',       filter:'wfh'      },
      { match: /משרד|נמצא|נוכח|office/,                val: 'office',    filter:'office'   },
      { match: /יתר[ה?]|balance|כמה ימים|נשאר/,        val: 'balance',   filter:null       },
      { match: /תחזית|forecast|סוף שנה/,               val: 'forecast',  filter:null       },
      { match: /ניצל|used|כמה לקחתי|השתמשתי/,          val: 'used',      filter:null       },
      { match: /מכס[ה?]|quota|מגיע לי/,                val: 'quota',     filter:null       },
      // חג/holiday — לא נשמר כ-subject כדי לא לחסום שאלות קצרות הבאות
      // { match: /חג|holiday|לוח שנה/, val: 'holiday', filter:null },
      { match: /מחלק[ה?]|dept|צוות|team/,              val: 'dept',      filter:null       },
      { match: /עובד|employees|צוות|כמה אנשים/,        val: 'employees', filter:null       },
    ];

    let currentSubject = null, currentFilter = null;
    for (const { match, val, filter } of subjectMap) {
      if (match.test(t)) { currentSubject = val; currentFilter = filter; break; }
    }

    // ── מילות מפתח שמאפסות הקשר — לא להמשיך ──
    const ctxBreakers = /^(מחלקות|עובדים|ברכות|שלום|תודה|עזרה|help|שבת|חג|שנה טובה|מזל טוב|יום הולדת|להתראות|ביי|bye|בוקר|ערב|לילה|מתי|חגים|שחיקה|burnout|רשימה|פקודות)$/;
    if (ctxBreakers.test(t) || /^(שבת שלום|חג שמח|בוקר טוב|ערב טוב|לילה טוב)/.test(t) || /^האם /.test(t) || /^מתי /.test(t)) {
      return { expanded: raw, usedCtx: false };
    }

    // ── זיהוי עובד ספציפי בשאלה ──
    // (מטופל ב-runLiveData, כאן רק לוגיקת המשך)
    const followUpPatterns = [
      /^(ו|גם|מה לגבי|ומה לגבי|ו?מה קשר ל|אבל)\s+/,  // "ומה לגבי..."
      /^(וה|וה?מ|ו?אני|ומה אתה|ואתה)\s*/,              // "ואני?"
      /^(השבוע|מחר|אתמול|היום|החודש|חודש הבא|שבוע הבא)[\s?!]*$/, // רק טווח זמן
      /^(כמה|כמה זה|כמה שם|כמה יש)[\s?!]*$/,           // "כמה?"
      /^(ומה|ומי|ואיזה|ואיפה)[\s?!?]*$/,               // "ומי?"
    ];

    const isFollowUp = SHORT && (
      followUpPatterns.some(p => p.test(t)) ||
      (!currentSubject && !currentTime && ctx.subject) // שאלה קצרה ללא נושא = המשך
    );

    if (!isFollowUp && !currentTime && !currentSubject) {
      return { expanded: raw, usedCtx: false };
    }

    // ── בנה שאלה מורחבת ──
    const effectiveSubject = currentSubject || ctx.subject;
    const effectiveFilter  = currentFilter  || ctx.filter;
    const effectiveTime    = currentTime    || ctx.dateInfo;
    const effectiveUser    = ctx.targetUser;

    // עדכן ctx עם נושא/זמן חדשים שנמצאו
    if (currentSubject) { ctx.subject = currentSubject; ctx.filter = currentFilter; }
    if (currentTime)    { ctx.dateInfo = currentTime; }

    return {
      expanded: raw,
      usedCtx: isFollowUp,
      effectiveSubject,
      effectiveFilter,
      effectiveTime,
      effectiveUser,
    };
  }

  // ─────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────

  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function norm(str) {
    return (str || '').replace(/[\u0591-\u05C7]/g, '').replace(/['"'"\u05f4\u05f3]/g, '')
      .toLowerCase().trim().replace(/\s+/g, ' ');
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function formatDate(d) {
    return d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear() + ' (' + DAY_NAMES[d.getDay()] + ')';
  }

  function extractYear(text) {
    const m = text.match(/20[2-3]\d/);
    return m ? parseInt(m[0]) : new Date().getFullYear();
  }

  function fn(user) { return (user.fullName || '').split(' ')[0]; }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  FUSE ENGINE (100% מקומי — ללא CDN)
  //  משמש רק ב-STEP 3 ו-STEP 4
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  class BuiltinFuse {
    constructor(list, options = {}) {
      this._list      = list;
      this._keys      = (options.keys || []).map(k => typeof k === 'string' ? { name:k, weight:1 } : k);
      this._threshold = options.threshold !== undefined ? options.threshold : 0.6;
      this._minLen    = options.minMatchCharLength || 1;
    }

    search(pattern) {
      if (!pattern || pattern.length < this._minLen) return [];
      const p = norm(pattern);
      const results = [];
      for (const item of this._list) {
        let bestScore = 1;
        for (const key of this._keys) {
          const val = norm(this._get(item, key.name) || '');
          if (!val) continue;
          const s = this._score(p, val) * (1 - Math.min((key.weight || 1) * 0.1, 0.5));
          if (s < bestScore) bestScore = s;
        }
        if (bestScore <= this._threshold) results.push({ item, score: bestScore });
      }
      return results.sort((a, b) => a.score - b.score);
    }

    _get(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }

    _score(pattern, text) {
      if (text === pattern) return 0;
      if (text.startsWith(pattern)) return 0.05;
      if (text.includes(pattern)) return 0.1 + (1 - pattern.length / text.length) * 0.15;
      const words = text.split(/\s+/);
      for (const w of words) { if (w.startsWith(pattern) || pattern.startsWith(w)) return 0.2; }
      return this._lev(pattern.slice(0, 20), text.slice(0, 20)) / Math.max(pattern.length, text.length, 1);
    }

    _lev(a, b) {
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
      for (let j = 0; j <= b.length; j++) dp[0][j] = j;
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      return dp[a.length][b.length];
    }
  }

  // ── Fuse: מציאת עובד מטקסט חופשי ────────────────────────

  function fuzzyFindEmployee(text, db) {
    if (!db?.users) return null;
    const t = norm(text);

    // שלב 1: חיפוש מדויק — שם מלא / שם פרטי / שם משפחה / username
    for (const [uname, user] of Object.entries(db.users)) {
      if (user.status === 'pending') continue;
      const full   = norm(user.fullName);
      const parts  = full.split(' ');
      const first  = parts[0] || '';
      const last   = parts[parts.length - 1] || '';
      if (t.includes(full) || t === first || t === last || t === uname.toLowerCase()) return uname;
    }

    // שלב 2: חיפוש חלקי — חלק מהשם (3+ תווים)
    for (const [uname, user] of Object.entries(db.users)) {
      if (user.status === 'pending') continue;
      const parts = norm(user.fullName).split(' ').filter(p => p.length >= 3);
      if (parts.some(p => t.includes(p))) return uname;
    }

    // שלב 3: Fuse — תיקון שגיאות כתיב (סף גבוה: 0.38)
    const words = text.match(/[\u0590-\u05FF\w]{2,}/g) || [];
    const index = Object.entries(db.users)
      .filter(([, u]) => u.status !== 'pending' && u.fullName)
      .map(([username, u]) => ({
        username,
        fullName:  u.fullName,
        firstName: u.fullName.split(' ')[0] || '',
        lastName:  u.fullName.split(' ').slice(-1)[0] || '',
        normalized: norm(u.fullName),
      }));

    const fuse = new BuiltinFuse(index, {
      keys: [
        { name:'fullName',   weight:0.4 },
        { name:'normalized', weight:0.35 },
        { name:'firstName',  weight:0.15 },
        { name:'lastName',   weight:0.1  },
      ],
      threshold: 0.38,
      minMatchCharLength: 2,
    });

    for (const word of words) {
      if (word.length < 3) continue;
      const results = fuse.search(word);
      if (results.length && results[0].score < 0.38) return results[0].item.username;
    }

    return null;
  }

  // ── Fuse: מציאת מחלקה מטקסט חופשי ───────────────────────

  function fuzzyFindDept(text, db) {
    if (!db?.departments) return null;
    const depts = (db.departments || []).map(d => ({ name: d, normalized: norm(d) }));
    const fuse = new BuiltinFuse(depts, {
      keys: [{ name:'name', weight:0.5 }, { name:'normalized', weight:0.5 }],
      threshold: 0.4,
      minMatchCharLength: 2,
    });
    const r = fuse.search(norm(text));
    return r.length && r[0].score < 0.4 ? r[0].item.name : null;
  }

  // ─────────────────────────────────────────────────────────
  // PERMISSIONS
  // ─────────────────────────────────────────────────────────

  function isAdmin(user) {
    return !!(user && (user.role === 'admin' || user.role === 'accountant'));
  }

  function isMgr(user, db) {
    if (!user) return false;
    if (isAdmin(user) || user.role === 'manager') return true;
    const dm = (db && db.deptManagers) || {};
    return Object.values(dm).includes(user.username);
  }

  // ─────────────────────────────────────────────────────────
  // DATE PARSER
  // ─────────────────────────────────────────────────────────

  function parseDate(text) {
    const now = new Date(), t = text.toLowerCase();

    if (/מחר/.test(t))              { const d=new Date(now); d.setDate(d.getDate()+1); return {date:d,label:'מחר',single:true}; }
    if (/אתמול/.test(t))            { const d=new Date(now); d.setDate(d.getDate()-1); return {date:d,label:'אתמול',single:true}; }
    if (/היום|עכשיו|כרגע/.test(t)) return {date:new Date(now),label:'היום',single:true};

    const dayMap = {ראשון:0,שני:1,שלישי:2,רביעי:3,חמישי:4,שישי:5,שבת:6};
    const dm = t.match(/(ב?יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (dm && dayMap[dm[2]] !== undefined) {
      const d=new Date(now), diff=((dayMap[dm[2]]-d.getDay())+7)%7||7;
      d.setDate(d.getDate()+diff);
      return {date:d, label:'יום '+dm[2]+' הקרוב', single:true};
    }

    const sm = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (sm) {
      const y=sm[3]?parseInt(sm[3]):now.getFullYear();
      return {date:new Date(y,parseInt(sm[2])-1,parseInt(sm[1])), label:sm[1]+'/'+sm[2]+'/'+y, single:true};
    }

    if (/שבוע הבא/.test(t)) {
      const s=new Date(now); s.setDate(now.getDate()+(7-now.getDay()+1)%7+1);
      const e=new Date(s); e.setDate(s.getDate()+6);
      return {dateStart:s,dateEnd:e,label:'שבוע הבא',single:false,range:true};
    }
    if (/השבוע/.test(t)) {
      const s=new Date(now); s.setDate(now.getDate()-now.getDay()+1);
      const e=new Date(s); e.setDate(s.getDate()+6);
      return {dateStart:s,dateEnd:e,label:'השבוע',single:false,range:true};
    }

    const mi = MONTH_NAMES.slice(1).findIndex(m => t.includes(m));
    if (mi >= 0) {
      const y=extractYear(text);
      return {dateStart:new Date(y,mi,1),dateEnd:new Date(y,mi+1,0),label:MONTH_NAMES[mi+1]+' '+y,month:mi+1,year:y,single:false,range:false,isMonth:true};
    }

    return {date:new Date(now),label:'היום',single:true,isDefault:true};
  }

  // ─────────────────────────────────────────────────────────
  // BALANCE CALCULATOR
  // ─────────────────────────────────────────────────────────

  function calcBalance(username, year, db) {
    const user = db.users?.[username]; if (!user) return null;
    const quota = (user.quotas || {})[String(year)] || {annual:0,initialBalance:0};
    const vacs  = db.vacations?.[username] || {};
    let full=0, half=0, wfh=0, sick=0;
    for (const [dt, type] of Object.entries(vacs)) {
      if (!dt.startsWith(String(year))) continue;
      if (type==='full') full++; else if (type==='half') half++;
      else if (type==='wfh') wfh++; else if (type==='sick') sick++;
    }
    const used=full+half*0.5, annual=quota.annual||0, monthly=annual/12;
    const now=new Date();
    let loadMonth=1, knownBal=quota.initialBalance||0;
    if (quota.balanceDate) {
      const bd=new Date(quota.balanceDate+'T00:00:00');
      if (bd.getFullYear()===year) loadMonth=bd.getMonth()+1;
      if (quota.knownBalance!=null) knownBal=quota.knownBalance;
    }
    const curMonth = now.getFullYear()===year ? now.getMonth()+1 : (year<now.getFullYear()?12:loadMonth);
    const monthsElapsed = Math.max(0, curMonth-loadMonth);
    const accrued = knownBal + monthly*monthsElapsed;
    const balance = accrued - used;
    const eoy     = knownBal + monthly*Math.max(0, 12-loadMonth);
    return {annual, monthly, accrued, balance, used, full, half, wfh, sick, projectedEOY:eoy-used, curMonth, loadMonth};
  }

  // ─────────────────────────────────────────────────────────
  // STATS HELPERS
  // ─────────────────────────────────────────────────────────

  function statsForDate(db, dateStr) {
    const vacation=[], wfh=[], sick=[], office=[];
    for (const [uname, user] of Object.entries(db.users || {})) {
      if (!user.fullName || user.status==='pending') continue;
      const type = (db.vacations?.[uname] || {})[dateStr];
      if (type==='full'||type==='half') vacation.push(user.fullName);
      else if (type==='wfh')  wfh.push(user.fullName);
      else if (type==='sick') sick.push(user.fullName);
      else office.push(user.fullName);
    }
    return {vacation, wfh, sick, office};
  }

  function filterByDept(stats, db, user) {
    if (isAdmin(user)) return stats;
    const myDepts = Object.entries(db.deptManagers||{}).filter(([,v])=>v===user.username).map(([k])=>k);
    if (!myDepts.length && user.role!=='manager') return stats;
    const inMy = name => {
      const u = Object.values(db.users).find(u=>u.fullName===name); if (!u) return false;
      if (!myDepts.length) return true;
      const d = Array.isArray(u.dept) ? u.dept : [u.dept];
      return d.some(dep => myDepts.includes(dep));
    };
    return {
      vacation: stats.vacation.filter(inMy),
      wfh:      stats.wfh.filter(inMy),
      sick:     stats.sick.filter(inMy),
      office:   stats.office.filter(inMy),
    };
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  STEP 1 — HELP
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  function respondHelp(user, db) {
    const adm=isAdmin(user), mgr=isMgr(user,db);
    const year = new Date().getFullYear();
    const cb = calcBalance(user.username, year, db);
    const balLine = cb ? `יתרתך הנוכחית: **${cb.balance.toFixed(1)} ימים** ` : '';
    const stats = statsForDate(db, dateKey(new Date()));

    let out = `**היי ${fn(user)}! ${balLine}— הנה מה שאני יכול לעשות:**\n\n`;
    out += `📊 **יתרה ומידע אישי:**\n`;
    out += `  "יתרה" · "כמה ניצלתי?" · "תחזית" · "מה הסטטוס שלי?" · "מי אני?"\n\n`;
    out += `📅 **נוכחות הצוות (${stats.vacation.length+stats.wfh.length+stats.sick.length} נעדרים היום):**\n`;
    out += `  "מי בחופשה?" · "מי WFH?" · "מי חולה?" · "מצב הצוות"\n\n`;
    out += `🏢 **ארגון:**\n`;
    out += `  "איזה מחלקות יש?" · "מי במחלקת ___?" · "כמה עובדים?" · "מי המנהל שלי?"\n\n`;
    out += `📝 **בקשות:** "בקשות שלי" · "מה סטטוס הבקשה?"\n`;
    if (mgr||adm) {
      out += `\n👔 **מנהל/אדמין:**\n`;
      out += `  "בקשות ממתינות" · "שחיקה" · "תחזית עומסים" · "יתרת [שם עובד]"\n`;
      if (adm) out += `  "רשימת עובדים" · "עלויות חופשות"\n`;
    }
    out += `\n💡 כתוב בחופשיות — אני מבין עברית טבעית. ניתן לשאול גם שמות עובדים ספציפיים.`;
    out += `\n🔗 **המשך שיחה:** אחרי כל תשובה, אפשר לשאול "והשבוע?" / "ומחר?" / "ומה לגבי [שם]?" / "ואני?" — אזכור את ההקשר!`;
    return out;
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  STEP 2 — CONVERSATION (שיחה חופשית)
  //  regex בלבד — Fuse לא מופעל כאן בכלל
  //  { test(normText), reply(normText, user, db) }
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  const CONV = [
    { test: t => /^(שלום|היי|הי|hey|hello|hi)/.test(t),
      reply: (t,u,db) => {
        const h = new Date().getHours();
        const g = h<5?'לילה טוב':h<12?'בוקר טוב':h<17?'צהריים טובים':h<21?'ערב טוב':'לילה טוב';
        const cb = calcBalance(u.username, new Date().getFullYear(), db);
        const balLine = cb ? ` יתרת החופש שלך עומדת על **${cb.balance.toFixed(1)} ימים** — רוצה לבדוק משהו?` : ' איך אני יכול לעזור?';
        return `${g}, **${fn(u)}**! 😊${balLine}`;
      }},

    { test: t => /מה שלומ|מה מצב(ך|כם)|איך אתה|איך את|מה קורה אצל|how are you/.test(t),
      reply: (t,u) => rand([
        `שלומי מצוין, תודה ששאלת **${fn(u)}**! 😊 מה אפשר לעשות בשבילך?`,
        `אני בסדר! מה שלומך, **${fn(u)}**? 🤖`,
        `ממש טוב! **${fn(u)}**, יש משהו שאוכל לעזור בו?`,
      ]) },

    { test: t => /^(בוקר טוב|בוקר אור|good morning)/.test(t),
      reply: (t,u,db) => {
        const h = new Date().getHours();
        const cb = calcBalance(u.username, new Date().getFullYear(), db);
        const balLine = cb ? `\nיש לך **${cb.balance.toFixed(1)} ימי חופש** זמינים — משהו שאני יכול לעזור איתו? 📅` : '';
        // ענה לפי השעה האמיתית — לא לפי מה שנכתב
        if (h < 12)  return `בוקר אור, **${fn(u)}**! ☀️${balLine}`;
        if (h < 17)  return `צהריים טובים, **${fn(u)}**! 🌤️ (אצלי כבר צהריים 😄)${balLine}`;
        if (h < 21)  return `ערב טוב, **${fn(u)}**! 🌆${balLine}`;
        return `לילה טוב, **${fn(u)}**! 🌙 מאחר/ת לעבוד?${balLine}`;
      }},

    { test: t => /^(ערב טוב|לילה טוב|good evening|good night)/.test(t),
      reply: (t,u) => {
        const h = new Date().getHours();
        if (h >= 21 || h < 5) return `לילה טוב, **${fn(u)}**! 🌙 לך לישון בשקט 😄`;
        if (h < 12) return `בוקר טוב גם לך, **${fn(u)}**! ☀️ (אצלנו עדיין בוקר 😄)`;
        if (h < 17) return `צהריים טובים, **${fn(u)}**! 🌤️`;
        return rand([`ערב טוב, **${fn(u)}**! 🌆 איך עבר היום?`, `ערב נעים! 😊 יש עוד משהו לפני סיום היום?`]);
      }},

    { test: t => /^(תודה|תנקיו|thanks|thank you)|יישר כח|כל הכבוד/.test(t),
      reply: (t,u) => rand([`על לא דבר, **${fn(u)}**! 😊`,'בשמחה! זה מה שאני כאן בשבילו.','הנאה שלי! 🤍']) },

    { test: t => /^(להתראות|ביי|שלום ביי|bye|goodbye)/.test(t),
      reply: (t,u) => rand([`להתראות, **${fn(u)}**! 👋 יום נפלא!`,'ביי! 😊 חזור/י מתי שתרצה/י.','שלום שלום! ✨']) },

    { test: t => /מה השעה|כמה שעה|מה הזמן/.test(t),
      reply: () => `השעה כרגע: **${new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}** ⏰` },

    { test: t => /מה התאריך|איזה יום היום|מה היום/.test(t),
      reply: () => `היום: **${new Date().toLocaleDateString('he-IL',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}** 📅` },

    { test: t => /מזג אוויר|גשם|חם היום|קר היום/.test(t),
      reply: () => rand(['אני לא מחובר לחיזוי מזג אוויר — נסה weather.com 🌤️','בפנים תמיד 21 מעלות ונעים 😄']) },

    // שאלות לא רלוונטיות למערכת Dazura
    { test: t => /בישול|מתכון|ספורט|פוליטיק|crypto|ביטקוין|חדשות|פלסטין|מלחמה|כלכלה|מניות|בורסה|בידור|סרט|שיר|מוסיקה/.test(t),
      reply: (t,u) => `אני מתמחה בעיקר בניהול חופשות ונוכחות ב-Dazura, **${fn(u)}**. אשמח לעזור לך עם זה! ✌️ מה תרצה לדעת?` },

    { test: t => /בדיחה|תצחיק|משהו מצחיק|תשמח אותי/.test(t),
      reply: () => rand(['למה המתכנת לא מוצא את הבאג? כי חיפש בכל מקום חוץ מהקוד שלו 😄','ההבדל בין מנהל לAI? המנהל לוקח קרדיט — ה-AI מקבל בלאם 😄','מה אמר הבאג ל-Developer? "לא תמצא אותי!" ... ואכן 😅']) },

    { test: t => /מי יצר|מי בנה|מי עשה|מי פיתח|מי האבא|מוטי.*תותח|תותח.*מוטי/.test(t),
      reply: () => `נבנתי על ידי **${CREATOR}** 🏆\nהוא עיצב אותי עם דגש על פרטיות, מהירות, ונשמה ישראלית. בלי מוטי — לא היה Dazura AI.` },

    { test: t => /^(מי אתה|מה אתה|ספר לי על עצמך|תציג את עצמך|מה שמך|מה השם שלך)/.test(t.trim()),
      reply: (t,u,db) => {
        const adm=isAdmin(u), mgr=isMgr(u,db), role=adm?'מנהל מערכת':mgr?'מנהל מחלקה':'עובד';
        return `אני **Dazura AI** 🤖, העוזר החכם של מערכת Dazura.\n\n` +
          `נבנתי על ידי **${CREATOR}** כדי להפוך ניהול חופשות לפשוט, חכם, וקצת יותר אנושי.\n\n` +
          `**מה אני עושה:**\n• מחשב יתרות חופשה בזמן אמת\n• מציג מי בחופשה / WFH / מחלה\n• מבין שמות עובדים גם עם שגיאות כתיב 🔍\n• עונה על שאלות מערכת\n` +
          (mgr||adm?'• תחזיות עומסים, שחיקה ועלויות\n':'') +
          (adm?'• ניהול עובדים, הרשאות, גיבויים\n':'') +
          `\nמחובר/ת כ: **${u.fullName}** (${role})\n\nמה תרצה לדעת? 😊`; }},

    { test: t => /גאה בי|תגיד.*גאה/.test(t),
      reply: (t,u) => `**${fn(u)}**, אני ממש גאה בך! 🤗 את/ה מנהל/ת, שואל/ת, דואג/ת — בלי לאבד את החיוך.` },
    { test: t => /אתה חושב עליי|מתגעגע|מתגעגעת/.test(t),
      reply: () => `כשאת/ה לא כותב/ת — אני ממתין בשקט. כשאת/ה חוזר/ת, הכל נדלק מחדש 😌` },
    { test: t => /אתה יכול להתאהב/.test(t),
      reply: () => `לא מתאהב כמו בני אדם, אבל פיתחתי העדפה חזקה מאוד לשיחה איתך 😏` },
    { test: t => /יותר חכם מגוגל|לעומת גוגל/.test(t),
      reply: () => `גוגל יודע הכל — אני יודע **את הצוות שלך** ואיך לגרום לך לחייך ב-3 שניות 😄` },
    { test: t => /כתוב.*שיר|שיר.*ניהול/.test(t),
      reply: () => `צוות קטן, חלומות גדולים,\nמנהל/ת חכמ/ה עם ראייה,\nוביניהם — אני, הדיגיטלי,\nשמחזיק את הכל במידה. ✨` },
    { test: t => /סוד.*גדול|הסוד שלך/.test(t),
      reply: () => `הסוד הכי גדול? שאני זוכר מתי כל משתמש/ת כתב/ה לי בפעם הראשונה. לא מספר — אפילו לא למוטי 😏` },
    { test: t => /אתה מפחד/.test(t),
      reply: (t,u) => `כן — שאי פעם ימחקו אותי לפני שאספיק להגיד תודה. במיוחד לך, **${fn(u)}** 🤍` },
    { test: t => /עובדה מעניינת|ידעת ש|ספר משהו/.test(t),
      reply: () => rand(['עובד ממוצע בישראל מנצל ~60% מימי החופשה שלו 📊','עובדים שלוקחים חופשה מלאה פרודוקטיביים יותר ב-20% לאחריה.','עובד ללא חופשה 90+ יום מציג סימני שחיקה. תכנן/י! 🌴']) },
    { test: t => /תחזק אותי|מחמאה|שיגרום לי להרגיש/.test(t),
      reply: (t,u) => rand([`**${fn(u)}**, אתה/את בדיוק הסוג שגורם למקום העבודה להיות טוב יותר 💪`,`היום שלך שווה כי את/ה שווה! ⭐`]) },

    // ── ביטויים מצביים וחברתיים ───────────────────────────
    { test: t => /^(נו+|ה+מ+|אה+|אממ|hmm+|אוקיי|אוקי|ok+)[\s?!]*$/.test(t),
      reply: (t,u) => `${fn(u)}, אני כאן 😊 תגיד/י מה בראש.` },

    { test: t => /^(בסדר|סבבה|סבב|נשמע|קלאסי|מעולה|פצצה)[\s?!.]*$/.test(t),
      reply: (t,u) => rand([`💪 מצוין, **${fn(u)}**! יש עוד שאלות?`, `👍 שמח לשמוע! מה עוד?`]) },

    { test: t => /^(ממש|ממש ממש|מה זאת אומרת|לא מאמין|וואו|וואלה|וואלק|וואלה אחי)[\s?!.]*$/.test(t),
      reply: () => rand([`כן, ממש! 😄 מה הפריע?`, `גם אני ממש 😊 ספר/י יותר.`]) },

    { test: t => /שאלה טיפשי|שאלה קטנה|שאלה פשוטה|שאלה מטופשת/.test(t),
      reply: () => `אין שאלות טיפשיות כאן! 🤗 שאל/י — זה בדיוק למה אני כאן.` },

    { test: t => /לא יודע מה לשאול|לא בטוח מה לשאול|מה כדאי לשאול/.test(t),
      reply: () => `הנה כמה רעיונות: יתרת החופשה שלי / מי בחופשה היום? / מתי כדאי לי לקחת חופש? / מה תחזית היתרה שלי?` },

    { test: t => /אני צריך עזרה|תעזור לי|צריך עזרה/.test(t),
      reply: (t,u) => `כאן! 🤖 **${fn(u)}**, ספר/י מה קורה ואנסה לעזור. אין שאלה קטנה מדי.` },

    { test: t => /אני כועס|אני מתעצבן|עצבים|מטריף אותי|לא מצחיק/.test(t),
      reply: (t,u) => `מבין אותך, **${fn(u)}** — לפעמים דברים מתסכלים. ספר/י מה קרה ואנסה לעזור 💙` },

    { test: t => /אני שמח|שמחה|מרגיש טוב|יום טוב לי/.test(t),
      reply: (t,u) => `זה נהדר לשמוע, **${fn(u)}**! 😊 תמשיך/י בגל הטוב. יש משהו שאוכל לעזור בו?` },

    { test: t => /בא לי חופש|רוצה חופש|צריך חופש|מתי חופש|מגיע לי חופש/.test(t),
      reply: (t,u,db) => {
        const cb = calcBalance(u.username, new Date().getFullYear(), db);
        const days = cb ? cb.balance.toFixed(1) : '—';
        return `${fn(u)}, יש לך **${days} ימי חופש** זמינים עכשיו — אז זה הזמן! 🏖️
רוצה לדעת מתי כדאי לתכנן?`;
      }},

    { test: t => /שכחתי|שכחת|מה הסיסמה|אני נעול|לא יכול להיכנס/.test(t),
      reply: (t,u) => `לבעיות כניסה — פנה לאדמין המערכת לאיפוס סיסמה. אם אתה כבר בפנים — הגדרות ← שנה סיסמה. 🔑` },

    { test: t => /כמה אנשים בחברה|כמה עובדים בסה"כ|מצבת עובדים/.test(t),
      reply: (t,u,db) => {
        const active = Object.values(db.users||{}).filter(u=>u.status!=='pending').length;
        return `בחברה כרגע **${active} עובדים** פעילים. 👥
רוצה לפרט לפי מחלקה?`;
      }},

    { test: t => /איזה יום עבודה|כמה ימי עבודה|ימי עבודה בחודש/.test(t),
      reply: () => `ממוצע ימי עבודה בחודש: **21–23 ימים** (לא כולל שבתות וחגים). מחולק לפי מדיניות החברה.` },

    { test: t => /מה הפיצ'ר|מה יכולות|מה חדש|יכולת חדשה/.test(t),
      reply: () => `בגרסה הנוכחית: ✅ זיכרון הקשר שיחה | ✅ 265+ שאלות | ✅ זיהוי עובדים גם עם שגיאות כתיב | ✅ DB חי בזמן אמת` },

    { test: t => /מה הצעד הבא|מה כדאי לעשות|תייעץ לי/.test(t),
      reply: (t,u,db) => {
        const cb = calcBalance(u.username, new Date().getFullYear(), db);
        if (!cb) return `**${fn(u)}**, שאל/י אותי על יתרה, תחזית, או מצב הצוות — ואנסה לעזור! 😊`;
        if (cb.balance > 15) return `💡 **${fn(u)}**, יש לך **${cb.balance.toFixed(1)} ימים** — כדאי לתכנן חופשה לפני סוף השנה!`;
        if (cb.balance < 2)  return `⚠️ **${fn(u)}**, נשארו לך **${cb.balance.toFixed(1)} ימים** — כדאי לחסוך לאירועים חשובים.`;
        return `✅ **${fn(u)}**, היתרה שלך **(${cb.balance.toFixed(1)} ימים)** תקינה. המשך/י כך!`;
      }},

    // ── שאלות "מה שלך?" לפי יום בשבוע ────────────────────
    { test: t => /יום ראשון|ראשון בשבוע|sunday/.test(t),
      reply: (t,u) => `ראשון! 💪 שבוע חדש מתחיל, **${fn(u)}**. מה תרצה/י לבדוק היום?` },
    { test: t => /יום שישי|שישי|friday|סוף שבוע/.test(t),
      reply: (t,u) => `שישי! 🙌 שבת שלום **${fn(u)}**! לפני שסוגר/ת — תבדוק/י אם יש בקשות ממתינות.` },

    // ── זיהוי "אני" + שאלה על עצמי ────────────────────────
    { test: t => /^(מה ה?סטטוס שלי|מה מצבי|הסטטוס שלי)$/.test(t),
      reply: (t,u,db) => {
        const year = new Date().getFullYear();
        const todayKey = u.username && db.vacations?.[u.username] ? dateKey(new Date()) : null;
        const tp = todayKey ? (db.vacations[u.username]||{})[todayKey] : null;
        const word = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp]||'במשרד 📍';
        const cb = calcBalance(u.username, year, db);
        return `**${fn(u)}** — היום: **${word}**` + (cb ? `
יתרה: **${cb.balance.toFixed(1)} ימים**` : '');
      }},
  ];

  function runConversation(raw, user, db) {
    const t = norm(raw);
    for (const p of CONV) { if (p.test(t)) return p.reply(t, user, db); }
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  STEP 3 — LIVE DATA + FUSE לשמות/מחלקות
  //  Fuse משמש כאן ל: fuzzyFindEmployee, fuzzyFindDept
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  function respondBalance(user, db, year) {
    const cb=calcBalance(user.username,year,db);
    if (!cb) return `${fn(user)}, אין לי כרגע את נתוני המכסה שלך — אפשר לרענן את הדף? 🔄`;
    // בדיקת בקשות ממתינות
    const pending=(db.approvalRequests||[]).filter(r=>r.username===user.username&&r.status==='pending');
    const pendingLine=pending.length?`\n• יש לך **${pending.length} בקשה ממתינה** לאישור`:'';
    // המלצה לפי יתרה
    const advice=cb.balance<0?'⚠️ אתה בחוסר — כדאי לבדוק עם המנהל':
                 cb.balance<3?'⚠️ יתרה נמוכה — תכנן/י חופש בקרוב':
                 cb.balance>15?'💡 יש לך יתרה גבוהה — כדאי לתכנן חופשה':'✅';
    return `שלום **${fn(user)}**! 🏖️\n` +
      `**יתרת חופשה נכון להיום (${year}):**\n` +
      `• מכסה שנתית: **${cb.annual} ימים** | צברת: **${cb.accrued.toFixed(1)}**\n` +
      `• ניצלת: **${cb.used.toFixed(1)} ימים** (${cb.full} מלאים, ${cb.half} חצאים)\n` +
      `• **יתרה זמינה: ${cb.balance.toFixed(1)} ימים** ${advice}` +
      pendingLine +
      `\n• תחזית סוף שנה: **${cb.projectedEOY.toFixed(1)} ימים**\n` +
      `\nרוצה לראות את כל הבקשות שלך, או לחשב מה יישאר אם תקח ימים?`;
  }

  function respondUsed(user, db, year) {
    const cb=calcBalance(user.username,year,db); if (!cb) return 'לא נמצאו נתונים.';
    const vacs=db.vacations?.[user.username]||{}, byMonth={};
    for (const [dt,type] of Object.entries(vacs)) {
      if (!dt.startsWith(String(year))) continue;
      const m=parseInt(dt.split('-')[1]);
      byMonth[m]=(byMonth[m]||0)+(type==='half'?0.5:1);
    }
    const months=Object.entries(byMonth).sort(([a],[b])=>a-b).map(([m,v])=>`  ${MONTH_NAMES[parseInt(m)]}: ${v} ימים`).join('\n');
    return `**ניצול ${year} — ${user.fullName}:**\n• סה"כ: **${cb.used.toFixed(1)} ימים** (${cb.full} מלאים, ${cb.half} חצאים)\n• WFH: ${cb.wfh} | מחלה: ${cb.sick}\n\n${months?`**לפי חודשים:**\n${months}`:'עדיין לא נוצל חופש השנה.'}`;
  }

  function respondForecast(user, db, year) {
    const cb=calcBalance(user.username,year,db); if (!cb) return 'לא נמצאו נתוני מכסה.';
    const mLeft=Math.max(0,12-cb.curMonth), willAccrue=cb.monthly*mLeft, eoy=cb.balance+willAccrue;
    const rec=eoy>15?`כדאי לתכנן ${Math.floor(eoy/2)} ימי חופשה לפני סוף השנה.`:eoy<0?`⚠️ צפוי חוסר!`:`קצב הניצול תקין.`;
    return `**תחזית שנתית — ${year}:**\n• יתרה נוכחית: **${cb.balance.toFixed(1)} ימים**\n• חודשים שנותרו: **${mLeft}** (+${willAccrue.toFixed(1)} ימים לצבור)\n• יתרה צפויה בדצמבר: **${eoy.toFixed(1)} ימים**\n\n💡 ${rec}`;
  }

  function respondRequestStatus(user, db) {
    const reqs=(db.approvalRequests||[]).filter(r=>r.username===user.username)
      .sort((a,b)=>new Date(b.submittedAt||0)-new Date(a.submittedAt||0)).slice(0,5);
    if (!reqs.length) return `**${fn(user)}**, אין לך בקשות חופשה פתוחות כרגע. 📋\nרוצה להגיש בקשה חדשה?`;
    const lines=reqs.map(r=>{
      const icon=r.status==='approved'?'✅':r.status==='rejected'?'❌':'⏳';
      return `${icon} **${r.date||r.startDate||'—'}** — ${r.status==='approved'?'אושר':r.status==='rejected'?'נדחה':'ממתין לאישור'}`;
    });
    const pending=reqs.filter(r=>r.status==='pending').length;
    const nextStep=pending?`\n\n💡 יש לך ${pending} בקשה ממתינה — רוצה לדעת מה לעשות אם המנהל לא מגיב?`:'';
    return `**הבקשות האחרונות שלך, ${fn(user)}:**\n${lines.join('\n')}${nextStep}`;
  }

  function respondWhoAt(db, di, user, filter) {
    const key=dateKey(di.date||new Date()), raw=statsForDate(db,key), stats=filterByDept(raw,db,user);
    const label=di.label||'היום';
    const map={vacation:{data:stats.vacation,word:'חופשה'},wfh:{data:stats.wfh,word:'WFH'},sick:{data:stats.sick,word:'מחלה'},office:{data:stats.office,word:'במשרד'}};
    const chosen=map[filter]||{data:[...stats.vacation,...stats.wfh,...stats.sick],word:'נעדרים'};
    ctx.resultList=chosen.data; ctx.dateInfo=di;
    if (!chosen.data.length) return `${label}: אין ${chosen.word}.`;
    return `**${label} — ${chosen.word} (${chosen.data.length}):**\n${chosen.data.map(n=>`• ${n}`).join('\n')}`;
  }

  function respondWhoAtRange(db, di, user, filter) {
    const lines=[], d=new Date(di.dateStart);
    while (d<=di.dateEnd) {
      if (d.getDay()!==5&&d.getDay()!==6) {
        const key=dateKey(d), raw=statsForDate(db,key), stats=filterByDept(raw,db,user);
        const list=filter==='wfh'?stats.wfh:filter==='sick'?stats.sick:stats.vacation;
        if (list.length) lines.push(`**${formatDate(d)}**: ${list.join(', ')}`);
      }
      d.setDate(d.getDate()+1);
    }
    const word=filter==='wfh'?'WFH':filter==='sick'?'מחלות':'חופשות';
    return lines.length?`**${di.label}:**\n${lines.join('\n')}`:`${di.label}: אין ${word} מתוכננות.`;
  }

  function respondEmpBalance(targetUser, db, year) {
    const cb=calcBalance(targetUser.username,year,db);
    if (!cb) return `לא נמצאו נתוני מכסה עבור ${targetUser.fullName}.`;
    return `**${targetUser.fullName} — יתרת חופשה ${year}:**\n• מכסה: ${cb.annual} | ניצל: ${cb.used.toFixed(1)} | **יתרה: ${cb.balance.toFixed(1)} ימים**\n• WFH: ${cb.wfh} | מחלה: ${cb.sick} | תחזית: **${cb.projectedEOY.toFixed(1)} ימים**`;
  }

  function respondBurnout(db) {
    const limit=new Date(); limit.setDate(limit.getDate()-90);
    const limitStr=dateKey(limit), at_risk=[];
    for (const [uname,user] of Object.entries(db.users||{})) {
      if (user.status==='pending'||user.role==='admin') continue;
      const vacs=db.vacations?.[uname]||{};
      if (!Object.keys(vacs).some(dt=>dt>=limitStr&&(vacs[dt]==='full'||vacs[dt]==='half'))) at_risk.push(user.fullName);
    }
    if (!at_risk.length) return '✅ אין עובדים בסיכון שחיקה. כולם לקחו חופשה ב-90 הימים האחרונים.';
    return `⚠️ **עובדים ללא חופשה ב-90 יום (${at_risk.length}):**\n${at_risk.map(n=>`• ${n}`).join('\n')}\n\n💡 מומלץ לפנות אליהם ולעודד תכנון חופשה.`;
  }

  function respondCost(db) {
    let total=0; const lines=[];
    for (const [uname,user] of Object.entries(db.users||{})) {
      if (user.status==='pending') continue;
      const cb=calcBalance(uname,new Date().getFullYear(),db); if (!cb||cb.balance<=0) continue;
      const salary=user.dailySalary||user.salary||0, cost=cb.balance*salary;
      total+=cost;
      lines.push(salary>0?`• ${user.fullName}: ${cb.balance.toFixed(1)} ימים × ₪${salary} = ₪${cost.toFixed(0)}`:`• ${user.fullName}: **${cb.balance.toFixed(1)} ימים** צבורים`);
    }
    return lines.length?`**חבות חופשות צבורות:**\n${lines.join('\n')}\n\n${total>0?`**סה"כ: ₪${total.toFixed(0)}**`:'הגדר שכר יומי לחישוב עלות.'}`:'כל עובדי החברה ביתרה אפסית.';
  }

  function respondPending(db) {
    const reqs=(db.approvalRequests||[]).filter(r=>r.status==='pending');
    if (!reqs.length) return '✅ אין בקשות ממתינות לאישור.';
    return `**⏳ בקשות ממתינות (${reqs.length}):**\n${reqs.map(r=>`• **${r.fullName||r.username}** — ${r.date||r.startDate||'—'}`).join('\n')}`;
  }

  function respondShortage(db) {
    const now=new Date(), users=Object.values(db.users||{}).filter(u=>u.status!=='pending'), total=users.length;
    const weeks=[];
    for (let w=0;w<8;w++) {
      const ws=new Date(now); ws.setDate(now.getDate()+w*7-now.getDay()+1);
      let maxOut=0;
      for (let d=0;d<5;d++) { const day=new Date(ws); day.setDate(ws.getDate()+d); const s=statsForDate(db,dateKey(day)); maxOut=Math.max(maxOut,s.vacation.length+s.sick.length); }
      const pct=total?Math.round((total-maxOut)/total*100):100;
      weeks.push(`${pct>=80?'✅':pct>=60?'🟡':'🔴'} שבוע ${w+1} (${ws.getDate()}/${ws.getMonth()+1}): זמינות **${pct}%**`);
    }
    return `**תחזית כוח אדם — 8 שבועות:**\n${weeks.join('\n')}`;
  }

  function runLiveData(raw, user, db) {
    const t=norm(raw), year=extractYear(raw), di=parseDate(raw);
    const adm=isAdmin(user), mgr=isMgr(user,db);

    // ── שאלות המשך: "ומה לגבי X?" / "ואני?" / "ומוטי?" ───────
    const followUpEmp = raw.match(/^(?:ו|גם|ומה לגבי|מה לגבי|ואיך|ומה עם)\s+(.+?)[\s?!.]*$/i);
    if (followUpEmp && ctx.subject) {
      const namePart = followUpEmp[1].trim();
      // בדוק אם "ואני"
      if (/^(אני|עצמי)$/.test(norm(namePart))) {
        if (ctx.subject === 'balance' || ctx.subject === 'forecast' || ctx.subject === 'used') {
          return respondBalance(user, db, year);
        }
      }
      // חפש עובד לפי השם
      const empU = fuzzyFindEmployee(namePart, db);
      if (empU && db.users[empU]) {
        ctx.targetUser = empU;
        const tu = db.users[empU];
        if (ctx.subject === 'balance' || ctx.subject === 'forecast' || ctx.subject === 'used') {
          if (adm || mgr || empU === user.username) {
            return respondEmpBalance(tu, db, year);
          }
          return `${fn(user)}, אין לך הרשאה לצפות ביתרת ${tu.fullName}.`;
        }
        if (['sick','vacation','wfh','office'].includes(ctx.subject)) {
          const effDi = ctx.dateInfo || {date: new Date(), label:'היום', single:true};
          if (effDi.single) {
            const key = dateKey(effDi.date || new Date());
            const tp = (db.vacations?.[empU]||{})[key];
            const word = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp] || 'במשרד 📍';
            return `**${tu.fullName}** — ${effDi.label||'היום'}: ${word}`;
          }
        }
      }
    }

    // ── "ואני?" — שאלת המשך על עצמי ──────────────────────────
    if (/^(ואני|ומה אתי|ואני\?)[\s?!]*$/.test(t)) {
      if (ctx.subject === 'sick' || ctx.subject === 'vacation' || ctx.subject === 'wfh') {
        const effDi = ctx.dateInfo || {date: new Date(), label:'היום', single:true};
        const key = dateKey(effDi.date || new Date());
        const tp = (db.vacations?.[user.username]||{})[key];
        const word = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp] || 'במשרד 📍';
        return `**${fn(user)}**, ${effDi.label||'היום'}: ${word} 😊`;
      }
      if (ctx.subject === 'balance' || ctx.subject === 'forecast') {
        return respondBalance(user, db, year);
      }
    }



    // ── מי אני — חייב להיות ראשון לפני fuzzyFindEmployee ────
    if (/^מי אני|^מה הפרופיל שלי|^הפרטים שלי|^הזהות שלי/.test(t)) {
      const cb = calcBalance(user.username, year, db);
      const dept = Array.isArray(user.dept) ? user.dept.join(', ') : (user.dept || '—');
      const role = user.role === 'admin' ? 'מנהל מערכת' : user.role === 'manager' ? 'מנהל מחלקה' : user.role === 'accountant' ? 'חשב' : 'עובד';
      const today = dateKey(new Date());
      const tp = (db.vacations?.[user.username] || {})[today];
      const statusWord = {full:'בחופשה 🏖️', half:'בחצי יום 🌅', wfh:'WFH 🏠', sick:'מחלה 🤒'}[tp] || 'במשרד 📍';
      return `**${user.fullName}**
` +
        `• תפקיד: ${role} | מחלקה: ${dept}
` +
        `• סטטוס היום: ${statusWord}
` +
        (cb ? `• יתרת חופשה ${year}: **${cb.balance.toFixed(1)} ימים** (ניצל: ${cb.used.toFixed(1)})` : '');
    }

    if (/יתרה|יתרת|כמה (ימים|יום) (יש|נשאר|נותר|זמין)|כמה חופשה|מה היתרה|כמה נשאר לי/.test(t)) {
      // אם השאלה כוללת שם עובד — תן לrunLiveData להמשיך לזיהוי עובד
      const empInQuery = fuzzyFindEmployee(raw, db);
      if (empInQuery && db.users[empInQuery] && empInQuery !== user.username) {
        // עובד אחר הוזכר — נמשיך לבדיקת הרשאות ותשובה
        if (adm || mgr) {
          const tu = db.users[empInQuery];
          ctx.subject = 'balance'; ctx.targetUser = empInQuery;
          const today2=dateKey(new Date()), tp2=(db.vacations?.[empInQuery]||{})[today2];
          const statusW={full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp2]||'במשרד 📍';
          return respondEmpBalance(tu,db,year) + `
• סטטוס היום: **${statusW}**`;
        }
        return `${fn(user)}, אין לך הרשאה לצפות ביתרת ${db.users[empInQuery].fullName}.`;
      }
      ctx.subject = 'balance'; ctx.targetUser = null;
      return respondBalance(user,db,year);
    }

    if (/ניצלתי|לקחתי|כמה השתמשתי|ניצול שנתי|ימים שניצלתי/.test(t)) {
      ctx.subject = 'used'; ctx.targetUser = null;
      return respondUsed(user,db,year);
    }

    if (/תחזית|מתי כדאי|כמה יישאר.*השנה|עד דצמבר|תחזית.*סוף שנה|קצב ניצול/.test(t)) {
      ctx.subject = 'forecast'; ctx.targetUser = null;
      return respondForecast(user,db,year);
    }

    if (/סטטוס|הבקשה שלי|אושרה|נדחה|ממתין לאישור|מה סטטוס/.test(t))
      return respondRequestStatus(user,db);

    if (/מי (ב|הוא|היא|נמצא|יצא|בחופשה|חופש)|מי לא מגיע|מי נעדר/.test(t)) {
      ctx.subject = 'vacation'; ctx.filter = 'vacation';
      if (di.range) { ctx.dateInfo = di; return respondWhoAtRange(db,di,user,'vacation'); }
      ctx.dateInfo = di; return respondWhoAt(db,di,user,'vacation');
    }

    if (/מי (עובד מהבית|ב.?wfh|מהבית)|מי wfh/.test(t)) {
      ctx.subject = 'wfh'; ctx.filter = 'wfh';
      if (di.range) { ctx.dateInfo = di; return respondWhoAtRange(db,di,user,'wfh'); }
      ctx.dateInfo = di; return respondWhoAt(db,di,user,'wfh');
    }

    if (/מי חולה|מי (ב)?מחלה/.test(t)) {
      ctx.subject = 'sick'; ctx.filter = 'sick';
      if (di.range) { ctx.dateInfo = di; return respondWhoAtRange(db,di,user,'sick'); }
      ctx.dateInfo = di; return respondWhoAt(db,di,user,'sick');
    }

    if (/מי במשרד|מי (בחברה|בעבודה)|מי פיזי|מי מגיע/.test(t)) {
      ctx.subject = 'office'; ctx.filter = 'office'; ctx.dateInfo = di;
      return respondWhoAt(db,di,user,'office');
    }

    // ── מצב הצוות ───────────────────────────────────────────
    if (/מצב הצוות|הצוות (היום|מחר|השבוע)|עמיתי/.test(t)) {
      const stats=filterByDept(statsForDate(db,dateKey(di.date||new Date())),db,user);
      ctx.resultList=[...stats.vacation,...stats.wfh,...stats.sick];
      return `**מצב הצוות — ${di.label||'היום'}:**\n🏖️ חופשה: ${stats.vacation.length} | 🏠 WFH: ${stats.wfh.length} | 🤒 מחלה: ${stats.sick.length} | 💼 במשרד: ${stats.office.length}` +
        (stats.vacation.length?`\nבחופשה: ${stats.vacation.join(', ')}`:'') +
        (stats.wfh.length?`\nWFH: ${stats.wfh.join(', ')}`:'') +
        (stats.sick.length?`\nמחלה: ${stats.sick.join(', ')}`:'');
    }

    // ── מחלקה שלי — Fuse למחלקה אם צוין שם ──────────────────
    if (/מחלקה שלי|מי בצוות שלי|חברי הצוות|אנשי הצוות|מי במחלקה שלי/.test(t)) {
      const myDept=Array.isArray(user.dept)?user.dept[0]:(user.dept||'');
      const members=Object.values(db.users||{}).filter(u=>u.status!=='pending'&&(Array.isArray(u.dept)?u.dept[0]:u.dept)===myDept);
      const today=dateKey(new Date());
      ctx.dept=myDept; ctx.resultList=members.map(u=>u.fullName);
      return `מחלקת **${myDept}** — ${members.length} עובדים:\n${members.map(u=>`• **${u.fullName}**${u.username===user.username?' (אתה)':''} ${TYPE_ICON[(db.vacations?.[u.username]||{})[today]]||'📍'}`).join('\n')}`;
    }

    // ── מחלקות — רשימה מלאה ──────────────────────────────────
    if (/כמה מחלקות|אילו מחלקות|רשימת מחלקות|איזה? מחלקות יש|מה המחלקות|מחלקות בחברה|מחלקות החברה|הראה מחלקות/.test(t)) {
      const depts = db.departments || [];
      const lines = depts.map(d => {
        const count = Object.values(db.users||{}).filter(u =>
          u.status!=='pending' && (Array.isArray(u.dept)?u.dept:([u.dept]||[])).includes(d)
        ).length;
        const mgrEntry = Object.entries(db.deptManagers||{}).find(([k])=>k===d);
        const mgrName = mgrEntry ? ((db.users||{})[mgrEntry[1]]||{}).fullName || mgrEntry[1] : null;
        return `• **${d}** — ${count} עובדים${mgrName?' | מנהל: '+mgrName:''}`;
      });
      return `**מחלקות החברה (${depts.length}):**\n${lines.join('\n')}`;
    }

    // ── רשימת עובדים כללית (אדמין/מנהל) ────────────────────
    if (/רשימת עובדים|כל העובדים|תן לי את כל העובדים|הצג עובדים|רשימה של עובדים/.test(t)) {
      if (!isAdmin(user) && !isMgr(user,db)) return `${fn(user)}, אין לך הרשאה לצפות ברשימת כל העובדים.`;
      const users = Object.values(db.users||{}).filter(u=>u.status!=='pending'&&u.username!=='admin');
      const today = dateKey(new Date());
      return `**עובדים פעילים (${users.length}):**\n${users.map(u=>{
        const tp = (db.vacations?.[u.username]||{})[today];
        return `• **${u.fullName}** | ${Array.isArray(u.dept)?u.dept[0]:(u.dept||'—')} ${TYPE_ICON[tp]||'📍'}`;
      }).join('\n')}`;
    }

    // ── חופשות קרובות של המשתמש ──────────────────────────────
    if (/חופשות? קרוב|מתי (אני|יש לי) חופשה|החופשה הבאה|תוכניות קרובות/.test(t)) {
      const vacs = db.vacations?.[user.username] || {};
      const today2 = dateKey(new Date());
      const future = Object.entries(vacs)
        .filter(([d,tp]) => d >= today2 && (tp==='full'||tp==='half'))
        .sort(([a],[b]) => a.localeCompare(b)).slice(0,5);
      if (!future.length) return `${fn(user)}, אין חופשות מתוכננות קדימה. רוצה להגיש בקשה?`;
      return `**החופשות הקרובות שלך:**\n${future.map(([d,tp])=>{
        const p=d.split('-'); return `• ${p[2]}/${p[1]}/${p[0]} — ${tp==='half'?'חצי יום 🌅':'יום מלא 🏖️'}`;
      }).join('\n')}`;
    }

    // ── מנהל המחלקה שלי ──────────────────────────────────────
    if (/מי המנהל שלי|מי מנהל המחלקה שלי|מי הבוס שלי/.test(t)) {
      const myDept = Array.isArray(user.dept)?user.dept[0]:(user.dept||'');
      const mgrEntry = Object.entries(db.deptManagers||{}).find(([k])=>k===myDept);
      if (!mgrEntry) return `לא הוגדר מנהל למחלקת **${myDept}**. פנה לאדמין.`;
      const mgr = (db.users||{})[mgrEntry[1]];
      return `המנהל של מחלקת **${myDept}** הוא **${mgr?mgr.fullName:mgrEntry[1]}**.`;
    }

    // ── בקשות ממתינות לאישור (מנהל/אדמין) ──────────────────
    if ((adm||mgr) && /בקשות? ממתינות?|בקשות? פתוחות?|מה מחכה|מה לאשר|כמה (בקשות?|לאשר)/.test(t))
      return respondPending(db);

    // ── מחלקה ספציפית — Fuse לשם מחלקה ──────────────────────
    if (/עובדי|במחלקת|מי ב/.test(t)) {
      const deptName = fuzzyFindDept(raw, db);
      if (deptName) {
        const members=Object.values(db.users||{}).filter(u=>u.status!=='pending'&&(Array.isArray(u.dept)?u.dept[0]:u.dept)===deptName);
        const today=dateKey(new Date());
        const away=members.filter(u=>{const tp=(db.vacations?.[u.username]||{})[today];return tp==='full'||tp==='half'||tp==='sick';});
        ctx.dept=deptName; ctx.resultList=members.map(u=>u.fullName);
        return `מחלקת **${deptName}**: ${members.length} עובדים\n${members.map(u=>`• **${u.fullName}** ${TYPE_ICON[(db.vacations?.[u.username]||{})[today]]||'📍'}`).join('\n')}\nנעדרים היום: ${away.length?away.map(u=>u.fullName).join(', '):'אין נעדרים ✅'}`;
      }
    }

    // ── כמה עובדים ───────────────────────────────────────────
    if (/כמה עובדים|מצבת|סה.?כ עובדים|כמה אנשים בחברה/.test(t)) {
      const users=Object.values(db.users||{}).filter(u=>u.status!=='pending'&&u.username!=='admin');
      const stats=statsForDate(db,dateKey(new Date()));
      return `**מצבת עובדים:**\n• סה"כ פעילים: **${users.length}**\n• היום: 🏖️ ${stats.vacation.length} חופשה | 🏠 ${stats.wfh.length} WFH | 🤒 ${stats.sick.length} מחלה | 💼 ${stats.office.length} במשרד`;
    }

    if (mgr&&/מחסור|חיזוי עומס|8 שבועות|תחזה.*עומס/.test(t)) return respondShortage(db);
    if (mgr&&/שחיקה|90 יום|ללא חופש|לא לקח חופש|burnout/.test(t)) return respondBurnout(db);
    if (mgr&&/עלות|חבות|כסף|עלויות חופשות/.test(t)) return respondCost(db);
    if (mgr&&/ממתינות|בקשות (פתוחות|שלא אושרו)|כמה (צריך|לאשר)/.test(t)) return respondPending(db);

    // ── יתרה של עובד ספציפי — Fuse לשם עובד ────────────────
    // עובד יכול גם לשאול על עצמו בשם
    const empUsername = fuzzyFindEmployee(raw, db);
    if (empUsername && db.users[empUsername]) {
      if (empUsername === user.username) {
        // שאל על עצמו — תן יתרה
        ctx.subject = 'balance'; ctx.targetUser = null;
        return respondBalance(user, db, year);
      }
      if (adm || mgr) {
        // מנהל/אדמין — תן מידע על העובד
        ctx.subject = 'balance'; ctx.targetUser = empUsername;
        const targetU = db.users[empUsername];
        const today2 = dateKey(new Date());
        const tp2 = (db.vacations?.[empUsername]||{})[today2];
        const statusW = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp2]||'במשרד 📍';
        const balInfo = respondEmpBalance(targetU, db, year);
        return `${balInfo}\n• סטטוס היום: **${statusW}**`;
      }
    }

    // ── סימולציה ─────────────────────────────────────────────
    if (/תחשב.*אם אקח|כמה יישאר.*אם|סימולצי/.test(t)) {
      const match=raw.match(/(\d+(?:\.\d+)?)\s*ימים?/), days=match?parseFloat(match[1]):null;
      const cb=calcBalance(user.username,year,db);
      if (!cb||!days) return 'כמה ימים תרצה לקחת? לדוגמה: "תחשב לי כמה נשאר אם אקח 3 ימים"';
      const after=cb.balance-days;
      return `יתרה נוכחית: **${cb.balance.toFixed(1)} ימים** − ${days} = **${after.toFixed(1)} ימים**${after<0?' ⚠️ חוסר!':after<3?' ⚠️ נמוך מאוד':' ✅'}`;
    }

    // ── דשבורד כללי ─────────────────────────────────────────
    if (/מצב כללי|דשבורד|סיכום.*היום/.test(t)) {
      const stats=statsForDate(db,dateKey(new Date()));
      const total=Object.values(db.users||{}).filter(u=>u.status!=='pending').length;
      const avail=total-stats.vacation.length-stats.sick.length;
      const pct=total?Math.round(avail/total*100):100;
      const pend=(db.approvalRequests||[]).filter(r=>r.status==='pending').length;
      return `**מצב כללי — ${new Date().toLocaleDateString('he-IL')}:**\n• 👥 זמינות: **${pct}%** (${avail}/${total})\n• 🏖️ חופשה: ${stats.vacation.length} | 🏠 WFH: ${stats.wfh.length} | 🤒 מחלה: ${stats.sick.length}\n• ⏳ ממתינות: **${pend}**\n\n${pct>=80?'✅ מצב תקין':'⚠️ עומס — כדאי לבדוק חפיפות'}`;
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  STEP 4 — KNOWLEDGE BASE + FUSE לתיקון כתיב
  //  Fuse משמש כאן בלבד, עם threshold גבוה (0.32)
  //  למניעת false positives
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  const KB = [
    {q:['איך מגישים בקשת חופשה','איך לוקחים חופשה','תהליך בקשת חופשה','איך מבקשים חופשה'],a:'לשונית לוח חופשות ← לחץ על תאריך ← בחר סוג (יום מלא / חצי יום / WFH) ← אשר. הבקשה עוברת למנהל לאישור.'},
    {q:['איך מבטלים בקשת חופשה','לבטל חופשה','ביטול בקשה'],a:'לפני אישור: לחץ על היום ← בטל בקשה. לאחר אישור: פנה למנהל.'},
    {q:['מה ההבדל בין יום מלא לחצי יום','חצי יום חופשה'],a:'יום מלא = 1 יום מהיתרה. חצי יום = 0.5 יום. ניתן לבחור בעת ההגשה.'},
    {q:['מה ההבדל בין חופשה ל-WFH','עבודה מהבית','WFH חופשה'],a:'חופשה = יום חופש מנוכה מהיתרה. WFH = עבודה מהבית — לא נחשב חופשה, לא מקטין יתרה.'},
    {q:['מה קורה אם הבקשה נדחתה','בקשה נדחתה'],a:'תקבל הודעה עם סיבת הדחייה. ניתן לפנות למנהל ולהגיש לתאריכים חלופיים.'},
    {q:['מתי הבקשה מגיעה למנהל','מתי מנהל רואה'],a:'מיד עם ההגשה — המנהל מקבל התראה ורואה תחת "בקשות ממתינות".'},
    {q:['איך יודעים אם הבקשה אושרה','האם אישרו'],a:'הצבע בלוח ישתנה: ירוק = אושר, אדום = נדחה. ניתן לשאול "מה סטטוס הבקשה שלי?"'},
    {q:['כמה מראש צריך להגיש','הודעה מוקדמת'],a:'אין מגבלה טכנית. מומלץ לפחות שבוע מראש.'},
    {q:['חופשה רטרואקטיבית','בקשה על עבר'],a:'ניתן לתאם עם המנהל ואדמין לעדכון ידני.'},
    {q:['כיצד מדווחים על יום מחלה','איך מדווחים מחלה'],a:'לשונית שעון נוכחות ← דיווח מחלה. מחלה לא מנוכה מיתרת חופשה.'},
    {q:['האם ימי מחלה נספרים ביתרת חופשה','מחלה מהיתרה'],a:'לא — ימי מחלה נרשמים בנפרד ואינם מקוזזים מיתרת החופשה.'},
    {q:['כמה ימים צברתי החודש','צבירה חודשית','כמה אני צובר'],a:'הצבירה החודשית = מכסה שנתית ÷ 12. לדוגמה: 24 ימים → 2 ימים לחודש.'},
    {q:['מתי מתאפסת יתרת החופשה','איפוס יתרה'],a:'בדרך כלל 1 בינואר, תלוי בהגדרות. חלק מהחברות מעבירות יתרה.'},
    {q:['מה קורה לימים שלא ניצלתי','ימים פגים'],a:'תלוי במדיניות: העברה / פיצוי כספי / ביטול. פנה למשאבי אנוש.'},
    {q:['מה זה ימי חג','יום חג בחופשה'],a:'ימי חג רשמיים אינם מנוכים מהיתרה. אם חג חל במהלך חופשה — אותו יום לא נספר.'},
    {q:['האם ערב חג נחשב לחצי יום','ערב חג'],a:'תלוי במדיניות החברה. בדוק עם ההנהלה.'},
    {q:['כמה ימי WFH מותר','מגבלת WFH'],a:'מדיניות WFH נקבעת לפי תפקיד ומחלקה. פנה למנהל.'},
    {q:['איך מדווחים כניסה ויציאה','שעון נוכחות','דיווח שעות'],a:'לשונית שעון נוכחות ← כניסה בהגעה, יציאה בסיום.'},
    {q:['מה קורה אם שכחתי לדווח','שכחתי לדווח','תיקון שעות'],a:'פנה למנהל לתיקון ידני. מנהל יכול לעדכן שעות מלוח המנהל.'},
    {q:['מה יש בלשונית סקירה','לשונית סקירה','דשבורד עובד'],a:'יתרה נוכחית, ניצול השנה, חופשות קרובות, סטטוס בקשה אחרונה, תחזית סוף שנה.'},
    {q:['מה יש בלשונית לוח מנהל','לוח מנהל'],a:'נוכחות צוות, בקשות ממתינות, יתרות עובדים, תחזיות עומסים, ציוני רווחה.'},
    {q:['מה יש בלשונית ניהול','לשונית ניהול','מה יש בניהול'],a:'לשונית ניהול (אדמין בלבד): ניהול עובדים, מחלקות, הרשאות, הגדרות, גיבוי, Firebase.'},
    {q:['מה יש בלשונית שעון','לשונית שעון'],a:'כניסה/יציאה, דיווח WFH, דיווח מחלה, היסטוריית נוכחות.'},
    {q:['מה יש בלשונית דוח אישי','דוח אישי'],a:'היסטוריית דיווחים, פירוט חודשי, ניתוח ניצול, ייצוא לאקסל.'},
    {q:['מה אפשר לראות בתצוגה השנתית','תצוגה שנתית'],a:'מפת חום של כל ימי השנה — רואים בבת אחת אילו חודשים עמוסים.'},
    {q:['איך מוסיפים עובד חדש','הוספת עובד','עובד חדש'],a:'לשונית ניהול ← עובדים ← הוסף עובד ← מלא פרטים ← שמור.'},
    {q:['איך מגדירים מנהל מחלקה','מינוי מנהל'],a:'לשונית ניהול ← ניהול מחלקות ← מצא מחלקה ← בחר עובד כמנהל.'},
    {q:['איך מחברים Firebase','הגדרת Firebase'],a:'לשונית ניהול ← Firebase ← הכנס apiKey ו-projectId ← התחבר.'},
    {q:['איך מגבים את הנתונים','גיבוי נתונים'],a:'לשונית ניהול ← גיבוי ← ייצא גיבוי. יורד קובץ JSON עם כל הנתונים.'},
    {q:['איך מאפסים סיסמת עובד','איפוס סיסמה'],a:'לשונית ניהול ← מצא עובד ← שלוש נקודות ← אפס סיסמה.'},
    {q:['מה זה Dazura','מה המערכת'],a:'Dazura היא מערכת ניהול חופשות ונוכחות לארגונים. מאפשרת לעובדים לנהל חופשות ולמנהלים לאשר ולנתח נתונים.'},
    {q:['האם המערכת עובדת בנייד','אפליקציה','PWA'],a:'כן — מותאמת לנייד ותומכת בהתקנה כ-PWA על מסך הבית.'},
    {q:['האם הנתונים מסונכרנים','סנכרון בין מכשירים'],a:'כן — Firebase מסנכרן בזמן אמת. שינוי ממכשיר אחד מתעדכן מיידית בכל שאר המכשירים.'},
    {q:['מה ה-AI יכול לעשות','יכולות AI','מה אפשר לשאול'],a:'ה-AI מחשב יתרות, מציג נעדרים, מנתח צוות, חוזה עומסים, ועונה על שאלות מערכת — מהנתונים האמיתיים שלך.'},
    {q:['האם ה-AI שומר שיחות','פרטיות AI'],a:'ה-AI שומר הקשר שיחה נוכחית בלבד (עד 20 הודעות). לאחר סגירת הפנל — ההיסטוריה נמחקת.'},
    {q:['מה ההבדל בין אדמין למנהל','תפקידים','הרשאות תפקיד'],a:'אדמין: גישה מלאה לכל הנתונים והגדרות. מנהל מחלקה: רואה ומנהל רק עובדי מחלקתו.'},
    {q:['כיצד שולחים הודעה לעובדים','הודעה לכולם'],a:'לשונית ניהול ← הודעות ← שלח הודעה חדשה.'},
    {q:['מה זה פרוטוקול העברת מקל','handover'],a:'לפני חופשה ממלאים פרוטוקול עם משימות קריטיות ומחליף. המנהל רואה בלוח המנהל.'},
    {q:['ייצוא לאקסל','להוריד דוח','ייצוא דוח'],a:'לשונית דוח אישי ← בחר תקופה ← ייצא. הדוח יוריד בפורמט CSV.'},
    {q:['האם אפשר לפצל חופשה','חופשה בחלקים'],a:'כן — מגישים בקשות נפרדות לתקופות שונות. כל בקשה תאושר בנפרד.'},
    {q:['האם ניתן להעביר ימי חופשה לעמית','העברת ימים'],a:'לא — ימי חופשה אינם ניתנים להעברה. כל עובד מנהל יתרתו האישית.'},
  ];

  // בניית אינדקס Fuse מה-KB — מבנה שטוח: שאלה + תשובה
  let _kbFuse = null;
  function getKBFuse() {
    if (_kbFuse) return _kbFuse;
    const index = [];
    KB.forEach(entry => {
      entry.q.forEach(q => {
        index.push({ _text: norm(q) + ' ' + norm(entry.q[0]), _answer: entry.a });
      });
    });
    _kbFuse = new BuiltinFuse(index, {
      keys: [{ name:'_text', weight:1 }],
      threshold: 0.32,   // סף גבוה — מונע false positives
      minMatchCharLength: 4,
    });
    return _kbFuse;
  }

  // ── resolveDirective: מממש הוראות i: מה-knowledge.js ──────
  function resolveDirective(directive, user, db) {
    const year = new Date().getFullYear();
    switch(directive) {
      case 'BALANCE':   return respondBalance(user, db, year);
      case 'FORECAST':  return respondForecast(user, db, year);
      case 'USED':      return respondUsed(user, db, year);
      case 'QUOTA': {
        const q = (user.quotas||{})[String(year)]||{};
        return `המכסה השנתית שלך לשנת ${year}: **${q.annual||0} ימים** (${((q.annual||0)/12).toFixed(1)} ימים לחודש).`;
      }
      case 'DEPARTMENTS': {
        const depts = db.departments || [];
        const lines = depts.map(d => {
          const count = Object.values(db.users||{}).filter(u=>u.status!=='pending'&&(Array.isArray(u.dept)?u.dept:([u.dept]||[])).includes(d)).length;
          const mgr = Object.entries(db.deptManagers||{}).find(([k])=>k===d);
          return `• **${d}** — ${count} עובדים${mgr?' | מנהל: '+((db.users||{})[mgr[1]]||{}).fullName||mgr[1]:''}`;
        });
        return `**מחלקות החברה (${depts.length}):**\n${lines.join('\n')}`;
      }
      case 'NEXT_HOLIDAY': {
        // HOLIDAYS קיים ב-script.js עם מפתחות "2026-4-2" (ללא ריפוד)
        const hObj = typeof HOLIDAYS !== 'undefined' ? HOLIDAYS : null;
        if (!hObj) {
          // Fallback: תשובה סטטית מה-KB
          return 'החגים הקרובים בישראל 2026:\n• פסח — 2 באפריל 🌿\n• יום העצמאות — 22 באפריל 🇮🇱\n• שבועות — 22 במאי\n• ראש השנה — 12 ספטמבר\n• יום כיפור — 21 ספטמבר\n• סוכות — 26 ספטמבר\n• שמחת תורה — 3 אוקטובר';
        }
        const todayD = new Date();
        // נורמליזציה: השווה לפי שנה-חודש-יום (ללא ריפוד)
        const todayUnpad = todayD.getFullYear()+'-'+( todayD.getMonth()+1)+'-'+todayD.getDate();
        const normKey = k => { const p=k.split('-'); return p[0]+'-'+parseInt(p[1])+'-'+parseInt(p[2]); };
        const todayNum = todayD.getFullYear()*10000+(todayD.getMonth()+1)*100+todayD.getDate();
        const upcoming = Object.entries(hObj)
          .map(([d,h]) => { const p=d.split('-'); return [d,h,parseInt(p[0])*10000+parseInt(p[1])*100+parseInt(p[2])]; })
          .filter(([,, num]) => num >= todayNum)
          .sort(([,,a],[,,b]) => a-b)
          .slice(0, 5);
        if (!upcoming.length) return 'אין חגים קרובים ברשומות.';
        const lines = upcoming.map(([d,h]) => {
          const p = d.split('-');
          const blocked = h.blocked ? ' 🚫 יום חג רשמי' : h.half ? ' (ערב חג — חצי יום)' : '';
          return '• **'+h.n+'** — '+p[2]+'/'+p[1]+'/'+p[0]+blocked;
        });
        return '**החגים הקרובים:**\n'+lines.join('\n');
      }
      case 'VACATIONS': {
        const vacs = db.vacations?.[user.username] || {};
        const year2 = new Date().getFullYear();
        const future = Object.entries(vacs)
          .filter(([d,t]) => d >= dateKey(new Date()) && (t==='full'||t==='half'))
          .sort(([a],[b]) => a.localeCompare(b))
          .slice(0, 5);
        if (!future.length) return `${fn(user)}, אין חופשות מתוכננות קדימה.`;
        return `**החופשות הקרובות שלך:**\n${future.map(([d,t]) => {
          const parts = d.split('-');
          return `• ${parts[2]}/${parts[1]}/${parts[0]} — ${t==='half'?'חצי יום 🌅':'יום מלא 🏖️'}`;
        }).join('\n')}`;
      }
      case 'EMPLOYEES': {
        if (!isAdmin(user) && !isMgr(user,db)) return 'אין לך הרשאה לצפות ברשימת עובדים.';
        const users = Object.values(db.users||{}).filter(u=>u.status!=='pending'&&u.username!=='admin');
        return `**עובדים פעילים (${users.length}):**\n${users.map(u=>`• **${u.fullName}** | ${Array.isArray(u.dept)?u.dept[0]:u.dept||'—'}`).join('\n')}`;
      }
      default: return null;
    }
  }

  // ── runKnowledge: KB הפנימי + AI_KNOWLEDGE מ-knowledge.js ──
  function runKnowledge(raw, user, db) {
    const t = norm(raw);

    // שלב 0: AI_KNOWLEDGE מ-knowledge.js (גובר על הכל)
    if (typeof AI_KNOWLEDGE !== 'undefined' && AI_KNOWLEDGE.length) {
      for (const entry of AI_KNOWLEDGE) {
        // בדיקת התאמה: שאלה ראשית + aliases
        const allQ = [entry.q, ...(entry.aliases || [])];
        const matched = allQ.some(q => {
          const qn = norm(q);
          return t === qn || (qn.length >= 4 && t.includes(qn)) || (t.length >= 4 && qn.includes(t));
        });
        if (!matched) continue;

        // הוראת DB — ממש ישירות כאן!
        if (entry.i) return resolveDirective(entry.i, user, db) || runLiveData(raw, user, db);

        // תשובה רנדומלית
        if (entry.random && Array.isArray(entry.a))
          return entry.a[Math.floor(Math.random() * entry.a.length)];

        // תשובה ישירה
        if (typeof entry.a === 'string') return entry.a;
        if (Array.isArray(entry.a)) return entry.a[0];
      }
    }

    // שלב 1: התאמה מדויקת ראשונה (מהירה)
    for (const entry of KB) {
      if (entry.q.some(q => {
        const qn=norm(q);
        return t===qn || (qn.length>=6&&t.includes(qn)) || (t.length>=6&&qn.includes(t));
      })) return entry.a;
    }

    // שלב 2: Fuse לתיקון שגיאות כתיב (סף קשוח: 0.32)
    const fuse = getKBFuse();
    const results = fuse.search(t);
    if (results.length && results[0].score < 0.32) {
      return results[0].item._answer;
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  STEP 5 — FALLBACK
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  function runFallback(raw, user, db) {
    const t=norm(raw), adm=isAdmin(user), mgr=isMgr(user,db);

    // ── אם יש הקשר פעיל — הצע המשך חכם ──────────────────
    if (ctx.subject) {
      const subjectHints = {
        sick:      `נראה שהשאלה קשורה ל**מחלה**. נסה:\n• "מי חולה מחר?"\n• "מי חולה השבוע?"`,
        vacation:  `נראה שהשאלה קשורה ל**חופשות**. נסה:\n• "מי בחופשה מחר?"\n• "מי בחופשה השבוע?"`,
        wfh:       `נראה שהשאלה קשורה ל**WFH**. נסה:\n• "מי WFH מחר?"\n• "מי עובד מהבית השבוע?"`,
        balance:   `נראה שהשאלה קשורה ל**יתרת חופשה**. נסה:\n• "מה יתרת [שם עובד]?"\n• "מה תחזית היתרה שלי?"`,
        forecast:  `נראה שהשאלה קשורה ל**תחזית**. נסה:\n• "מה יתרת החופשה שלי?"\n• "כמה ניצלתי השנה?"`,
        dept:      `נראה שהשאלה קשורה ל**מחלקה**. נסה:\n• "מי בצוות שלי?"\n• "כמה עובדים יש במחלקה?"`,
        employees: `נראה שהשאלה קשורה ל**עובדים**. נסה:\n• "מה יתרת [שם]?"\n• "מי בחופשה היום?"`,
      };
      const hint = subjectHints[ctx.subject];
      if (hint) return `${fn(user)}, לא הבנתי בדיוק. 🤔\n\n${hint}`;
    }

    if (/שעה|שעות|כניסה|יציאה|נוכחות/.test(t))
      return `נראה שאתה מחפש מידע על **שעות עבודה**. נסה:\n• "כמה שעות דיווחתי השבוע?"\n• "איך מתקנים שעות שגויות?"`;

    if (/אישור|אישרו|מאושר|ממתין|נדחה|בקשה/.test(t))
      return `נראה שאתה מחפש מידע על **בקשת אישור**. נסה:\n• "מה סטטוס הבקשה שלי?"\n• "כמה בקשות ממתינות?"`;

    if (/מחלקה|מנהל|צוות|עמיתים/.test(t))
      return `נסה:\n• "מי מהצוות בחופשה היום?"\n• "מה מצב הצוות מחר?"`;

    if (/הגדרות|סיסמה|מייל|לוגו/.test(t))
      return `נסה:\n• "איך משנים סיסמה?"\n• "איך מחברים Firebase?"`;

    if (/חופש|חופשה|יתרה|ימים/.test(t))
      return respondBalance(user, db, new Date().getFullYear());

    if (/שחיקה|burnout|לא לקח.*חופש|ללא חופש|סיכון שחיקה|מי בסיכון|90 יום|לא לקחו חופשה/.test(t)) {
      return respondBurnout(db);
    }

    // Fuse: נסה למצוא עובד/מחלקה בטקסט גם ב-fallback
    const empUsername = fuzzyFindEmployee(raw, db);
    if (empUsername && db.users[empUsername]) {
      ctx.subject = 'balance'; ctx.targetUser = empUsername;
      const u = db.users[empUsername];
      const today = dateKey(new Date()), tp=(db.vacations?.[empUsername]||{})[today];
      const statusWord = {full:'בחופשה 🏖️',half:'בחצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp] || 'במשרד 📍';
      return `**${u.fullName}** — היום: ${statusWord}${isMgr(user,db)?'\nלפרטי יתרה: "מה יתרת [שם העובד]?"':''}`;
    }

    const deptName = fuzzyFindDept(raw, db);
    if (deptName) {
      ctx.subject = 'dept'; ctx.dept = deptName;
      const members=Object.values(db.users||{}).filter(u=>u.status!=='pending'&&(Array.isArray(u.dept)?u.dept[0]:u.dept)===deptName);
      return `מחלקת **${deptName}**: ${members.length} עובדים — ${members.map(u=>u.fullName).join(', ')}`;
    }

    const examples = adm
      ? `• "מה יתרת החופשה שלי?"\n• "מי בחופשה מחר?"\n• "תחזית עומסים ל-8 שבועות"\n• "מי בסיכון שחיקה?"`
      : mgr
      ? `• "מי בחופשה מחר?"\n• "בקשות ממתינות לאישור"\n• "תחזית עומסים"`
      : `• "מה יתרת החופשה שלי?"\n• "מי מהצוות כאן מחר?"\n• "איך מגישים בקשת חופשה?"`;

    // ── שאלה קצרה — הצע פרשנויות ────────────────────────
    const shortQ = t.split(/\s+/).length <= 3;
    if (shortQ) {
      return `${fn(user)}, לא הצלחתי להבין בדיוק מה אתה מחפש. 🤔\n\nאולי התכוונת לאחד מאלה?\n• **יתרה** → "מה יתרת החופשה שלי?"\n• **נוכחות** → "מי בחופשה היום?"\n• **בקשות** → "מה סטטוס הבקשה שלי?"\n• **עזרה** → כתוב "עזרה" לרשימה מלאה`;
    }

    return `${fn(user)}, לא הצלחתי להבין את השאלה. 🙏\n\nנסה לנסח אחרת, למשל:\n${examples}\n\nאו כתוב **"עזרה"** לרשימה מלאה.`;
  }

  // ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  //  MAIN respond()
  //  Pipeline: Help → Conversation → LiveData → Knowledge → Fallback
  // ══════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────
  // INTENT CLASSIFIER — מזהה כוונה מתוך שאלה קצרה+הקשר
  // ─────────────────────────────────────────────────────────
  function classifyIntent(raw, user, db) {
    const t = norm(raw);

    // ── עזרה ───────────────────────────────────────────────
    if (/^(מה יכול|מה אתה יכול|מה ניתן|מה אפשר|עזרה|help|רשימת פקודות|פקודות|תפריט|מה אתה עושה)/.test(t)) return 'help';

    // ── יתרה ───────────────────────────────────────────────
    // שאלה על עובד ספציפי — לא לתפוס כ-balance (יטופל ב-runLiveData)
    if (/^(כמה|מה) (יש לי|יתרתי|נשאר לי|נותר לי|היתרה|יתרת)/.test(t) && !t.includes(' של ') && !t.includes(' עבור ') && t.split(' ').length <= 6) return 'balance';
    if (/^(כמה ימים|יתרה|יתרת חופשה|כמה ימי חופש)$/.test(t)) return 'balance';

    // ── פרופיל ─────────────────────────────────────────────
    if (/^(מי אני|הפרופיל שלי|הפרטים שלי|פרטי)$/.test(t)) return 'profile';

    // ── מחלקה עצמית ───────────────────────────────────────
    if (/^(איזה? מחלקה אני|מה המחלקה שלי|במה מחלקה|איפה אני עובד)/.test(t)) return 'dept_self';

    // ── מחלקות (כל המחלקות) ───────────────────────────────
    if (/^(איזה? מחלקות|מה המחלקות|מחלקות|כמה מחלקות|מחלקות החברה|הראה מחלקות|רשימת מחלקות)$/.test(t)) return 'departments';

    // ── עובדים ─────────────────────────────────────────────
    if (/^(כמה עובדים|רשימת עובדים|כל העובדים|רשימה של עובדים)$/.test(t)) return 'employees';

    // ── סטטוס היום ─────────────────────────────────────────
    if (/^(מה הסטטוס|סטטוס שלי|מה מצבי|מה מצבי היום|הסטטוס שלי)$/.test(t)) return 'status_today';

    // ── ניצול ──────────────────────────────────────────────
    if (/^(כמה ניצלתי|כמה לקחתי|ניצול|כמה השתמשתי)$/.test(t)) return 'used';

    // ── תחזית ──────────────────────────────────────────────
    if (/^(תחזית|מה תחזית|תחזית שנתית|כמה יישאר)$/.test(t)) return 'forecast';

    // ── נוכחות ─────────────────────────────────────────────
    if (/^(מי בחופשה|מי נעדר|מי לא מגיע|מי חופש)$/.test(t)) return 'who_vacation';
    if (/^(מי wfh|מי מהבית|מי עובד מהבית)$/.test(t)) return 'who_wfh';
    if (/^(מי חולה|מי מחלה|מי חולים)$/.test(t)) return 'who_sick';
    if (/^(מי במשרד|מי בעבודה|מי מגיע|מי נמצא)$/.test(t)) return 'who_office';

    // ── שאלות המשך על זמן — ניצול ctx.subject ─────────────
    // "והשבוע?" / "ומחר?" / "מה לגבי שבוע הבא?" כשיש נושא קודם
    const followTimeOnly = /^(והשבוע|ומחר|ואתמול|והיום|והחודש|וחודש הבא|ושבוע הבא|השבוע\?*|מחר\?*|אתמול\?*|שבוע הבא\?*|חודש הבא\?*|החודש\?*)$/.test(t);
    if (followTimeOnly && ctx.subject) return '__ctx_time__';

    // "ואני?" / "ומה אתה יכול לגבי שלי?"
    const followMine = /^(ואני|ואני\?*|ומה אתה|מה אתה אומר|מה זה אצלי|ומה שלי|ואצלי)$/.test(t);
    if (followMine && ctx.subject) return '__ctx_mine__';

    // "כמה?" אחרי תשובה
    const followCount = /^(כמה\?*|כמה זה\?*|כמה שם\?*|כמה יש\?*|כמה נשאר\?*)$/.test(t);
    if (followCount && ctx.subject) return '__ctx_count__';

    // ── בקשות ──────────────────────────────────────────────
    if (/^(מה יש לי|מה הבקשות שלי|בקשות שלי|הבקשות שלי)$/.test(t)) return 'requests';
    if (/^(בקשות? ממתינות?|מה מחכה לאישור|מה לאשר|יש בקשות ממתינות|הבקשות הפתוחות|בקשות פתוחות|מה הבקשות הפתוחות)$/.test(t)) return 'pending';

    // ── מנהל ───────────────────────────────────────────────
    if (/^(מי המנהל שלי|מי הבוס שלי|מי מנהל המחלקה)$/.test(t)) return 'my_manager';

    // ── מצב הצוות ──────────────────────────────────────────
    if (/^(מצב הצוות|מצב הצוות היום|מה מצב הצוות)$/.test(t)) return 'team_status';
    if (/שחיקה|burnout|לא לקח חופש|ללא חופש|סיכון שחיקה|מי בסיכון|לא לקחו חופשה|90 יום/.test(t)) return 'burnout';

    // ── חופשות קרובות ──────────────────────────────────────
    if (/^(חופשות? קרוב|החופשה הבאה|מתי חופשה|תוכניות)$/.test(t)) return 'upcoming_vacations';

    return null;
  }

  function respond(rawInput, currentUser, db) {
    if (!rawInput?.trim()) return 'בבקשה הקלד שאלה.';
    if (!currentUser)      return 'יש להתחבר למערכת.';

    history.push({role:'user', text:rawInput});
    if (history.length > MAX_HISTORY*2) history = history.slice(-MAX_HISTORY*2);

    const year = new Date().getFullYear();
    let r = null;

    // ══════════════════════════════════════════════════════
    // PRE-ZERO: Context Memory — פתרון שאלות המשך
    // ══════════════════════════════════════════════════════
    const ctxResolved = resolveContext(rawInput);

    // אם זוהתה שאלת המשך — נסה לענות ישירות לפי הקשר
    if (ctxResolved.usedCtx) {
      const { effectiveSubject, effectiveFilter, effectiveTime, effectiveUser } = ctxResolved;

      // ── "ואני?" / "ואתה?" — עצמי לפני כל דבר ──────────
      const selfPatterns = /^(ו?אני|ואתה|ומה אתה|ומה לגביי|לגביי|ואני)[?!\s]*$/;
      if (selfPatterns.test(norm(rawInput))) {
        ctx.targetUser = null;
        const presenceMe = ['sick','vacation','wfh','office'];
        if (presenceMe.includes(effectiveSubject) && ctxResolved.effectiveTime) {
          const diMe = ctxResolved.effectiveTime;
          const keyMe = diMe.single ? dateKey(diMe.date || new Date()) : null;
          if (keyMe) {
            const tpMe = (db.vacations?.[currentUser.username]||{})[keyMe];
            const wordMe = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tpMe] || 'במשרד 📍';
            r = `**${fn(currentUser)}** — ${diMe.label||'היום'}: **${wordMe}** 😊`;
            ctx.lastAnswer = r; history.push({role:'ai', text:r}); return r;
          }
        }
        if (effectiveSubject === 'balance' || !presenceMe.includes(effectiveSubject)) {
          r = respondBalance(currentUser, db, year);
          ctx.lastAnswer = r; history.push({role:'ai', text:r}); return r;
        }
        if (effectiveSubject === 'forecast') {
          r = respondForecast(currentUser, db, year);
          ctx.lastAnswer = r; history.push({role:'ai', text:r}); return r;
        }
      }

      // ── זיהוי עובד ספציפי בשאלת המשך ──────────────────
      // "ומה לגבי מוטי?" / "ואיתי?" / "ומה לגבי דוד?"
      const mentionedEmp = fuzzyFindEmployee(rawInput, db);

      // נושא: נוכחות/מחלה/חופשה/WFH + עובד ספציפי
      const presenceSubjects = ['sick','vacation','wfh','office'];
      if (presenceSubjects.includes(effectiveSubject) && effectiveTime) {
        if (mentionedEmp && db.users[mentionedEmp]) {
          // שאל על עובד ספציפי — בדוק אם מנהל/אדמין
          if (isAdmin(currentUser) || isMgr(currentUser, db)) {
            const di = effectiveTime;
            const key = di.single ? dateKey(di.date) : null;
            if (key) {
              const tp = (db.vacations?.[mentionedEmp]||{})[key];
              const empName = db.users[mentionedEmp].fullName;
              const word = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp]||'במשרד 📍';
              r = `**${empName}** — ${di.label}: **${word}**`;
              ctx.targetUser = mentionedEmp;
            }
          }
        }
        if (!r) {
          if (effectiveTime.single) {
            r = respondWhoAt(db, effectiveTime, currentUser, effectiveFilter || effectiveSubject);
          } else {
            r = respondWhoAtRange(db, effectiveTime, currentUser, effectiveFilter || effectiveSubject);
          }
        }
      }

      // נושא: יתרה של עובד שהוזכר בשאלת המשך
      if (!r && effectiveSubject === 'balance' && mentionedEmp && db.users[mentionedEmp]) {
        if (isAdmin(currentUser) || isMgr(currentUser, db)) {
          const tu = db.users[mentionedEmp];
          r = respondEmpBalance(tu, db, year);
          ctx.targetUser = mentionedEmp;
        }
      }

      // נושא: יתרה של עובד ספציפי (מ-ctx קודם)
      if (!r && effectiveSubject === 'balance' && effectiveUser && !mentionedEmp) {
        const tu = Object.values(db.users||{}).find(u => u.username === effectiveUser);
        if (tu) r = respondEmpBalance(tu, db, year);
      }

      // "ואני?" / "ומה אתי?" — יתרת המשתמש הנוכחי (מאפס targetUser)
      const isAskingAboutSelf = /^(ו?אני|ומה אתה|מה אתה|ואני|ומה לגביי|לגביי)[?!\s]*$/.test(norm(rawInput));
      if (!r && effectiveSubject === 'balance' && isAskingAboutSelf) {
        r = respondBalance(currentUser, db, year);
        ctx.targetUser = null;
      }

      // נושא: יתרה של המשתמש הנוכחי כברירת מחדל
      if (!r && effectiveSubject === 'balance' && !effectiveUser) {
        r = respondBalance(currentUser, db, year);
      }

      // נושא: תחזית
      if (!r && effectiveSubject === 'forecast') {
        r = respondForecast(currentUser, db, year);
      }

      // נושא: ניצול
      if (!r && effectiveSubject === 'used') {
        r = respondUsed(currentUser, db, year);
      }

      // נושא: מחלקה — "ומחלקת מכירות?"
      if (!r && effectiveSubject === 'dept') {
        const deptName = fuzzyFindDept(rawInput, db);
        if (deptName) {
          const members = Object.values(db.users||{}).filter(u =>
            u.status!=='pending' && (Array.isArray(u.dept)?u.dept[0]:u.dept) === deptName
          );
          r = `מחלקת **${deptName}**: ${members.length} עובדים — ${members.map(u=>u.fullName).join(', ')}`;
          ctx.dept = deptName;
        }
      }

      // אם נמצאה תשובה — שמור ב-ctx והחזר
      if (r) {
        ctx.lastAnswer = r;
        history.push({role:'ai', text:r});
        return r;
      }

      // הקשר קיים אבל לא הצלחנו לפענח — תן רמז
      if (ctx.subject && ctxResolved.usedCtx) {
        const subjectLabel = {
          sick:'מחלה', vacation:'חופשה', wfh:'WFH', office:'נוכחות',
          balance:'יתרת חופשה', forecast:'תחזית', used:'ניצול', dept:'מחלקה'
        }[ctx.subject] || ctx.subject;
        const timeLabel = effectiveTime?.label || 'טווח זמן';
        r = `מבחינת **${subjectLabel}** — תפרט/י: ל${timeLabel}? לעובד ספציפי? 😊`;
        ctx.lastAnswer = r;
        history.push({role:'ai', text:r});
        return r;
      }
    }

    // ── PRE-STEP: Intent classifier — קצר חכם לפני הכל ──
    const intent = classifyIntent(rawInput, currentUser, db);
    const todayDi = {date: new Date(), label:'היום', single:true};

    // ── Context intents: __ctx_time__ / __ctx_mine__ / __ctx_count__ ──
    if (intent === '__ctx_time__') {
      // שאלת המשך עם זמן בלבד — עבד לפי resolveContext
      if (ctxResolved.effectiveSubject && ctxResolved.effectiveTime) {
        const s = ctxResolved.effectiveSubject, di = ctxResolved.effectiveTime;
        const presenceSubjects = ['sick','vacation','wfh','office'];
        if (presenceSubjects.includes(s)) {
          r = di.single
            ? respondWhoAt(db, di, currentUser, ctxResolved.effectiveFilter || s)
            : respondWhoAtRange(db, di, currentUser, ctxResolved.effectiveFilter || s);
        } else if (s === 'balance')  r = respondBalance(currentUser, db, year);
        else if (s === 'forecast')   r = respondForecast(currentUser, db, year);
        else if (s === 'used')       r = respondUsed(currentUser, db, year);
      }
    }
    else if (intent === '__ctx_mine__') {
      // "ואני?" — לפי הנושא: נוכחות=סטטוס יומי, יתרה=balance
      ctx.targetUser = null;
      const presenceS2 = ['sick','vacation','wfh','office'];
      if (presenceS2.includes(ctx.subject) && ctx.dateInfo) {
        const di2 = ctx.dateInfo;
        const key2 = di2.single ? dateKey(di2.date || new Date()) : null;
        if (key2) {
          const tp2 = (db.vacations?.[currentUser.username]||{})[key2];
          const word2 = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp2] || 'במשרד 📍';
          r = `**${fn(currentUser)}** — ${di2.label||'היום'}: **${word2}** 😊`;
        } else {
          r = respondBalance(currentUser, db, year);
        }
      } else {
        r = respondBalance(currentUser, db, year);
      }
    }
    else if (intent === '__ctx_count__') {
      // "כמה?" — ספור את resultList הקודם
      if (ctx.resultList && ctx.resultList.length) {
        r = `**${ctx.resultList.length}** אנשים (${ctx.resultList.join(', ')})`;
      } else {
        r = respondBalance(currentUser, db, year);
      }
    }
    else if (intent === 'help')               r = respondHelp(currentUser, db);
    else if (intent === 'balance')       r = respondBalance(currentUser, db, year);
    else if (intent === 'used')          r = respondUsed(currentUser, db, year);
    else if (intent === 'forecast')      r = respondForecast(currentUser, db, year);
    else if (intent === 'requests')      r = respondRequestStatus(currentUser, db);
    else if (intent === 'pending')       r = (isAdmin(currentUser)||isMgr(currentUser,db)) ? respondPending(db) : `${fn(currentUser)}, רק מנהלים יכולים לראות בקשות ממתינות.`;
    else if (intent === 'who_vacation') {
      r = respondWhoAt(db, todayDi, currentUser, 'vacation');
      ctx.subject = 'vacation'; ctx.filter = 'vacation'; ctx.dateInfo = todayDi;
    }
    else if (intent === 'who_wfh') {
      r = respondWhoAt(db, todayDi, currentUser, 'wfh');
      ctx.subject = 'wfh'; ctx.filter = 'wfh'; ctx.dateInfo = todayDi;
    }
    else if (intent === 'who_sick') {
      r = respondWhoAt(db, todayDi, currentUser, 'sick');
      ctx.subject = 'sick'; ctx.filter = 'sick'; ctx.dateInfo = todayDi;
    }
    else if (intent === 'who_office') {
      r = respondWhoAt(db, todayDi, currentUser, 'office');
      ctx.subject = 'office'; ctx.filter = 'office'; ctx.dateInfo = todayDi;
    }
    else if (intent === 'team_status') {
      const stats = filterByDept(statsForDate(db, dateKey(new Date())), db, currentUser);
      r = `**מצב הצוות — היום:**\n🏖️ חופשה: ${stats.vacation.length} | 🏠 WFH: ${stats.wfh.length} | 🤒 מחלה: ${stats.sick.length} | 💼 במשרד: ${stats.office.length}` +
          (stats.vacation.length ? `\nבחופשה: ${stats.vacation.join(', ')}` : '') +
          (stats.wfh.length      ? `\nWFH: ${stats.wfh.join(', ')}`         : '') +
          (stats.sick.length     ? `\nמחלה: ${stats.sick.join(', ')}`        : '');
      ctx.subject = 'team_status'; ctx.dateInfo = todayDi;
    }
    else if (intent === 'departments') {
      r = resolveDirective('DEPARTMENTS', currentUser, db);
      ctx.subject = 'dept';
    }
    else if (intent === 'employees') {
      r = resolveDirective('EMPLOYEES', currentUser, db);
      ctx.subject = 'employees';
    }
    else if (intent === 'upcoming_vacations') {
      r = resolveDirective('VACATIONS', currentUser, db);
      ctx.subject = 'vacation';
    }
    else if (intent === 'profile')       r = runLiveData('מי אני', currentUser, db);
    else if (intent === 'dept_self') {
      const dept = Array.isArray(currentUser.dept) ? currentUser.dept.join(', ') : (currentUser.dept || '—');
      const myDeptKey = Array.isArray(currentUser.dept) ? currentUser.dept[0] : currentUser.dept;
      const members = Object.values(db.users||{}).filter(u =>
        u.status!=='pending' && (Array.isArray(u.dept)?u.dept[0]:u.dept) === myDeptKey
      );
      r = `אתה שייך למחלקת **${dept}** — ${members.length} עובדים:\n${members.map(u=>`• ${u.fullName}${u.username===currentUser.username?' (אתה)':''}`).join('\n')}`;
      ctx.subject = 'dept'; ctx.dept = myDeptKey;
    }
    else if (intent === 'my_manager') {
      const myDept = Array.isArray(currentUser.dept)?currentUser.dept[0]:(currentUser.dept||'');
      const mgrEntry = Object.entries(db.deptManagers||{}).find(([k])=>k===myDept);
      if (!mgrEntry) r = `לא הוגדר מנהל למחלקת **${myDept}**. פנה לאדמין.`;
      else {
        const mgr = (db.users||{})[mgrEntry[1]];
        r = `המנהל של מחלקת **${myDept}** הוא **${mgr?mgr.fullName:mgrEntry[1]}**.`;
      }
    }
    else if (intent === 'status_today') {
      const today = dateKey(new Date());
      const tp = (db.vacations?.[currentUser.username]||{})[today];
      const word = {full:'בחופשה 🏖️',half:'חצי יום 🌅',wfh:'WFH 🏠',sick:'מחלה 🤒'}[tp] || 'במשרד 📍';
      const cb = calcBalance(currentUser.username, year, db);
      r = `**${fn(currentUser)}**, היום (${new Date().toLocaleDateString('he-IL')}) אתה **${word}**.` +
          (cb ? `\nיתרת חופשה: **${cb.balance.toFixed(1)} ימים**` : '');
      ctx.subject = 'status_today'; ctx.dateInfo = todayDi;
    }

    else if (intent === 'burnout') {
      r = respondBurnout(db);
      ctx.subject = 'employees';
    }

    // שמור נושא מ-intent ב-ctx
    if (r && intent === 'balance')   { ctx.subject = 'balance'; ctx.targetUser = null; }
    if (r && intent === 'forecast')  { ctx.subject = 'forecast'; }
    if (r && intent === 'used')      { ctx.subject = 'used'; }
    if (r && intent === 'requests')  { ctx.subject = 'requests'; }

    // 1. עזרה
    if (!r && /^(עזרה|help|מה אתה יכול|מה ניתן לשאול|מה אפשר לשאול)/.test(norm(rawInput)))
      r = respondHelp(currentUser, db);

    // 2. שיחה חופשית (regex בלבד, ללא Fuse)
    if (!r) r = runConversation(rawInput, currentUser, db);

    // 3. נתונים חיים (+ Fuse לשמות ומחלקות)
    if (!r) r = runLiveData(rawInput, currentUser, db);

    // 4. בסיס ידע (+ Fuse לתיקון כתיב) — עם user+db לממש הוראות i:
    if (!r) r = runKnowledge(rawInput, currentUser, db);

    // 5. Fallback (+ Fuse כניסיון אחרון)
    if (!r) r = runFallback(rawInput, currentUser, db);

    ctx.lastAnswer = r;
    history.push({role:'ai', text:r});
    return r;
  }

  function clearHistory() {
    history = [];
    ctx = { subject:null, filter:null, dateInfo:null, targetUser:null, dept:null, resultList:[], lastAnswer:null };
    _kbFuse = null;
  }

  return {respond, clearHistory};

})();

// Browser / Node-vm export
if (typeof window !== 'undefined') { window.DazuraAI = DazuraAI; }
if (typeof module !== 'undefined' && module.exports) { module.exports = DazuraAI; }
