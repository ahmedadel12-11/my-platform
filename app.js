const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let state = { me:null, students:[], groups:[], exams:[], announcements:[], warnings:[], scoreRows:[] };
const today = new Date().toLocaleDateString('en-CA');
$('#year').textContent = new Date().getFullYear();
const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800)}
async function api(path, options={}){
  const res=await fetch('/api/'+path,{credentials:'same-origin',...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
  const type=res.headers.get('content-type')||'';
  if(!res.ok){let msg='حدث خطأ غير متوقع';if(type.includes('json')){const d=await res.json();msg=d.error||msg}else msg=await res.text();throw new Error(msg)}
  return type.includes('json')?res.json():res;
}
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
function show(view){['login-view','admin-view','student-view'].forEach(id=>$('#'+id).classList.toggle('hidden',id!==view));$('#logout').classList.toggle('hidden',view==='login-view')}
function setBusy(form,busy){const b=form.querySelector('button[type="submit"],button:not([type])');if(b){b.disabled=busy;b.dataset.old??=b.textContent;b.textContent=busy?'جارٍ الحفظ…':b.dataset.old}}
function formData(form){return Object.fromEntries(new FormData(form).entries())}
function stageBadge(stage){return `<span class="badge">${esc(stage)}</span>`}
function empty(text){return `<div class="empty">${esc(text)}</div>`}

$$('[data-login]').forEach(btn=>btn.addEventListener('click',()=>{
  $$('[data-login]').forEach(x=>x.classList.toggle('active',x===btn));
  $('#student-login').classList.toggle('hidden',btn.dataset.login!=='student');
  $('#teacher-login').classList.toggle('hidden',btn.dataset.login!=='teacher');
  $('#login-error').textContent='';
}));
async function login(form,endpoint){
  $('#login-error').textContent='';setBusy(form,true);
  try{await post(endpoint,formData(form));form.reset();await bootstrap()}
  catch(e){$('#login-error').textContent=e.message}
  finally{setBusy(form,false)}
}
$('#student-login').addEventListener('submit',e=>{e.preventDefault();login(e.currentTarget,'login-student')});
$('#teacher-login').addEventListener('submit',e=>{e.preventDefault();login(e.currentTarget,'login-teacher')});
$('#logout').addEventListener('click',async()=>{try{await post('logout',{})}catch{}state.me=null;show('login-view');$('#whoami').textContent=''});

async function bootstrap(){
  const me=await api('me');
  if(!me.authenticated){show('login-view');$('#whoami').textContent='';return}
  state.me=me;$('#whoami').textContent=me.role==='teacher'?'المدرس':me.student.name;
  if(me.role==='teacher'){show('admin-view');await loadAdmin()}
  else{show('student-view');await loadStudent()}
}
async function loadAdmin(){
  const d=await api('admin/overview');Object.assign(state,d);
  renderStats();renderStudents();renderGroups();renderWarnings();renderExams();renderAnnouncements();renderSelects();renderScoreRows();
}
function renderStats(){
 const s=state.stats||{};
 $('#stats').innerHTML=[['إجمالي الطلاب',s.students||0],['المجموعات',s.groups||0],['مرات الغياب',s.absences||0],['الامتحانات',s.exams||0]]
 .map(([a,b])=>`<div class="stat"><span>${a}</span><strong>${b}</strong></div>`).join('');
}
function renderStudents(){
 const q=($('#student-search').value||'').trim().toLowerCase(),stage=$('#student-stage-filter').value;
 const rows=state.students.filter(s=>(!stage||s.stage===stage)&&(!q||s.name.toLowerCase().includes(q)||s.code.includes(q)));
 $('#students-table').innerHTML=rows.length?rows.map(s=>`<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.code)}</td><td>${stageBadge(s.stage)}</td><td>${esc(s.group_name||'بدون مجموعة')}</td><td>${s.absences>=3?`<span class="badge red">${s.absences} غياب</span>`:s.absences}</td><td><div class="table-actions"><button class="mini-btn" data-edit="${s.id}">تعديل</button><button class="mini-btn danger" data-delete="${s.id}">حذف</button></div></td></tr>`).join(''): `<tr><td colspan="6">${empty('لا يوجد طلاب مطابقون للبحث.')}</td></tr>`;
 $('#students-table').querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>deleteStudent(+b.dataset.delete)));
 $('#students-table').querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editStudent(+b.dataset.edit)));
}
function renderGroups(){
 $('#groups-list').innerHTML=state.groups.length?state.groups.map(g=>`<article class="group-card"><h3>${esc(g.name)}</h3>${stageBadge(g.stage)}<p>📅 ${esc(g.lesson_days||'الأيام غير محددة')}</p><p>🕒 ${esc(g.lesson_time||'الموعد غير محدد')}</p><p>عدد الطلاب: ${state.students.filter(s=>s.group_id===g.id).length}</p><button class="mini-btn danger" data-group-delete="${g.id}">حذف المجموعة</button></article>`).join(''):empty('لم يتم إنشاء مجموعات بعد.');
 $('#groups-list').querySelectorAll('[data-group-delete]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('حذف المجموعة؟ سيظل الطلاب موجودين بدون مجموعة.'))return;try{await api('admin/groups/'+b.dataset.groupDelete,{method:'DELETE'});toast('تم حذف المجموعة');await loadAdmin()}catch(e){toast(e.message)}}));
}
function renderSelects(){
 const groups=state.groups.map(g=>`<option value="${g.id}">${esc(g.name)} — ${esc(g.stage)}</option>`).join('');
 $('#student-group').innerHTML='<option value="">بدون مجموعة</option>'+groups;
 const students=state.students.map(s=>`<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('');
 ['attendance-student','score-student'].forEach(id=>$('#'+id).innerHTML=students||'<option value="">أضف طالباً أولاً</option>');
 $('#score-exam').innerHTML=state.exams.map(e=>`<option value="${e.id}">${esc(e.title)} (${esc(e.stage)} — ${e.max_score})</option>`).join('')||'<option value="">أضف امتحاناً أولاً</option>';
}
function renderWarnings(){
 $('#warnings-list').innerHTML=state.warnings.length?'<h3>تنبيهات الغياب</h3>'+state.warnings.map(w=>`<div class="warning-card ${w.absences>3?'over':''}"><strong>${esc(w.name)}</strong> — ${w.absences} حصص غياب. ${w.absences>3?'تحذير: تجاوز 3 حصص غياب.':'تنبيه: وصل إلى 3 حصص غياب.'} ${w.guardian_phone?`<span>رقم ولي الأمر: ${esc(w.guardian_phone)}</span>`:'<span>لم يُسجل رقم ولي الأمر.</span>'}</div>`).join(''):empty('لا توجد تنبيهات غياب حالياً.');
}
function renderExams(){
 $('#exams-table').innerHTML=state.exams.length?state.exams.map(e=>`<tr><td>${esc(e.title)}</td><td>${stageBadge(e.stage)}</td><td>${e.max_score}</td><td>${esc(e.exam_date)}</td></tr>`).join(''):`<tr><td colspan="4">${empty('لا توجد امتحانات بعد.')}</td></tr>`;
}
function renderAnnouncements(){
 $('#announcements-list').innerHTML=state.announcements.length?state.announcements.map(a=>`<div class="list-item"><strong>${esc(a.title)}</strong> <span class="badge">${esc(a.target_stage)}</span><p>${esc(a.body)}</p></div>`).join(''):empty('لا توجد إعلانات منشورة.');
}
function renderScoreRows(){
 const panel=$('#score-results');
 if(panel) panel.innerHTML=state.scoreRows?.length?state.scoreRows.map(r=>`<div class="data-row"><span>${esc(r.name)} · ${esc(r.title)}</span><strong>${r.score} / ${r.max_score} (${r.percentage}%)</strong></div>`).join(''):empty('لم يتم رصد درجات بعد.');
}
async function deleteStudent(id){if(!confirm('هل تريد حذف الطالب؟ سيتم حذف سجل حضوره ودرجاته أيضاً.'))return;try{await api('admin/students/'+id,{method:'DELETE'});toast('تم حذف الطالب');await loadAdmin()}catch(e){toast(e.message)}}
async function editStudent(id){
 const s=state.students.find(x=>x.id===id);if(!s)return;
 const name=prompt('اسم الطالب',s.name);if(name===null)return;
 const guardian_name=prompt('اسم ولي الأمر',s.guardian_name||'')??s.guardian_name;
 const guardian_phone=prompt('رقم ولي الأمر',s.guardian_phone||'')??s.guardian_phone;
 try{await api('admin/students/'+id,{method:'PATCH',body:JSON.stringify({name,stage:s.stage,group_id:s.group_id,guardian_name,guardian_phone})});toast('تم تعديل بيانات الطالب');await loadAdmin()}catch(e){toast(e.message)}
}
$('#student-search').addEventListener('input',renderStudents);$('#student-stage-filter').addEventListener('change',renderStudents);
$('#add-student-toggle').addEventListener('click',()=>$('#student-form').classList.toggle('hidden'));
$('#cancel-student').addEventListener('click',()=>{$('#student-form').reset();$('#student-form').classList.add('hidden')});
$('#student-form').addEventListener('submit',async e=>{
 e.preventDefault();const f=e.currentTarget;setBusy(f,true);
 try{const d=formData(f);d.group_id=d.group_id||null;const r=await post('admin/students',d);
 $('#new-credentials').classList.remove('hidden');$('#new-credentials').innerHTML=`<strong>تم إنشاء حساب الطالب</strong><p>الكود: <strong>${esc(r.code)}</strong> · الرقم السري: <strong>${esc(r.pin)}</strong></p><p>احفظ البيانات وسلّمها للطالب. لن يظهر الرقم السري مرة أخرى.</p><button class="mini-btn" id="copy-credentials">نسخ بيانات الدخول</button>`;
 $('#copy-credentials').addEventListener('click',()=>navigator.clipboard?.writeText(`كود الطالب: ${r.code}\nالرقم السري: ${r.pin}`).then(()=>toast('تم نسخ بيانات الدخول')).catch(()=>toast('تعذر النسخ على هذا الجهاز')));
 f.reset();f.classList.add('hidden');toast('تمت إضافة الطالب');await loadAdmin();
 }catch(err){toast(err.message)}finally{setBusy(f,false)}
});
$('#group-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;try{await post('admin/groups',formData(f));f.reset();toast('تم إنشاء المجموعة');await loadAdmin()}catch(err){toast(err.message)}});
$('#attendance-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.currentTarget);d.student_id=Number(d.student_id);try{const r=await post('admin/attendance',d);toast(r.overLimit?`تم الحفظ — تحذير: ${r.absences} غياب`:r.warning?`تم الحفظ — تنبيه: ${r.absences} غياب`:'تم تسجيل الحضور');await loadAdmin()}catch(err){toast(err.message)}});
$('#exam-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.currentTarget);d.max_score=Number(d.max_score);try{await post('admin/exams',d);e.currentTarget.reset();toast('تم إضافة الامتحان');await loadAdmin()}catch(err){toast(err.message)}});
$('#score-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.currentTarget);d.exam_id=Number(d.exam_id);d.student_id=Number(d.student_id);d.score=Number(d.score);try{const r=await post('admin/scores',d);toast(`تم حفظ الدرجة — النسبة ${r.percentage}%`);await loadAdmin()}catch(err){toast(err.message)}});
$('#announcement-form').addEventListener('submit',async e=>{e.preventDefault();try{await post('admin/announcements',formData(e.currentTarget));e.currentTarget.reset();toast('تم نشر الإعلان');await loadAdmin()}catch(err){toast(err.message)}});
$('#attendance-form [name="date"]').value=today;$('#exam-form [name="date"]').value=today;
$$('.section-tab').forEach(b=>b.addEventListener('click',()=>{$$('.section-tab').forEach(x=>x.classList.toggle('active',x===b));$$('#admin-view .panel').forEach(p=>p.classList.toggle('hidden',p.id!==b.dataset.panel))}));
$('#print-report').addEventListener('click',()=>window.print());

async function loadStudent(){
 const d=await api('student/overview');$('#student-greeting').textContent='أهلاً '+d.student.name;
 $('#student-meta').textContent=`${d.student.stage} · ${d.student.group_name||'بدون مجموعة'} · كود الطالب ${d.student.code}`;
 $('#student-warning').innerHTML=d.warning?`<div class="warning-card ${d.overLimit?'over':''}">${d.overLimit?'تحذير:':'تنبيه:'} لديك ${d.absences} حصص غياب. ${d.overLimit?'يرجى الالتزام بالحضور.':'نرجو الانتباه إلى الحضور بانتظام.'}</div>`:'';
 $('#my-scores').innerHTML=d.scores.length?d.scores.map(s=>`<div class="data-row"><span><strong>${esc(s.title)}</strong><br><small class="muted">${esc(s.exam_date)}</small></span><strong>${s.score} / ${s.max_score}<br><small class="muted">${s.percentage}%</small></strong></div>`).join(''):empty('لم تُرصد درجات لك حتى الآن.');
 $('#my-attendance').innerHTML=d.attendance.length?d.attendance.map(a=>`<div class="data-row"><span>${esc(a.lesson_date)}</span><strong>${a.status==='present'?'حاضر':a.status==='absent'?'غائب':'متأخر'}</strong></div>`).join(''):empty('لا يوجد سجل حضور بعد.');
 $('#my-announcements').innerHTML=d.announcements.length?d.announcements.map(a=>`<div class="list-item"><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p><small class="muted">${esc(a.created_at)}</small></div>`).join(''):empty('لا توجد إعلانات حالياً.');
}
bootstrap().catch(e=>{console.error(e);show('login-view');$('#login-error').textContent='تعذر الاتصال بالمنصة. تأكد من إعداد قاعدة البيانات.'});
