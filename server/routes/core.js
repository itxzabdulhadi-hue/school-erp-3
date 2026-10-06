import { Router } from 'express';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText } from '../http.js';
import { requirePermission } from '../access.js';

const router = Router();

router.get('/dashboard', requirePermission('dashboard', 'view'), asyncRoute(async (req, res) => {
  if (req.user.roles.includes('student')) return res.json(await studentDashboard(req.user));
  if (req.user.roles.includes('teacher')) return res.json(await teacherDashboard(req.user));
  if (req.user.roles.includes('staff') || req.user.roles.some((role) => ['librarian','transport_manager'].includes(role))) {
    return res.json(await staffDashboard(req.user));
  }
  const canSeeFinance = req.user.roles.some((role) => ['school_admin','super_admin','accountant'].includes(role));
  const canManage = req.user.roles.some((role) => ['school_admin','super_admin','principal'].includes(role));
  const schoolId = req.user.school_id;
  const [counts, attendance, finance, upcomingExams, events, admissions, payments, announcements, attendanceTrend, feeTrend, population, performance] = await Promise.all([
    query(
      `SELECT
        (SELECT count(*)::int FROM students WHERE school_id=$1 AND archived_at IS NULL AND status='active') AS students,
        (SELECT count(*)::int FROM teachers WHERE school_id=$1 AND archived_at IS NULL AND employment_status='active') AS teachers,
        (SELECT count(*)::int FROM staff WHERE school_id=$1 AND archived_at IS NULL AND employment_status='active') AS staff,
        (SELECT count(*)::int FROM classes WHERE school_id=$1 AND archived_at IS NULL) AS classes,
        (SELECT count(*)::int FROM sections WHERE school_id=$1 AND archived_at IS NULL) AS sections,
        (SELECT count(*)::int FROM exams WHERE school_id=$1 AND status IN ('scheduled','in_progress') AND start_date >= CURRENT_DATE) AS upcoming_exams`, [schoolId],
    ),
    query(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status='present')::int AS present,
         count(*) FILTER (WHERE status='absent')::int AS absent,
         count(*) FILTER (WHERE status='late')::int AS late,
         count(*) FILTER (WHERE status='excused')::int AS excused
       FROM attendance WHERE school_id=$1 AND attendance_date=(now() AT TIME ZONE COALESCE((SELECT timezone FROM schools WHERE id=$1),'UTC'))::date`, [schoolId],
    ),
    canSeeFinance ? query(
      `SELECT
         COALESCE(sum(amount) FILTER (WHERE payment_date::date = (now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))::date),0)::numeric AS today_collection,
         COALESCE(sum(amount) FILTER (WHERE date_trunc('month', payment_date AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1)) = date_trunc('month', now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))),0)::numeric AS month_collection,
         COALESCE((SELECT sum(total-paid) FROM invoices WHERE school_id=$1 AND status NOT IN ('paid','void','draft')),0)::numeric AS outstanding,
         COALESCE((SELECT sum(total-paid) FROM invoices WHERE school_id=$1 AND status <> 'void' AND due_date < CURRENT_DATE AND paid < total),0)::numeric AS overdue,
         COALESCE((SELECT count(*)::int FROM invoices WHERE school_id=$1 AND status <> 'void' AND due_date < CURRENT_DATE AND paid < total),0) AS overdue_count
       FROM payments WHERE school_id=$1`, [schoolId],
    ) : Promise.resolve({ rows: [{ today_collection: null, month_collection: null, outstanding: null, overdue: null, overdue_count: 0 }] }),
    query(`SELECT id,name,exam_type,start_date,end_date,status FROM exams WHERE school_id=$1 AND status IN ('scheduled','in_progress') AND start_date >= CURRENT_DATE ORDER BY start_date LIMIT 5`, [schoolId]),
    query(`SELECT id,title,category,starts_at,location FROM events WHERE school_id=$1 AND starts_at >= now() ORDER BY starts_at LIMIT 5`, [schoolId]),
    canManage ? query(`SELECT s.id,s.student_id,s.first_name,s.last_name,s.admission_date,c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id WHERE s.school_id=$1 AND s.archived_at IS NULL ORDER BY s.created_at DESC LIMIT 5`, [schoolId]) : Promise.resolve({ rows: [] }),
    canSeeFinance ? query(`SELECT p.id,p.receipt_number,p.amount,p.method,p.payment_date,s.first_name,s.last_name,i.invoice_number FROM payments p JOIN students s ON s.id=p.student_id AND s.school_id=p.school_id JOIN invoices i ON i.id=p.invoice_id AND i.school_id=p.school_id WHERE p.school_id=$1 ORDER BY p.payment_date DESC LIMIT 5`, [schoolId]) : Promise.resolve({ rows: [] }),
    query(`SELECT id,title,category,priority,publish_at FROM announcements WHERE school_id=$1 AND archived_at IS NULL AND publish_at <= now() AND (expires_at IS NULL OR expires_at >= now()) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,publish_at DESC LIMIT 5`, [schoolId]),
    query(`SELECT attendance_date AS date, count(*)::int AS total, count(*) FILTER (WHERE status IN ('present','late'))::int AS present FROM attendance WHERE school_id=$1 AND attendance_date >= CURRENT_DATE - INTERVAL '6 days' GROUP BY attendance_date ORDER BY attendance_date`, [schoolId]),
    canSeeFinance ? query(`SELECT date_trunc('month', d.month)::date AS month, COALESCE(sum(p.amount),0)::numeric AS total FROM generate_series(date_trunc('month',CURRENT_DATE) - INTERVAL '5 months',date_trunc('month',CURRENT_DATE),INTERVAL '1 month') d(month) LEFT JOIN payments p ON p.school_id=$1 AND date_trunc('month',p.payment_date)=d.month GROUP BY d.month ORDER BY d.month`, [schoolId]) : Promise.resolve({ rows: [] }),
    query(`SELECT c.name, count(s.id)::int AS count FROM classes c LEFT JOIN students s ON s.current_class_id=c.id AND s.school_id=c.school_id AND s.archived_at IS NULL AND s.status='active' WHERE c.school_id=$1 AND c.archived_at IS NULL GROUP BY c.id ORDER BY c.grade_level NULLS LAST,c.name`, [schoolId]),
    canManage ? query(`SELECT COALESCE(r.grade,'Ungraded') AS grade,count(*)::int AS count FROM results r WHERE r.school_id=$1 GROUP BY r.grade ORDER BY r.grade`, [schoolId]) : Promise.resolve({ rows: [] }),
  ]);
  const localToday = new Date();
  const attendanceMap = new Map(attendanceTrend.rows.map((row) => [String(row.date).slice(0, 10), row]));
  const attendanceChart = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(localToday);
    date.setDate(date.getDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    const row = attendanceMap.get(key);
    return { date: key, label: date.toLocaleDateString('en', { weekday: 'short' }), total: Number(row?.total || 0), present: Number(row?.present || 0) };
  });
  res.json({
    portal: 'admin',
    counts: counts.rows[0],
    attendance: attendance.rows[0],
    finance: finance.rows[0],
    upcomingExams: upcomingExams.rows,
    upcomingEvents: events.rows,
    recentAdmissions: admissions.rows,
    recentPayments: payments.rows,
    announcements: announcements.rows,
    charts: { attendance: attendanceChart, feeCollection: feeTrend.rows, population: population.rows, performance: performance.rows },
  });
}));

async function studentDashboard(user) {
  const studentResult = await query(
    `SELECT s.id,s.student_id,s.first_name,s.last_name,s.current_class_id,s.current_section_id,
            c.name AS class_name,sec.name AS section_name,ay.name AS academic_year
     FROM students s LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
     LEFT JOIN sections sec ON sec.id=s.current_section_id AND sec.school_id=s.school_id
     LEFT JOIN academic_years ay ON ay.id=s.academic_year_id AND ay.school_id=s.school_id
     WHERE s.user_id=$1 AND s.school_id=$2 AND s.archived_at IS NULL`, [user.id,user.school_id],
  );
  if (!studentResult.rowCount) return { portal: 'student', profile: null, message: 'Your student profile is not linked yet. Please contact the school office.' };
  const student = studentResult.rows[0];
  const [attendance, attendanceHistory, timetable, exams, assignments, announcements, events, invoices, materials, results] = await Promise.all([
    query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE status IN ('present','late'))::int AS attended,
             CASE WHEN count(*)=0 THEN 0 ELSE round(count(*) FILTER (WHERE status IN ('present','late'))::numeric*100/count(*),1) END AS percentage
           FROM attendance WHERE student_id=$1 AND school_id=$2 AND attendance_date >= CURRENT_DATE - INTERVAL '90 days'`, [student.id,user.school_id]),
    query(`SELECT attendance_date,status,note FROM attendance WHERE student_id=$1 AND school_id=$2 ORDER BY attendance_date DESC LIMIT 60`,[student.id,user.school_id]),
    query(`SELECT te.id,te.day_of_week,te.start_time,te.end_time,te.room,su.name AS subject_name,t.full_name AS teacher_name
           FROM timetable_entries te JOIN subjects su ON su.id=te.subject_id AND su.school_id=te.school_id
           JOIN teachers t ON t.id=te.teacher_id AND t.school_id=te.school_id
           WHERE te.school_id=$1 AND te.class_id=$2 AND (te.section_id IS NULL OR te.section_id=$3)
             AND te.academic_year_id=(SELECT id FROM academic_years WHERE school_id=$1 AND is_current=true)
           ORDER BY te.day_of_week,te.start_time`, [user.school_id,student.current_class_id,student.current_section_id]),
    query(`SELECT DISTINCT e.id,e.name,e.exam_type,es.exam_date,es.start_time,su.name AS subject_name
           FROM exams e JOIN exam_subjects es ON es.exam_id=e.id AND es.school_id=e.school_id
           JOIN subjects su ON su.id=es.subject_id AND su.school_id=es.school_id
           WHERE e.school_id=$1 AND es.class_id=$2 AND e.status IN ('scheduled','in_progress') AND es.exam_date >= CURRENT_DATE ORDER BY es.exam_date LIMIT 6`, [user.school_id,student.current_class_id]),
    query(`SELECT a.id,a.title,a.due_at,su.name AS subject_name,sub.status AS submission_status
           FROM assignments a JOIN subjects su ON su.id=a.subject_id AND su.school_id=a.school_id
           LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id AND sub.student_id=$1 AND sub.school_id=a.school_id
           WHERE a.school_id=$2 AND a.class_id=$3 AND (a.section_id IS NULL OR a.section_id=$4)
             AND a.status='published' AND (a.due_at IS NULL OR a.due_at >= now() - INTERVAL '30 days')
           ORDER BY a.due_at NULLS LAST LIMIT 8`, [student.id,user.school_id,student.current_class_id,student.current_section_id]),
    query(`SELECT id,title,category,priority,publish_at FROM announcements WHERE school_id=$1 AND archived_at IS NULL AND publish_at <= now() AND (expires_at IS NULL OR expires_at>=now()) AND (audience IN ('all','students') OR (audience='class' AND class_id=$2)) ORDER BY publish_at DESC LIMIT 5`, [user.school_id,student.current_class_id]),
    query(`SELECT id,title,category,starts_at,location FROM events WHERE school_id=$1 AND starts_at>=now() AND audience IN ('all','students') ORDER BY starts_at LIMIT 5`, [user.school_id]),
    query(`SELECT id,invoice_number,due_date,total,paid,total-paid AS balance,status FROM invoices WHERE school_id=$1 AND student_id=$2 AND status<>'void' ORDER BY issue_date DESC LIMIT 5`, [user.school_id,student.id]),
    query(`SELECT id,title,material_type,resource_url,description FROM study_materials WHERE school_id=$1 AND (class_id IS NULL OR class_id=$2) AND (section_id IS NULL OR section_id=$3) ORDER BY created_at DESC LIMIT 8`, [user.school_id,student.current_class_id,student.current_section_id]),
    query(`SELECT e.name AS exam_name,su.name AS subject_name,r.marks_obtained,es.maximum_marks,r.grade
           FROM results r JOIN exam_subjects es ON es.id=r.exam_subject_id AND es.school_id=r.school_id
           JOIN exams e ON e.id=es.exam_id AND e.school_id=es.school_id JOIN subjects su ON su.id=es.subject_id AND su.school_id=es.school_id
           WHERE r.school_id=$1 AND r.student_id=$2 AND es.results_published_at IS NOT NULL ORDER BY e.start_date DESC LIMIT 5`, [user.school_id,student.id]),
  ]);
  return { portal: 'student', profile: student, attendance: attendance.rows[0], attendanceHistory: attendanceHistory.rows, timetable: timetable.rows,
    upcomingExams: exams.rows, assignments: assignments.rows, announcements: announcements.rows,
    upcomingEvents: events.rows, invoices: invoices.rows, studyMaterials: materials.rows, recentResults: results.rows };
}

