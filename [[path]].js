const SESSION_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function fail(message, status = 400) { return json({ error: message }, status); }
function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
function randomSixDigits() {
  const b = randomBytes(4);
  const n = (((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) % 900000;
  return String(100000 + n);
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function sha256(s) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))); }
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(salt), iterations: 150000, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cookie(token, maxAge = SESSION_SECONDS) {
  return `aa_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function clearCookie() { return "aa_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"; }
async function body(request) { try { return await request.json(); } catch { return null; } }
function validText(v, max = 120) { return typeof v === "string" && v.trim().length > 0 && v.trim().length <= max; }
function safeStage(v) { return v === "إعدادي" || v === "ثانوي"; }
function csvCell(v) { return `"${String(v ?? "").replaceAll('"','""')}"`; }

async function rateLimit(env, key, now) {
  const row = await env.DB.prepare("SELECT hits, reset_at FROM rate_limits WHERE key=?").bind(key).first();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare("INSERT INTO rate_limits(key,hits,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=1, reset_at=excluded.reset_at")
      .bind(key, now + 900).run();
    return true;
  }
  if (row.hits >= 12) return false;
  await env.DB.prepare("UPDATE rate_limits SET hits=hits+1 WHERE key=?").bind(key).run();
  return true;
}
async function getAuth(request, env) {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)aa_session=([^;]+)/);
  if (!match) return null;
  const tokenHash = await sha256(decodeURIComponent(match[1]));
  const session = await env.DB.prepare(
    "SELECT role, student_id, expires_at FROM sessions WHERE token_hash=?"
  ).bind(tokenHash).first();
  if (!session || session.expires_at < Math.floor(Date.now()/1000)) {
    if (session) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  return session;
}
async function createSession(env, role, studentId = null) {
  const token = b64(randomBytes(32));
  const expires = Math.floor(Date.now()/1000) + SESSION_SECONDS;
  await env.DB.prepare("INSERT INTO sessions(token_hash,role,student_id,expires_at) VALUES(?,?,?,?)")
    .bind(await sha256(token), role, studentId, expires).run();
  return token;
}
function requireRole(auth, role) { return !!auth && auth.role === role; }

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  if (!env.DB) return fail("قاعدة البيانات غير مربوطة. راجع إعداد D1 في دليل النشر.", 503);

  if (method === "GET" && route[0] === "health") {
    try { await env.DB.prepare("SELECT 1 AS ok").first(); return json({ ok: true, service: "ahmed-adel-platform" }); }
    catch { return fail("تعذر الاتصال بقاعدة البيانات.", 503); }
  }

  const auth = await getAuth(request, env);
  if (method === "GET" && route[0] === "me") {
    if (!auth) return json({ authenticated: false });
    if (auth.role === "teacher") return json({ authenticated: true, role: "teacher" });
    const student = await env.DB.prepare("SELECT id,name,code,stage,group_id FROM students WHERE id=?").bind(auth.student_id).first();
    return student ? json({ authenticated: true, role: "student", student }) : json({ authenticated: false });
  }

  if (method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return fail("طلب غير مسموح.", 403);
  }

  if (method === "POST" && route[0] === "login-teacher") {
    const data = await body(request);
    if (!env.ADMIN_PASSWORD || !validText(data?.password, 300)) return fail("بيانات الدخول غير صحيحة.", 401);
    const ipKey = await sha256("teacher:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
    if (!await rateLimit(env, ipKey, Math.floor(Date.now()/1000))) return fail("محاولات كثيرة. حاول بعد 15 دقيقة.", 429);
    const supplied = await sha256(data.password);
    const expected = await sha256(env.ADMIN_PASSWORD);
    if (!equal(supplied, expected)) return fail("كلمة مرور المدرس غير صحيحة.", 401);
    const token = await createSession(env, "teacher");
    return json({ ok: true, role: "teacher" }, 200, { "set-cookie": cookie(token) });
  }

  if (method === "POST" && route[0] === "login-student") {
    const data = await body(request);
    if (!validText(data?.code, 20) || !validText(data?.pin, 20)) return fail("اكتب كود الطالب والرقم السري.", 400);
    const now = Math.floor(Date.now()/1000);
    const ipKey = await sha256("student-ip:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
    const codeKey = await sha256("student-code:" + data.code.trim());
    if (!await rateLimit(env, ipKey, now) || !await rateLimit(env, codeKey, now))
      return fail("محاولات كثيرة. حاول بعد 15 دقيقة.", 429);
    const student = await env.DB.prepare("SELECT id,pin_hash,pin_salt FROM students WHERE code=?").bind(data.code.trim()).first();
    if (!student || !equal(await pinHash(data.pin.trim(), student.pin_salt), student.pin_hash))
      return fail("كود الطالب أو الرقم السري غير صحيح.", 401);
    const token = await createSession(env, "student", student.id);
    return json({ ok: true, role: "student" }, 200, { "set-cookie": cookie(token) });
  }

  if (method === "POST" && route[0] === "logout") {
    const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)aa_session=([^;]+)/);
    if (match) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(decodeURIComponent(match[1]))).run();
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  if (route[0] === "admin") {
    if (!requireRole(auth, "teacher")) return fail("يجب تسجيل دخول المدرس.", 401);

    if (method === "GET" && route[1] === "overview") {
      const [students, groups, exams, announcements, stats, warnings, scoreRows] = await Promise.all([
        env.DB.prepare(`SELECT s.id,s.code,s.name,s.stage,s.group_id,s.guardian_name,s.guardian_phone,g.name AS group_name,
          (SELECT COUNT(*) FROM attendance a WHERE a.student_id=s.id AND a.status='absent') AS absences
          FROM students s LEFT JOIN groups g ON g.id=s.group_id ORDER BY s.name`).all(),
        env.DB.prepare("SELECT * FROM groups ORDER BY stage,name").all(),
        env.DB.prepare("SELECT * FROM exams ORDER BY exam_date DESC,id DESC").all(),
        env.DB.prepare("SELECT * FROM announcements ORDER BY id DESC LIMIT 30").all(),
        env.DB.prepare(`SELECT (SELECT COUNT(*) FROM students) AS students,
          (SELECT COUNT(*) FROM groups) AS groups,
          (SELECT COUNT(*) FROM attendance WHERE status='absent') AS absences,
          (SELECT COUNT(*) FROM exams) AS exams`).first(),
        env.DB.prepare(`SELECT s.id,s.name,s.code,COUNT(a.id) AS absences,s.guardian_name,s.guardian_phone
          FROM students s JOIN attendance a ON a.student_id=s.id AND a.status='absent'
          GROUP BY s.id HAVING COUNT(a.id)>=3 ORDER BY absences DESC`).all(),
        env.DB.prepare(`SELECT s.name,s.code,e.title,sc.score,e.max_score,ROUND(sc.score*100.0/e.max_score,2) AS percentage
          FROM scores sc JOIN students s ON s.id=sc.student_id JOIN exams e ON e.id=sc.exam_id
          ORDER BY e.exam_date DESC,s.name LIMIT 200`).all()
      ]);
      return json({ students: students.results, groups: groups.results, exams: exams.results,
        announcements: announcements.results, stats, warnings: warnings.results, scoreRows: scoreRows.results });
    }

    if (method === "POST" && route[1] === "groups") {
      const d = await body(request);
      if (!validText(d?.name, 80) || !safeStage(d?.stage)) return fail("أدخل اسم المجموعة والمرحلة.");
      const result = await env.DB.prepare("INSERT INTO groups(name,stage,lesson_days,lesson_time) VALUES(?,?,?,?)")
        .bind(d.name.trim(), d.stage, String(d.days||"").slice(0,100), String(d.time||"").slice(0,50)).run();
      return json({ ok:true, id:result.meta.last_row_id });
    }

    if (method === "POST" && route[1] === "students") {
      const d = await body(request);
      if (!validText(d?.name,100) || !safeStage(d?.stage)) return fail("أدخل اسم الطالب والمرحلة.");
      if (d.guardian_phone && !/^[0-9+()\-\s]{7,20}$/.test(d.guardian_phone)) return fail("رقم ولي الأمر غير صحيح.");
      if (d.group_id) {
        const g = await env.DB.prepare("SELECT id,stage FROM groups WHERE id=?").bind(Number(d.group_id)).first();
        if (!g || g.stage !== d.stage) return fail("المجموعة غير موجودة أو لا تطابق المرحلة.");
      }
      let code = "";
      for (let i=0;i<12;i++) {
        code = randomSixDigits();
        if (!await env.DB.prepare("SELECT id FROM students WHERE code=?").bind(code).first()) break;
        code = "";
      }
      if (!code) return fail("تعذر إنشاء كود فريد. حاول مرة أخرى.", 503);
      const pin = randomSixDigits();
      const salt = b64(randomBytes(16));
      const hash = await pinHash(pin, salt);
      const result = await env.DB.prepare(`INSERT INTO students(code,name,stage,group_id,pin_hash,pin_salt,guardian_name,guardian_phone)
        VALUES(?,?,?,?,?,?,?,?)`).bind(code,d.name.trim(),d.stage,d.group_id?Number(d.group_id):null,hash,salt,
          String(d.guardian_name||"").slice(0,100),String(d.guardian_phone||"").slice(0,20)).run();
      return json({ ok:true, id:result.meta.last_row_id, code, pin },201);
    }

    if (method === "PATCH" && route[1] === "students" && route[2]) {
      const id = Number(route[2]), d = await body(request);
      if (!Number.isInteger(id) || !validText(d?.name,100) || !safeStage(d?.stage)) return fail("بيانات التعديل غير مكتملة.");
      if (d.group_id) {
        const g = await env.DB.prepare("SELECT id,stage FROM groups WHERE id=?").bind(Number(d.group_id)).first();
        if (!g || g.stage !== d.stage) return fail("المجموعة لا تطابق المرحلة.");
      }
      await env.DB.prepare(`UPDATE students SET name=?,stage=?,group_id=?,guardian_name=?,guardian_phone=? WHERE id=?`)
        .bind(d.name.trim(),d.stage,d.group_id?Number(d.group_id):null,String(d.guardian_name||"").slice(0,100),
          String(d.guardian_phone||"").slice(0,20),id).run();
      return json({ok:true});
    }
    if (method === "DELETE" && route[1] === "students" && route[2]) {
      await env.DB.prepare("DELETE FROM students WHERE id=?").bind(Number(route[2])).run();
      return json({ok:true});
    }
    if (method === "DELETE" && route[1] === "groups" && route[2]) {
      await env.DB.prepare("DELETE FROM groups WHERE id=?").bind(Number(route[2])).run();
      return json({ok:true});
    }

    if (method === "POST" && route[1] === "attendance") {
      const d = await body(request);
      if (!Number.isInteger(Number(d?.student_id)) || !/^\d{4}-\d{2}-\d{2}$/.test(d?.date||"") ||
          !["present","absent","late"].includes(d?.status)) return fail("بيانات الحضور غير صحيحة.");
      const s = await env.DB.prepare("SELECT id FROM students WHERE id=?").bind(Number(d.student_id)).first();
      if (!s) return fail("الطالب غير موجود.",404);
      await env.DB.prepare(`INSERT INTO attendance(student_id,lesson_date,status,note) VALUES(?,?,?,?)
        ON CONFLICT(student_id,lesson_date) DO UPDATE SET status=excluded.status,note=excluded.note`)
        .bind(Number(d.student_id),d.date,d.status,String(d.note||"").slice(0,250)).run();
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE student_id=? AND status='absent'")
        .bind(Number(d.student_id)).first();
      return json({ok:true,absences:count.n,warning:count.n>=3,overLimit:count.n>3});
    }

    if (method === "POST" && route[1] === "exams") {
      const d = await body(request);
      if (!validText(d?.title,100) || !safeStage(d?.stage) || !Number.isFinite(Number(d?.max_score)) ||
          Number(d.max_score)<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(d?.date||"")) return fail("بيانات الامتحان غير صحيحة.");
      const r = await env.DB.prepare("INSERT INTO exams(title,stage,max_score,exam_date) VALUES(?,?,?,?)")
        .bind(d.title.trim(),d.stage,Number(d.max_score),d.date).run();
      return json({ok:true,id:r.meta.last_row_id});
    }

    if (method === "POST" && route[1] === "scores") {
      const d = await body(request);
      const score=Number(d?.score), studentId=Number(d?.student_id), examId=Number(d?.exam_id);
      if (!Number.isFinite(score) || score<0 || !Number.isInteger(studentId) || !Number.isInteger(examId)) return fail("بيانات الدرجة غير صحيحة.");
      const exam=await env.DB.prepare("SELECT max_score,stage FROM exams WHERE id=?").bind(examId).first();
      const student=await env.DB.prepare("SELECT stage FROM students WHERE id=?").bind(studentId).first();
      if (!exam || !student || exam.stage!==student.stage || score>exam.max_score) return fail("تأكد من الطالب والامتحان والدرجة.");
      await env.DB.prepare(`INSERT INTO scores(student_id,exam_id,score) VALUES(?,?,?)
        ON CONFLICT(student_id,exam_id) DO UPDATE SET score=excluded.score,updated_at=CURRENT_TIMESTAMP`)
        .bind(studentId,examId,score).run();
      return json({ok:true,percentage:Math.round(score/exam.max_score*10000)/100});
    }

    if (method === "POST" && route[1] === "announcements") {
      const d=await body(request);
      if (!validText(d?.title,100) || !validText(d?.body,1500) ||
          !["الكل","إعدادي","ثانوي"].includes(d?.target_stage||"الكل")) return fail("اكتب عنوان الإعلان ومحتواه.");
      const r=await env.DB.prepare("INSERT INTO announcements(title,body,target_stage) VALUES(?,?,?)")
        .bind(d.title.trim(),d.body.trim(),d.target_stage||"الكل").run();
      return json({ok:true,id:r.meta.last_row_id});
    }
    if (method === "GET" && route[1] === "export") {
      const kind=url.searchParams.get("kind")||"scores";
      let rows, headers;
      if(kind==="attendance") {
        headers=["كود الطالب","اسم الطالب","المرحلة","التاريخ","الحالة"];
        rows=(await env.DB.prepare(`SELECT s.code,s.name,s.stage,a.lesson_date,
          CASE a.status WHEN 'present' THEN 'حاضر' WHEN 'absent' THEN 'غائب' ELSE 'متأخر' END AS status
          FROM attendance a JOIN students s ON s.id=a.student_id ORDER BY a.lesson_date DESC,s.name`).all()).results;
      } else {
        headers=["كود الطالب","اسم الطالب","المرحلة","المجموعة","الامتحان","الدرجة","النهاية","النسبة %"];
        rows=(await env.DB.prepare(`SELECT s.code,s.name,s.stage,COALESCE(g.name,'-') AS group_name,e.title,sc.score,e.max_score,
          ROUND(sc.score*100.0/e.max_score,2) AS percentage
          FROM scores sc JOIN students s ON s.id=sc.student_id JOIN exams e ON e.id=sc.exam_id
          LEFT JOIN groups g ON g.id=s.group_id ORDER BY s.name,e.exam_date DESC`).all()).results;
      }
      const lines=[headers,...rows.map(r=>Object.values(r))].map(row=>row.map(csvCell).join(","));
      return new Response("\uFEFF"+lines.join("\r\n"),{headers:{
        "content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${kind}.csv"`,
        "cache-control":"no-store"
      }});
    }
  }

  if (route[0] === "student") {
    if (!requireRole(auth,"student")) return fail("يجب تسجيل دخول الطالب.",401);
    if (method === "GET" && route[1] === "overview") {
      const student = await env.DB.prepare(`SELECT s.id,s.code,s.name,s.stage,g.name AS group_name
        FROM students s LEFT JOIN groups g ON g.id=s.group_id WHERE s.id=?`).bind(auth.student_id).first();
      if (!student) return fail("الحساب غير موجود.",404);
      const [scores, attendance, announcements] = await Promise.all([
        env.DB.prepare(`SELECT e.title,e.exam_date,e.max_score,sc.score,ROUND(sc.score*100.0/e.max_score,2) AS percentage
          FROM scores sc JOIN exams e ON e.id=sc.exam_id WHERE sc.student_id=? ORDER BY e.exam_date DESC`).bind(auth.student_id).all(),
        env.DB.prepare("SELECT lesson_date,status,note FROM attendance WHERE student_id=? ORDER BY lesson_date DESC").bind(auth.student_id).all(),
        env.DB.prepare("SELECT title,body,created_at FROM announcements WHERE target_stage IN ('الكل',?) ORDER BY id DESC LIMIT 30").bind(student.stage).all()
      ]);
      const absences=attendance.results.filter(a=>a.status==="absent").length;
      return json({student,scores:scores.results,attendance:attendance.results,announcements:announcements.results,
        absences,warning:absences>=3,overLimit:absences>3});
    }
  }
  return fail("المسار غير موجود.",404);
}