async function teacherDashboard(user) {
  const [teacherResult, todayClasses, assignments, announcements] = await Promise.all([
    query(`SELECT id,employee_id,full_name,designation FROM teachers WHERE user_id=$1 AND school_id=$2 AND archived_at IS NULL`, [user.id,user.school_id]),
    query(`SELECT te.id,te.start_time,te.end_time,te.room,c.name AS class_name,sec.name AS section_name,su.name AS subject_name
           FROM timetable_entries te JOIN classes c ON c.id=te.class_id AND c.school_id=te.school_id
           LEFT JOIN sections sec ON sec.id=te.section_id AND sec.school_id=te.school_id
           JOIN subjects su ON su.id=te.subject_id AND su.school_id=te.school_id
           WHERE te.school_id=$1 AND te.teacher_id=(SELECT id FROM teachers WHERE user_id=$2 AND school_id=$1)
             AND te.day_of_week=EXTRACT(DOW FROM CURRENT_DATE)
             AND te.academic_year_id=(SELECT id FROM academic_years WHERE school_id=$1 AND is_current=true)
           ORDER BY te.start_time`, [user.school_id,user.id]),
    query(`SELECT id,title,due_at,class_id FROM assignments WHERE school_id=$1 AND teacher_id=(SELECT id FROM teachers WHERE user_id=$2 AND school_id=$1) AND status='published' ORDER BY due_at NULLS LAST LIMIT 6`, [user.school_id,user.id]),
    query(`SELECT id,title,category,publish_at FROM announcements WHERE school_id=$1 AND archived_at IS NULL AND publish_at<=now() AND (expires_at IS NULL OR expires_at>=now()) AND audience IN ('all','teachers') ORDER BY publish_at DESC LIMIT 5`, [user.school_id]),
  ]);
  const teacher = teacherResult.rows[0] || null;
  const [pending, classes, students, exams] = await Promise.all([
    teacher ? query(`SELECT count(DISTINCT s.id)::int AS count FROM teacher_subjects ts
      JOIN students s ON s.current_class_id=ts.class_id AND s.school_id=ts.school_id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id) AND s.status='active'
      WHERE ts.school_id=$1 AND ts.teacher_id=$2 AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.school_id=s.school_id AND a.student_id=s.id AND a.attendance_date=CURRENT_DATE)`, [user.school_id,teacher.id]) : Promise.resolve({rows:[{count:0}]}),
    teacher ? query(`SELECT DISTINCT c.id,c.name,sec.name AS section_name,su.name AS subject_name FROM teacher_subjects ts
      JOIN classes c ON c.id=ts.class_id AND c.school_id=ts.school_id LEFT JOIN sections sec ON sec.id=ts.section_id AND sec.school_id=ts.school_id
      JOIN subjects su ON su.id=ts.subject_id AND su.school_id=ts.school_id
      WHERE ts.school_id=$1 AND ts.teacher_id=$2 ORDER BY c.name`, [user.school_id,teacher.id]) : Promise.resolve({rows:[]}),
    teacher ? query(`SELECT count(DISTINCT s.id)::int AS count FROM teacher_subjects ts JOIN students s ON s.current_class_id=ts.class_id AND s.school_id=ts.school_id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id) WHERE ts.school_id=$1 AND ts.teacher_id=$2 AND s.status='active'`, [user.school_id,teacher.id]) : Promise.resolve({rows:[{count:0}]}),
    query(`SELECT id,name,exam_type,start_date FROM exams WHERE school_id=$1 AND status='scheduled' AND start_date>=CURRENT_DATE ORDER BY start_date LIMIT 4`, [user.school_id]),
  ]);
  return { portal: 'teacher', profile: teacher, todayClasses: todayClasses.rows, assignments: assignments.rows,
    announcements: announcements.rows, attendancePending: pending.rows[0].count, classes: classes.rows,
    studentCount: students.rows[0].count, upcomingExams: exams.rows };
}

async function staffDashboard(user) {
  const [attendance, leave, announcements, events] = await Promise.all([
    query(`SELECT status FROM staff_attendance WHERE school_id=$1 AND user_id=$2 AND attendance_date=CURRENT_DATE`, [user.school_id,user.id]),
    query(`SELECT id,leave_type,start_date,end_date,status FROM leave_requests WHERE school_id=$1 AND applicant_user_id=$2 ORDER BY created_at DESC LIMIT 5`, [user.school_id,user.id]),
    query(`SELECT id,title,category,publish_at FROM announcements WHERE school_id=$1 AND archived_at IS NULL AND audience IN ('all','staff') AND publish_at<=now() AND (expires_at IS NULL OR expires_at>=now()) ORDER BY publish_at DESC LIMIT 5`, [user.school_id]),
    query(`SELECT id,title,starts_at,location FROM events WHERE school_id=$1 AND starts_at>=now() AND audience IN ('all','staff') ORDER BY starts_at LIMIT 4`, [user.school_id]),
  ]);
  return { portal: 'staff', attendance: attendance.rows[0] || null, leaveRequests: leave.rows,
    announcements: announcements.rows, upcomingEvents: events.rows };
}

router.get('/settings', requirePermission('settings', 'view'), asyncRoute(async (req, res) => {
  const [school, settings, years, terms] = await Promise.all([
    query(`SELECT id,name,motto,logo_url,favicon_url,address,city,country,phone,email,website,principal_name,registration_info,currency,timezone,primary_color,secondary_color,accent_color,settings FROM schools WHERE id=$1 AND archived_at IS NULL`, [req.user.school_id]),
    query(`SELECT date_format,time_format,language,attendance_rules,finance_rules,notification_rules FROM school_settings WHERE school_id=$1`, [req.user.school_id]),
    query(`SELECT id,name,start_date,end_date,is_current FROM academic_years WHERE school_id=$1 AND archived_at IS NULL ORDER BY start_date DESC`, [req.user.school_id]),
    query(`SELECT t.id,t.name,t.start_date,t.end_date,t.is_current,t.academic_year_id,ay.name AS academic_year_name FROM terms t JOIN academic_years ay ON ay.id=t.academic_year_id AND ay.school_id=t.school_id WHERE t.school_id=$1 ORDER BY t.start_date DESC`, [req.user.school_id]),
  ]);
  if (!school.rowCount) return res.status(404).json({ error: 'School configuration not found.' });
  res.json({ school: formatSchool(school.rows[0]), settings: settings.rows[0] || {}, academicYears: years.rows, terms: terms.rows });
}));

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(160), motto: optionalText(240), logoUrl: optionalText(500), faviconUrl: optionalText(500),
  address: optionalText(300), city: optionalText(100), country: optionalText(100), phone: optionalText(40),
  email: z.preprocess((value) => value === '' ? undefined : value, z.string().email().max(254).optional()),
  website: optionalText(500), principalName: optionalText(160), registrationInfo: optionalText(200),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()), timezone: z.string().trim().min(1).max(100),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  dateFormat: z.enum(['DD MMM YYYY','MM/DD/YYYY','YYYY-MM-DD']).optional(), timeFormat: z.enum(['12h','24h']).optional(), language: z.string().trim().min(2).max(20).optional(),
});

router.put('/settings', requirePermission('settings', 'edit'), asyncRoute(async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the school settings.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE schools SET name=$2,motto=$3,logo_url=$4,favicon_url=$5,address=$6,city=$7,country=$8,
       phone=$9,email=$10,website=$11,principal_name=$12,registration_info=$13,currency=$14,timezone=$15,
       primary_color=$16,secondary_color=$17,accent_color=$18,updated_at=now() WHERE id=$1`,
      [req.user.school_id,data.name,data.motto,data.logoUrl,data.faviconUrl,data.address,data.city,data.country,data.phone,data.email?.toLowerCase(),data.website,data.principalName,data.registrationInfo,data.currency,data.timezone,data.primaryColor,data.secondaryColor,data.accentColor],
    );
    await client.query(
      `UPDATE school_settings SET date_format=COALESCE($2,date_format),time_format=COALESCE($3,time_format),language=COALESCE($4,language),updated_at=now() WHERE school_id=$1`,
      [req.user.school_id,data.dateFormat,data.timeFormat,data.language],
    );
    await audit(client, req, { action: 'updated', entity: 'school_settings', entityId: req.user.school_id, metadata: { fields: Object.keys(data) } });
    await client.query('COMMIT');
    res.json({ success: true, school: { name: data.name, primaryColor: data.primaryColor, secondaryColor: data.secondaryColor, accentColor: data.accentColor } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.post('/academic/years', requirePermission('settings', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name:z.string().trim().min(3).max(40),startDate:z.string().date(),endDate:z.string().date(),isCurrent:z.boolean().optional().default(false) })
    .refine(value=>value.endDate>value.startDate,{path:['endDate'],message:'The end date must be after the start date.'}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the academic year details.'});
  const data=parsed.data;const client=await getPool().connect();
  try{await client.query('BEGIN');if(data.isCurrent){await client.query('UPDATE academic_years SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);await client.query('UPDATE terms SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);}
    const result=await client.query(`INSERT INTO academic_years (school_id,name,start_date,end_date,is_current) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[req.user.school_id,data.name,data.startDate,data.endDate,data.isCurrent]);
    await audit(client,req,{action:'created',entity:'academic_year',entityId:result.rows[0].id});await client.query('COMMIT');res.status(201).json({academicYear:result.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')return res.status(409).json({error:'An academic year with that name already exists.'});throw error;}finally{client.release();}
}));
router.post('/academic/years/:id/current',requirePermission('settings','edit'),asyncRoute(async(req,res)=>{
  const client=await getPool().connect();try{await client.query('BEGIN');const target=await client.query('SELECT id FROM academic_years WHERE id=$1 AND school_id=$2 AND archived_at IS NULL FOR UPDATE',[req.params.id,req.user.school_id]);if(!target.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Academic year not found.'});}
    await client.query('UPDATE academic_years SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);await client.query('UPDATE academic_years SET is_current=true,updated_at=now() WHERE id=$1 AND school_id=$2',[req.params.id,req.user.school_id]);await client.query('UPDATE terms SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);
    await audit(client,req,{action:'activated',entity:'academic_year',entityId:req.params.id});await client.query('COMMIT');res.json({success:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));
router.post('/academic/years/:id/terms',requirePermission('settings','edit'),asyncRoute(async(req,res)=>{
  const parsed=z.object({name:z.string().trim().min(2).max(40),startDate:z.string().date(),endDate:z.string().date(),isCurrent:z.boolean().optional().default(false)})
    .refine(value=>value.endDate>=value.startDate,{path:['endDate'],message:'The term end date must be on or after its start date.'}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the term details.'});const data=parsed.data;const client=await getPool().connect();
  try{await client.query('BEGIN');const year=await client.query('SELECT id,start_date,end_date,is_current FROM academic_years WHERE id=$1 AND school_id=$2 AND archived_at IS NULL FOR UPDATE',[req.params.id,req.user.school_id]);if(!year.rowCount)throw Object.assign(new Error('Academic year not found'),{status:404,publicMessage:'Academic year not found.'});
    if(data.isCurrent&&!year.rows[0].is_current)throw Object.assign(new Error('Term year is not current'),{status:400,publicMessage:'Activate this academic year before marking one of its terms current.'});
    if(data.startDate<String(year.rows[0].start_date).slice(0,10)||data.endDate>String(year.rows[0].end_date).slice(0,10))throw Object.assign(new Error('Term is outside year'),{status:400,publicMessage:'Term dates must fall within the academic year.'});
    if(data.isCurrent)await client.query('UPDATE terms SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);
    const term=await client.query('INSERT INTO terms (school_id,academic_year_id,name,start_date,end_date,is_current) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[req.user.school_id,req.params.id,data.name,data.startDate,data.endDate,data.isCurrent]);
    await audit(client,req,{action:'created',entity:'term',entityId:term.rows[0].id});await client.query('COMMIT');res.status(201).json({term:term.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')return res.status(409).json({error:'A term with that name already exists in this academic year.'});throw error;}finally{client.release();}
}));
router.post('/academic/terms/:id/current',requirePermission('settings','edit'),asyncRoute(async(req,res)=>{
  const client=await getPool().connect();try{await client.query('BEGIN');const target=await client.query(`SELECT t.id,t.academic_year_id,ay.is_current AS year_is_current FROM terms t
      JOIN academic_years ay ON ay.id=t.academic_year_id AND ay.school_id=t.school_id WHERE t.id=$1 AND t.school_id=$2 FOR UPDATE OF t,ay`,[req.params.id,req.user.school_id]);if(!target.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Term not found.'});}
    if(!target.rows[0].year_is_current){await client.query('ROLLBACK');return res.status(400).json({error:'Activate this academic year before setting one of its terms current.'});}
    await client.query('UPDATE terms SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true',[req.user.school_id]);await client.query('UPDATE terms SET is_current=true,updated_at=now() WHERE id=$1 AND school_id=$2',[req.params.id,req.user.school_id]);
    await audit(client,req,{action:'activated',entity:'term',entityId:req.params.id});await client.query('COMMIT');res.json({success:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));

router.get('/search', asyncRoute(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 100);
  if (term.length < 2) return res.json({ results: [] });
  const pattern = `%${term}%`;
  const results = [];
  if (req.user.roles.some((role) => ['school_admin','super_admin','principal','teacher','accountant'].includes(role))) {
    const teacherScope=req.user.roles.includes('teacher');const values=[req.user.school_id,pattern];let teacherFilter='';
    if(teacherScope){values.push(req.user.id);teacherFilter=`AND EXISTS(SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id WHERE ts.school_id=s.school_id AND t.user_id=$3 AND ts.class_id=s.current_class_id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id))`;}
    const students = await query(
      `SELECT s.id,s.student_id AS code,s.admission_number AS reference,
              concat_ws(' ',s.first_name,s.middle_name,s.last_name) AS label,c.name AS group_name,'student' AS kind
       FROM students s LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
       WHERE s.school_id=$1 AND s.archived_at IS NULL AND (s.first_name ILIKE $2 OR s.last_name ILIKE $2 OR s.student_id ILIKE $2 OR s.admission_number ILIKE $2 OR s.phone ILIKE $2)
         ${teacherFilter} ORDER BY s.last_name LIMIT 7`, values,
    );
    results.push(...students.rows);
  }
  if (req.user.roles.some((role) => ['school_admin','super_admin','principal'].includes(role))) {
    const staff = await query(
      `SELECT id,employee_id AS code,NULL::text AS reference,full_name AS label,designation AS group_name,'teacher' AS kind
       FROM teachers WHERE school_id=$1 AND archived_at IS NULL AND (full_name ILIKE $2 OR employee_id ILIKE $2 OR email ILIKE $2)
       UNION ALL
       SELECT id,employee_id,NULL::text,full_name,designation,'staff' FROM staff WHERE school_id=$1 AND archived_at IS NULL AND (full_name ILIKE $2 OR employee_id ILIKE $2 OR email ILIKE $2)
       LIMIT 7`, [req.user.school_id,pattern],
    );
    results.push(...staff.rows);
  }
  if (req.user.roles.some((role) => ['school_admin','super_admin','accountant'].includes(role))) {
    const invoices = await query(
      `SELECT i.id,i.invoice_number AS code,concat_ws(' ',s.first_name,s.last_name) AS label,
         i.status AS group_name,'invoice' AS kind FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND (i.invoice_number ILIKE $2 OR s.first_name ILIKE $2 OR s.last_name ILIKE $2) ORDER BY i.created_at DESC LIMIT 5`,
      [req.user.school_id,pattern],
    );
    results.push(...invoices.rows);
  }
  res.json({ results: results.slice(0, 15) });
}));

router.get('/notifications', requirePermission('dashboard', 'view'), asyncRoute(async (req, res) => {
  const rows = await query('SELECT id,category,title,body,link,read_at,created_at FROM notifications WHERE school_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 30', [req.user.school_id,req.user.id]);
  res.json({ data: rows.rows, unread: rows.rows.filter((row) => !row.read_at).length });
}));
router.post('/notifications/:id/read', requirePermission('dashboard', 'view'), asyncRoute(async (req, res) => {
  const result = await query('UPDATE notifications SET read_at=now() WHERE id=$1 AND school_id=$2 AND user_id=$3 RETURNING id', [req.params.id,req.user.school_id,req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ success: true });
}));

router.get('/reports/students',requirePermission('reports','view'),asyncRoute(async(req,res)=>{
  const teacherScope=req.user.roles.includes('teacher');const values=[req.user.school_id,teacherScope,req.user.id];
  const studentScope=`(NOT $2 OR EXISTS(SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id WHERE ts.school_id=s.school_id AND t.user_id=$3 AND ts.class_id=s.current_class_id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id)))`;
  const [summary,classes,gender,admissions]=await Promise.all([
    query(`SELECT count(*) FILTER(WHERE s.archived_at IS NULL AND s.status='active')::int AS active,
      count(*) FILTER(WHERE s.status='inactive')::int AS inactive,count(*) FILTER(WHERE s.status='graduated')::int AS graduated,
      count(*) FILTER(WHERE s.status='transferred')::int AS transferred,count(*) FILTER(WHERE s.status='withdrawn')::int AS withdrawn
      FROM students s WHERE s.school_id=$1 AND ${studentScope}`,values),
    query(`SELECT c.name,count(s.id)::int AS count FROM classes c LEFT JOIN students s ON s.current_class_id=c.id AND s.school_id=c.school_id AND s.archived_at IS NULL AND s.status='active'
      WHERE c.school_id=$1 AND c.archived_at IS NULL AND (NOT $2 OR EXISTS(SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id WHERE ts.school_id=c.school_id AND t.user_id=$3 AND ts.class_id=c.id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id)))
      GROUP BY c.id ORDER BY c.grade_level NULLS LAST,c.name`,values),
    query(`SELECT COALESCE(s.gender,'not_specified') AS gender,count(*)::int AS count FROM students s WHERE s.school_id=$1 AND s.archived_at IS NULL AND ${studentScope} GROUP BY s.gender ORDER BY count DESC`,values),
    query(`SELECT date_trunc('month',s.admission_date)::date AS month,count(*)::int AS count FROM students s WHERE s.school_id=$1 AND s.admission_date>=date_trunc('month',CURRENT_DATE)-INTERVAL '5 months' AND s.archived_at IS NULL AND ${studentScope} GROUP BY date_trunc('month',s.admission_date) ORDER BY month`,values),
  ]);
  res.json({summary:summary.rows[0],classes:classes.rows,gender:gender.rows,admissions:admissions.rows});
}));

router.get('/reports/finance.csv',requirePermission('finance','export'),asyncRoute(async(req,res)=>{
  const rows=await query(`SELECT p.receipt_number,i.invoice_number,concat_ws(' ',s.first_name,s.last_name) AS student_name,
    s.student_id AS student_code,p.payment_date,p.method,p.amount,p.reference,i.currency
    FROM payments p JOIN invoices i ON i.id=p.invoice_id AND i.school_id=p.school_id JOIN students s ON s.id=p.student_id AND s.school_id=p.school_id
    WHERE p.school_id=$1 ORDER BY p.payment_date DESC`,[req.user.school_id]);
  const headers=['Receipt number','Invoice number','Student','Student ID','Payment date','Method','Amount','Reference','Currency'];
  const csv=[headers,...rows.rows.map(row=>[row.receipt_number,row.invoice_number,row.student_name,row.student_code,row.payment_date,row.method,row.amount,row.reference,row.currency])]
    .map(line=>line.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="finance-payments.csv"');res.send(`\uFEFF${csv}`);
}));

router.get('/reports/students.csv', requirePermission('students', 'export'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT s.student_id,s.admission_number,s.first_name,s.middle_name,s.last_name,s.gender,s.email,s.phone,s.status,s.admission_date,
            c.name AS class_name,sec.name AS section_name
     FROM students s LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
     LEFT JOIN sections sec ON sec.id=s.current_section_id AND sec.school_id=s.school_id
     WHERE s.school_id=$1 AND s.archived_at IS NULL ORDER BY s.last_name,s.first_name`, [req.user.school_id],
  );
  const headers = ['Student ID','Admission number','First name','Middle name','Last name','Gender','Email','Phone','Status','Admission date','Class','Section'];
  const csv = [headers, ...rows.rows.map((row) => [row.student_id,row.admission_number,row.first_name,row.middle_name,row.last_name,row.gender,row.email,row.phone,row.status,row.admission_date,row.class_name,row.section_name])]
    .map((line) => line.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="students-report.csv"');
  res.send(`\uFEFF${csv}`);
}));

router.get('/reports/finance', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const [summary, byMethod, overdue] = await Promise.all([
    query(`SELECT
              (SELECT COALESCE(sum(amount),0) FROM payments WHERE school_id=$1)::numeric AS received,
              (SELECT COALESCE(sum(amount),0) FROM payments WHERE school_id=$1 AND payment_date >= date_trunc('month',now()))::numeric AS this_month,
              (SELECT COALESCE(sum(total-paid),0) FROM invoices WHERE school_id=$1 AND status NOT IN ('paid','void','draft'))::numeric AS outstanding`, [req.user.school_id]),
    query(`SELECT method,sum(amount)::numeric AS total,count(*)::int AS count FROM payments WHERE school_id=$1 GROUP BY method ORDER BY total DESC`, [req.user.school_id]),
    query(`SELECT i.invoice_number,concat_ws(' ',s.first_name,s.last_name) AS student_name,i.due_date,i.total,i.paid,i.total-i.paid AS balance
           FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
           WHERE i.school_id=$1 AND i.status<>'void' AND i.due_date<CURRENT_DATE AND i.paid<i.total ORDER BY i.due_date LIMIT 100`, [req.user.school_id]),
  ]);
  res.json({ summary: summary.rows[0], byMethod: byMethod.rows, overdue: overdue.rows });
}));

router.get('/audit', requirePermission('audit', 'view'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT a.id,a.action,a.entity,a.entity_id,a.metadata,a.created_at,u.full_name AS user_name,u.email
     FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id AND u.school_id=a.school_id
     WHERE a.school_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [req.user.school_id],
  );
  res.json({ data: rows.rows });
}));

function formatSchool(row) {
  return {
    id: row.id, name: row.name, motto: row.motto, logoUrl: row.logo_url, faviconUrl: row.favicon_url,
    address: row.address, city: row.city, country: row.country, phone: row.phone, email: row.email,
    website: row.website, principalName: row.principal_name, registrationInfo: row.registration_info,
    currency: row.currency, timezone: row.timezone, primaryColor: row.primary_color,
    secondaryColor: row.secondary_color, accentColor: row.accent_color, settings: row.settings,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

export default router;
