import { Router } from 'express';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText } from '../http.js';
import { requirePermission } from '../access.js';

const router = Router();
const uuid = z.string().uuid();
const dateValue = z.string().date();
const timeValue = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);

router.get('/attendance', requirePermission('attendance', 'view'), asyncRoute(async (req, res) => {
  const date = dateValue.safeParse(req.query.date || new Date().toISOString().slice(0,10));
  const classId = uuid.safeParse(req.query.classId);
  const sectionId = req.query.sectionId ? uuid.safeParse(req.query.sectionId) : null;
  if (!date.success || (req.query.classId && !classId.success) || (sectionId && !sectionId.success)) {
    return res.status(400).json({ error: 'Choose a valid date, class, and section.' });
  }
  if (!req.query.classId) return res.json({ date: date.data, classId: null, students: [] });
  const values = [req.user.school_id, classId.data, date.data];
  let sectionFilter = '';
  if (sectionId?.success) { values.push(sectionId.data); sectionFilter = `AND s.current_section_id=$${values.length}`; }
  let teacherFilter = '';
  if (req.user.roles.includes('teacher')) {
    values.push(req.user.id);
    teacherFilter = `AND EXISTS (
      SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
      WHERE ts.school_id=s.school_id AND t.user_id=$${values.length} AND ts.class_id=s.current_class_id
        AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id)
    )`;
  }
  const result = await query(
    `SELECT s.id,s.student_id,s.admission_number,s.roll_number,s.first_name,s.middle_name,s.last_name,
            s.photo_url,a.status AS attendance_status,a.note AS attendance_note
     FROM students s LEFT JOIN attendance a ON a.student_id=s.id AND a.school_id=s.school_id AND a.attendance_date=$3::date AND a.subject_id IS NULL
     WHERE s.school_id=$1 AND s.current_class_id=$2 AND s.status='active' AND s.archived_at IS NULL
       ${sectionFilter} ${teacherFilter}
     ORDER BY s.roll_number NULLS LAST,s.last_name,s.first_name`, values,
  );
  res.json({ date: date.data, classId: classId.data, sectionId: sectionId?.success ? sectionId.data : null, students: result.rows });
}));

const attendanceBulkSchema = z.object({
  date: dateValue,
  classId: uuid,
  sectionId: uuid.nullable().optional(),
  records: z.array(z.object({
    studentId: uuid,
    status: z.enum(['present','absent','late','excused']),
    note: optionalText(500),
  })).min(1).max(300),
}).refine((value) => new Set(value.records.map((record) => record.studentId)).size === value.records.length, {
  path: ['records'], message: 'Each student can only be marked once for the selected date.',
});

router.post('/attendance/bulk', requirePermission('attendance', 'create'), asyncRoute(async (req, res) => {
  const parsed = attendanceBulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the attendance entries.' });
  const { date, classId, sectionId, records } = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const classResult = await client.query('SELECT id FROM classes WHERE id=$1 AND school_id=$2 AND archived_at IS NULL', [classId,req.user.school_id]);
    if (!classResult.rowCount) throw Object.assign(new Error('Invalid class'), { status: 400, publicMessage: 'The selected class could not be found.' });
    if (sectionId) {
      const section = await client.query('SELECT id FROM sections WHERE id=$1 AND class_id=$2 AND school_id=$3 AND archived_at IS NULL', [sectionId,classId,req.user.school_id]);
      if (!section.rowCount) throw Object.assign(new Error('Invalid section'), { status: 400, publicMessage: 'The selected section does not belong to this class.' });
    }
    if (req.user.roles.includes('teacher')) {
      const assigned = await client.query(
        `SELECT EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
         WHERE ts.school_id=$1 AND t.user_id=$2 AND ts.class_id=$3 AND (ts.section_id IS NULL OR ts.section_id IS NOT DISTINCT FROM $4::uuid)) AS allowed`,
        [req.user.school_id,req.user.id,classId,sectionId || null],
      );
      if (!assigned.rows[0].allowed) throw Object.assign(new Error('Not assigned to this class'), { status: 403, publicMessage: 'You can only mark attendance for your assigned classes.' });
    }
    const roster = await client.query(
      `SELECT id FROM students WHERE school_id=$1 AND current_class_id=$2 AND status='active' AND archived_at IS NULL
         AND ($3::uuid IS NULL OR current_section_id=$3)`,
      [req.user.school_id,classId,sectionId || null],
    );
    const valid = new Set(roster.rows.map((row) => row.id));
    if (records.some((record) => !valid.has(record.studentId))) {
      throw Object.assign(new Error('Student is not in selected roster'), { status: 400, publicMessage: 'One or more selected students are not enrolled in this class or section.' });
    }
    for (const record of records) {
      await client.query(
        `INSERT INTO attendance (school_id,student_id,class_id,section_id,attendance_date,status,note,recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [req.user.school_id,record.studentId,classId,sectionId || null,date,record.status,record.note,req.user.id],
      );
      await client.query(
        `UPDATE attendance SET status=$1,note=$2,recorded_by=$3,updated_at=now()
         WHERE school_id=$4 AND student_id=$5 AND attendance_date=$6 AND subject_id IS NULL`,
        [record.status,record.note,req.user.id,req.user.school_id,record.studentId,date],
      );
    }
    await audit(client, req, { action: 'bulk_marked', entity: 'attendance', metadata: { date, classId, sectionId, count: records.length } });
    await client.query('COMMIT');
    res.json({ success: true, saved: records.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.get('/attendance/summary', requirePermission('attendance', 'view'), asyncRoute(async (req, res) => {
  const from = dateValue.safeParse(req.query.from || new Date(Date.now()-29*86400000).toISOString().slice(0,10));
  const to = dateValue.safeParse(req.query.to || new Date().toISOString().slice(0,10));
  if (!from.success || !to.success || from.data > to.data) return res.status(400).json({ error: 'Choose a valid attendance date range.' });
  const teacherScope = req.user.roles.includes('teacher');
  const [daily, students] = await Promise.all([
    query(`SELECT a.attendance_date,count(*)::int AS total,count(*) FILTER(WHERE a.status='present')::int AS present,
            count(*) FILTER(WHERE a.status='absent')::int AS absent,count(*) FILTER(WHERE a.status='late')::int AS late,
            count(*) FILTER(WHERE a.status='excused')::int AS excused
           FROM attendance a WHERE a.school_id=$1 AND a.attendance_date BETWEEN $2 AND $3
             AND (NOT $4 OR EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
               WHERE ts.school_id=a.school_id AND t.user_id=$5 AND ts.class_id=a.class_id AND (ts.section_id IS NULL OR ts.section_id IS NOT DISTINCT FROM a.section_id)))
           GROUP BY a.attendance_date ORDER BY a.attendance_date`, [req.user.school_id,from.data,to.data,teacherScope,req.user.id]),
    query(`SELECT s.student_id,concat_ws(' ',s.first_name,s.last_name) AS student_name,c.name AS class_name,
            count(a.id)::int AS recorded_days,count(*) FILTER(WHERE a.status IN ('present','late'))::int AS attended_days,
            CASE WHEN count(a.id)=0 THEN 0 ELSE round(count(*) FILTER(WHERE a.status IN ('present','late'))::numeric*100/count(a.id),1) END AS percentage
           FROM students s LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
           LEFT JOIN attendance a ON a.student_id=s.id AND a.school_id=s.school_id AND a.attendance_date BETWEEN $2 AND $3
           WHERE s.school_id=$1 AND s.status='active' AND s.archived_at IS NULL
             AND (NOT $4 OR EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
               WHERE ts.school_id=s.school_id AND t.user_id=$5 AND ts.class_id=s.current_class_id AND (ts.section_id IS NULL OR ts.section_id=s.current_section_id)))
           GROUP BY s.id,c.name ORDER BY percentage,student_name LIMIT 100`, [req.user.school_id,from.data,to.data,teacherScope,req.user.id]),
  ]);
  res.json({ from: from.data, to: to.data, daily: daily.rows, students: students.rows });
}));

router.get('/timetable', requirePermission('classes', 'view'), asyncRoute(async (req, res) => {
  const values = [req.user.school_id];
  const filters = [];
  if (req.query.classId && uuid.safeParse(req.query.classId).success) { values.push(req.query.classId); filters.push(`te.class_id=$${values.length}`); }
  if (req.query.teacherId && uuid.safeParse(req.query.teacherId).success && !req.user.roles.includes('teacher')) { values.push(req.query.teacherId); filters.push(`te.teacher_id=$${values.length}`); }
  if (req.user.roles.includes('teacher')) { values.push(req.user.id); filters.push(`te.teacher_id=(SELECT id FROM teachers WHERE user_id=$${values.length} AND school_id=te.school_id)`); }
  if (req.user.roles.includes('student')) {
    values.push(req.user.id);
    filters.push(`te.class_id=(SELECT current_class_id FROM students WHERE user_id=$${values.length} AND school_id=te.school_id)
      AND (te.section_id IS NULL OR te.section_id=(SELECT current_section_id FROM students WHERE user_id=$${values.length} AND school_id=te.school_id))`);
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const result = await query(
    `SELECT te.id,te.academic_year_id,te.class_id,te.section_id,te.subject_id,te.teacher_id,te.day_of_week,
            te.start_time,te.end_time,te.room,c.name AS class_name,sec.name AS section_name,
            su.name AS subject_name,t.full_name AS teacher_name
     FROM timetable_entries te JOIN classes c ON c.id=te.class_id AND c.school_id=te.school_id
     LEFT JOIN sections sec ON sec.id=te.section_id AND sec.school_id=te.school_id
     JOIN subjects su ON su.id=te.subject_id AND su.school_id=te.school_id
     JOIN teachers t ON t.id=te.teacher_id AND t.school_id=te.school_id
     WHERE te.school_id=$1 AND te.academic_year_id=(SELECT id FROM academic_years WHERE school_id=$1 AND is_current=true) ${where}
     ORDER BY te.day_of_week,te.start_time`, values,
  );
  res.json({ data: result.rows });
}));

const timetableSchema = z.object({
  academicYearId: uuid,
  classId: uuid,
  sectionId: uuid.nullable().optional(),
  subjectId: uuid,
  teacherId: uuid,
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  startTime: timeValue,
  endTime: timeValue,
  room: optionalText(80),
}).refine((value) => value.startTime < value.endTime, { path: ['endTime'], message: 'End time must be after start time.' });

router.post('/timetable', requirePermission('classes', 'create'), asyncRoute(async (req, res) => {
  const parsed = timetableSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the timetable entry.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['timetable',req.user.school_id]);
    const conflict = await client.query(
      `SELECT
         EXISTS(SELECT 1 FROM timetable_entries WHERE school_id=$1 AND academic_year_id=$2 AND day_of_week=$3
           AND teacher_id=$4 AND start_time<$6 AND end_time>$5) AS teacher_conflict,
         EXISTS(SELECT 1 FROM timetable_entries WHERE school_id=$1 AND academic_year_id=$2 AND day_of_week=$3
           AND class_id=$7 AND (section_id IS NULL OR $8::uuid IS NULL OR section_id=$8)
           AND start_time<$6 AND end_time>$5) AS class_conflict,
         EXISTS(SELECT 1 FROM timetable_entries WHERE school_id=$1 AND academic_year_id=$2 AND day_of_week=$3
           AND room IS NOT NULL AND room=$9 AND start_time<$6 AND end_time>$5) AS room_conflict`,
      [req.user.school_id,data.academicYearId,data.dayOfWeek,data.teacherId,data.startTime,data.endTime,data.classId,data.sectionId || null,data.room || null],
    );
    const existing = conflict.rows[0];
    if (existing.teacher_conflict) throw Object.assign(new Error('Teacher schedule conflict'), { status: 409, publicMessage: 'This teacher already has a class scheduled during that time.' });
    if (existing.class_conflict) throw Object.assign(new Error('Class schedule conflict'), { status: 409, publicMessage: 'This class or section already has a lesson scheduled during that time.' });
    if (data.room && existing.room_conflict) throw Object.assign(new Error('Room schedule conflict'), { status: 409, publicMessage: 'This room is already booked during that time.' });
    const created = await client.query(
      `INSERT INTO timetable_entries (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,day_of_week,start_time,end_time,room)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.school_id,data.academicYearId,data.classId,data.sectionId || null,data.subjectId,data.teacherId,data.dayOfWeek,data.startTime,data.endTime,data.room],
    );
    await audit(client, req, { action: 'created', entity: 'timetable_entry', entityId: created.rows[0].id });
    await client.query('COMMIT');
    res.status(201).json({ timetableEntry: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.delete('/timetable/:id', requirePermission('classes', 'delete'), asyncRoute(async (req, res) => {
  const result = await query('DELETE FROM timetable_entries WHERE id=$1 AND school_id=$2 RETURNING id', [req.params.id,req.user.school_id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Timetable item not found.' });
  await audit(getPool(), req, { action: 'deleted', entity: 'timetable_entry', entityId: req.params.id });
  res.json({ success: true });
}));

router.get('/exams', requirePermission('exams', 'view'), asyncRoute(async (req, res) => {
  const values = [req.user.school_id];
  let studentFilter = '';
  let teacherFilter = '';
  if (req.user.roles.includes('student')) {
    values.push(req.user.id);
    studentFilter = `AND EXISTS (SELECT 1 FROM students s WHERE s.user_id=$${values.length} AND s.school_id=e.school_id AND s.current_class_id=es.class_id)`;
  } else if (req.user.roles.includes('teacher')) {
    values.push(req.user.id);
    teacherFilter = `AND EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
      WHERE ts.school_id=e.school_id AND t.user_id=$${values.length} AND ts.class_id=es.class_id AND ts.subject_id=es.subject_id)`;
  }
  const result = await query(
    `SELECT e.id,e.name,e.exam_type,e.start_date,e.end_date,e.status,e.description,
            ay.name AS academic_year_name,term.name AS term_name,
            COALESCE(json_agg(json_build_object('id',es.id,'classId',es.class_id,'className',c.name,'subjectId',es.subject_id,
               'subjectName',su.name,'examDate',es.exam_date,'startTime',es.start_time,'endTime',es.end_time,'room',es.room,
               'maximumMarks',es.maximum_marks,'passingMarks',es.passing_marks,'resultsPublishedAt',es.results_published_at,
               'resultCount',(SELECT count(*)::int FROM results r WHERE r.exam_subject_id=es.id AND r.school_id=es.school_id)) ORDER BY es.exam_date,su.name)
              FILTER (WHERE es.id IS NOT NULL), '[]') AS subjects
     FROM exams e JOIN academic_years ay ON ay.id=e.academic_year_id AND ay.school_id=e.school_id
     LEFT JOIN terms term ON term.id=e.term_id AND term.school_id=e.school_id
     LEFT JOIN exam_subjects es ON es.exam_id=e.id AND es.school_id=e.school_id
     LEFT JOIN classes c ON c.id=es.class_id AND c.school_id=es.school_id
     LEFT JOIN subjects su ON su.id=es.subject_id AND su.school_id=es.school_id
     WHERE e.school_id=$1 ${studentFilter} ${teacherFilter}
     GROUP BY e.id,ay.name,term.name ORDER BY e.start_date DESC NULLS LAST,e.created_at DESC LIMIT 100`, values,
  );
  res.json({ data: result.rows });
}));

const examSchema = z.object({
  name: z.string().trim().min(2).max(160),
  examType: z.enum(['midterm','final','monthly_test','quiz','practical','custom']).default('custom'),
  academicYearId: uuid,
  termId: uuid.nullable().optional(),
  startDate: dateValue.nullable().optional(),
  endDate: dateValue.nullable().optional(),
  description: optionalText(1000),
  subjects: z.array(z.object({
    classId: uuid, subjectId: uuid, examDate: dateValue.nullable().optional(),
    startTime: timeValue.nullable().optional(), endTime: timeValue.nullable().optional(), room: optionalText(80),
    maximumMarks: z.coerce.number().positive().max(100000).default(100),
    passingMarks: z.coerce.number().nonnegative().max(100000).default(40),
  }).refine((item) => item.passingMarks <= item.maximumMarks, { path: ['passingMarks'], message: 'Passing marks cannot exceed the maximum marks.' }))
    .min(1).max(100),
}).refine((value) => !value.startDate || !value.endDate || value.endDate >= value.startDate, { path: ['endDate'], message: 'End date must be after the start date.' });

router.post('/exams', requirePermission('exams', 'create'), asyncRoute(async (req, res) => {
  const parsed = examSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the exam details.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const exam = await client.query(
      `INSERT INTO exams (school_id,academic_year_id,term_id,name,exam_type,start_date,end_date,status,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9) RETURNING id`,
      [req.user.school_id,data.academicYearId,data.termId || null,data.name,data.examType,data.startDate || null,data.endDate || null,data.description,req.user.id],
    );
    for (const subject of data.subjects) {
      const assigned = await client.query(
        `SELECT EXISTS(SELECT 1 FROM class_subjects WHERE school_id=$1 AND class_id=$2 AND subject_id=$3
          AND (academic_year_id IS NULL OR academic_year_id=$4)) AS allowed`,
        [req.user.school_id,subject.classId,subject.subjectId,data.academicYearId],
      );
      if (!assigned.rows[0].allowed) throw Object.assign(new Error('Subject not assigned'), { status: 400, publicMessage: 'Each exam subject must be assigned to its selected class.' });
      if (req.user.roles.includes('teacher')) {
        const teacher = await client.query(`SELECT id FROM teachers WHERE user_id=$1 AND school_id=$2`, [req.user.id,req.user.school_id]);
        const allowed = teacher.rowCount ? await client.query(
          `SELECT id FROM teacher_subjects WHERE school_id=$1 AND teacher_id=$2 AND class_id=$3 AND subject_id=$4`,
          [req.user.school_id,teacher.rows[0].id,subject.classId,subject.subjectId],
        ) : { rowCount: 0 };
        if (!allowed.rowCount) throw Object.assign(new Error('Teacher assignment not found'), { status: 403, publicMessage: 'You can only schedule exams for your assigned subjects and classes.' });
      }
      await client.query(
        `INSERT INTO exam_subjects (school_id,exam_id,class_id,subject_id,exam_date,start_time,end_time,room,maximum_marks,passing_marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.user.school_id,exam.rows[0].id,subject.classId,subject.subjectId,subject.examDate || data.startDate || null,subject.startTime || null,subject.endTime || null,subject.room,subject.maximumMarks,subject.passingMarks],
      );
    }
    await audit(client, req, { action: 'created', entity: 'exam', entityId: exam.rows[0].id, metadata: { name: data.name, subjects: data.subjects.length } });
    await client.query('COMMIT');
    res.status(201).json({ id: exam.rows[0].id, success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'This exam already has that class and subject scheduled.' });
    throw error;
  } finally { client.release(); }
}));

router.get('/exams/:examSubjectId/results', requirePermission('exams', 'view'), asyncRoute(async (req, res) => {
  const details = await query(
    `SELECT es.id,es.class_id,es.subject_id,es.maximum_marks,es.passing_marks,es.results_published_at,e.name AS exam_name,su.name AS subject_name,c.name AS class_name
     FROM exam_subjects es JOIN exams e ON e.id=es.exam_id AND e.school_id=es.school_id
     JOIN subjects su ON su.id=es.subject_id AND su.school_id=es.school_id JOIN classes c ON c.id=es.class_id AND c.school_id=es.school_id
     WHERE es.id=$1 AND es.school_id=$2`, [req.params.examSubjectId,req.user.school_id],
  );
  if (!details.rowCount) return res.status(404).json({ error: 'Exam subject not found.' });
  const exam = details.rows[0];
  let ownStudentId = null;
  if (req.user.roles.includes('student')) {
    const student = await query('SELECT id,current_section_id FROM students WHERE user_id=$1 AND school_id=$2 AND current_class_id=$3 AND archived_at IS NULL', [req.user.id,req.user.school_id,exam.class_id]);
    if (!student.rowCount) return res.status(403).json({ error: 'You can only view your own results.' });
    ownStudentId = student.rows[0].id;
    if(!exam.results_published_at)return res.json({exam,data:[],published:false});
  }
  if (req.user.roles.includes('teacher')) {
    const assigned = await query(`SELECT EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
      WHERE ts.school_id=$1 AND t.user_id=$2 AND ts.class_id=$3 AND ts.subject_id=$4) AS allowed`,
      [req.user.school_id,req.user.id,exam.class_id,exam.subject_id]);
    if (!assigned.rows[0].allowed) return res.status(403).json({error:'You can only view results for your assigned classes and subjects.'});
  }
  const rows = await query(
    `SELECT s.id AS student_id,s.student_id AS student_code,s.roll_number,concat_ws(' ',s.first_name,s.last_name) AS student_name,
            r.marks_obtained,r.grade,r.gpa,r.remarks
     FROM students s LEFT JOIN results r ON r.student_id=s.id AND r.school_id=s.school_id AND r.exam_subject_id=$3
     WHERE s.school_id=$1 AND s.current_class_id=$2 AND s.status='active' AND s.archived_at IS NULL
       AND ($4::uuid IS NULL OR s.id=$4)
     ORDER BY s.roll_number NULLS LAST,s.last_name,s.first_name`,
    [req.user.school_id,exam.class_id,req.params.examSubjectId,ownStudentId],
  );
  res.json({ exam, data: rows.rows });
}));

router.post('/exams/:examSubjectId/publish-results', requirePermission('exams', 'approve'), asyncRoute(async (req, res) => {
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');
    const subject=await client.query(`SELECT es.id,e.name AS exam_name,s.name AS subject_name,es.results_published_at
      FROM exam_subjects es JOIN exams e ON e.id=es.exam_id AND e.school_id=es.school_id JOIN subjects s ON s.id=es.subject_id AND s.school_id=es.school_id
      WHERE es.id=$1 AND es.school_id=$2 FOR UPDATE OF es`,[req.params.examSubjectId,req.user.school_id]);
    if(!subject.rowCount)throw Object.assign(new Error('Exam subject not found'),{status:404,publicMessage:'Exam subject not found.'});
    const count=await client.query('SELECT count(*)::int AS total FROM results WHERE exam_subject_id=$1 AND school_id=$2',[req.params.examSubjectId,req.user.school_id]);
    if(!count.rows[0].total)throw Object.assign(new Error('No marks entered'),{status:409,publicMessage:'Enter and review marks before publishing results.'});
    await client.query('UPDATE exam_subjects SET results_published_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2',[req.params.examSubjectId,req.user.school_id]);
    await audit(client,req,{action:'published',entity:'exam_results',entityId:req.params.examSubjectId,metadata:{exam:subject.rows[0].exam_name,subject:subject.rows[0].subject_name,results:count.rows[0].total}});
    await client.query('COMMIT');res.json({success:true,publishedAt:new Date().toISOString(),count:count.rows[0].total});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));

router.put('/exams/:examSubjectId/results', requirePermission('exams', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ results: z.array(z.object({ studentId: uuid, marks: z.coerce.number().nonnegative(), remarks: optionalText(500) })).min(1).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter valid marks for the selected students.' });
  if (new Set(parsed.data.results.map((row) => row.studentId)).size !== parsed.data.results.length) return res.status(400).json({ error: 'Each student can only have one mark for this subject.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const subject = await client.query('SELECT class_id,maximum_marks FROM exam_subjects WHERE id=$1 AND school_id=$2', [req.params.examSubjectId,req.user.school_id]);
    if (!subject.rowCount) throw Object.assign(new Error('Exam subject not found'), { status: 404, publicMessage: 'Exam subject not found.' });
    const classId = subject.rows[0].class_id;
    if (req.user.roles.includes('teacher')) {
      const assigned = await client.query(
        `SELECT EXISTS(SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
         JOIN exam_subjects es ON es.id=$3 AND es.school_id=ts.school_id
         WHERE ts.school_id=$1 AND t.user_id=$2 AND ts.class_id=es.class_id AND ts.subject_id=es.subject_id) AS allowed`,
        [req.user.school_id,req.user.id,req.params.examSubjectId],
      );
      if (!assigned.rows[0].allowed) throw Object.assign(new Error('Not assigned'), { status: 403, publicMessage: 'You can only enter marks for your assigned subjects.' });
    }
    const roster = await client.query(`SELECT id FROM students WHERE school_id=$1 AND current_class_id=$2 AND status='active' AND archived_at IS NULL`, [req.user.school_id,classId]);
    const rosterIds = new Set(roster.rows.map((row) => row.id));
    if (parsed.data.results.some((row) => !rosterIds.has(row.studentId))) throw Object.assign(new Error('Student not enrolled'), { status: 400, publicMessage: 'One or more students are not enrolled in this class.' });
    for (const item of parsed.data.results) {
      if (item.marks > Number(subject.rows[0].maximum_marks)) throw Object.assign(new Error('Marks exceed maximum'), { status: 400, publicMessage: `Marks cannot exceed ${subject.rows[0].maximum_marks}.` });
      const percent = item.marks / Number(subject.rows[0].maximum_marks) * 100;
      const scale = await client.query(`SELECT grade,gpa FROM grade_scales WHERE school_id=$1 AND min_percentage <= $2 AND max_percentage >= $2 ORDER BY min_percentage DESC LIMIT 1`, [req.user.school_id,percent]);
      const grade = scale.rows[0]?.grade || gradeFor(percent);
      const gpa = scale.rows[0]?.gpa ?? null;
      await client.query(
        `INSERT INTO results (school_id,exam_subject_id,student_id,marks_obtained,grade,gpa,remarks,entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (exam_subject_id,student_id) DO UPDATE
         SET marks_obtained=EXCLUDED.marks_obtained,grade=EXCLUDED.grade,gpa=EXCLUDED.gpa,remarks=EXCLUDED.remarks,entered_by=EXCLUDED.entered_by,updated_at=now()`,
        [req.user.school_id,req.params.examSubjectId,item.studentId,item.marks,grade,gpa,item.remarks,req.user.id],
      );
    }
    await client.query('UPDATE exam_subjects SET results_published_at=NULL,updated_at=now() WHERE id=$1 AND school_id=$2',[req.params.examSubjectId,req.user.school_id]);
    await audit(client, req, { action: 'marks_updated', entity: 'exam_subject', entityId: req.params.examSubjectId, metadata: { students: parsed.data.results.length } });
    await client.query('COMMIT');
    res.json({ success: true, saved: parsed.data.results.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.get('/assignments', requirePermission('assignments', 'view'), asyncRoute(async (req, res) => {
  const values = [req.user.school_id];
  let filter = '';
  let studentSubmissionStatus = 'NULL::text';
  if (req.user.roles.includes('student')) {
    values.push(req.user.id);
    studentSubmissionStatus = `(SELECT own_submission.status FROM assignment_submissions own_submission
      JOIN students own_student ON own_student.id=own_submission.student_id AND own_student.school_id=own_submission.school_id
      WHERE own_submission.assignment_id=a.id AND own_submission.school_id=a.school_id AND own_student.user_id=$${values.length} LIMIT 1)`;
    filter = `AND a.class_id=(SELECT current_class_id FROM students WHERE user_id=$${values.length} AND school_id=a.school_id)
      AND (a.section_id IS NULL OR a.section_id=(SELECT current_section_id FROM students WHERE user_id=$${values.length} AND school_id=a.school_id))`;
  } else if (req.user.roles.includes('teacher')) {
    values.push(req.user.id);
    filter = `AND a.teacher_id=(SELECT id FROM teachers WHERE user_id=$${values.length} AND school_id=a.school_id)`;
  }
  const result = await query(
    `SELECT a.id,a.title,a.description,a.due_at,a.status,a.attachment_url,a.class_id,a.section_id,a.subject_id,
            c.name AS class_name,sec.name AS section_name,su.name AS subject_name,t.full_name AS teacher_name,
            ${studentSubmissionStatus} AS student_submission_status,count(sub.id)::int AS submissions
     FROM assignments a JOIN classes c ON c.id=a.class_id AND c.school_id=a.school_id
     LEFT JOIN sections sec ON sec.id=a.section_id AND sec.school_id=a.school_id JOIN subjects su ON su.id=a.subject_id AND su.school_id=a.school_id
     LEFT JOIN teachers t ON t.id=a.teacher_id AND t.school_id=a.school_id
     LEFT JOIN assignment_submissions sub ON sub.assignment_id=a.id AND sub.school_id=a.school_id
     WHERE a.school_id=$1 AND a.status='published' ${filter}
     GROUP BY a.id,c.name,sec.name,su.name,t.full_name ORDER BY a.due_at NULLS LAST,a.created_at DESC LIMIT 100`, values,
  );
  res.json({ data: result.rows });
}));

const assignmentSchema = z.object({
  title: z.string().trim().min(2).max(180), description: optionalText(2000), classId: uuid,
  sectionId: uuid.nullable().optional(), subjectId: uuid, dueAt: z.string().datetime().nullable().optional(),
  attachmentUrl: optionalText(500), academicYearId: uuid,
});
router.post('/assignments', requirePermission('assignments', 'create'), asyncRoute(async (req, res) => {
  if (req.user.roles.includes('student')) return res.status(403).json({ error: 'Students may submit assigned work but cannot create assignments.' });
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the assignment details.' });
  const data = parsed.data;
  const teacher = await query('SELECT id FROM teachers WHERE user_id=$1 AND school_id=$2', [req.user.id,req.user.school_id]);
  if (req.user.roles.includes('teacher') && !teacher.rowCount) return res.status(403).json({ error: 'Your teacher profile is not linked to this account.' });
  if (req.user.roles.includes('teacher')) {
    const assigned = await query('SELECT id FROM teacher_subjects WHERE school_id=$1 AND teacher_id=$2 AND class_id=$3 AND subject_id=$4 AND (section_id IS NULL OR section_id IS NOT DISTINCT FROM $5::uuid)', [req.user.school_id,teacher.rows[0].id,data.classId,data.subjectId,data.sectionId || null]);
    if (!assigned.rowCount) return res.status(403).json({ error: 'You can only create assignments for your assigned classes and subjects.' });
  }
  const result = await query(
    `INSERT INTO assignments (school_id,title,description,teacher_id,class_id,section_id,subject_id,academic_year_id,due_at,attachment_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user.school_id,data.title,data.description,teacher.rows[0]?.id || null,data.classId,data.sectionId || null,data.subjectId,data.academicYearId,data.dueAt || null,data.attachmentUrl],
  );
  await audit(getPool(), req, { action: 'created', entity: 'assignment', entityId: result.rows[0].id });
  res.status(201).json({ assignment: result.rows[0] });
}));

router.post('/assignments/:id/submit', requirePermission('assignments', 'create'), asyncRoute(async (req, res) => {
  if (!req.user.roles.includes('student')) return res.status(403).json({ error: 'Only students can submit assignments here.' });
  const parsed = z.object({ submissionUrl: z.string().trim().min(1).max(500), comments: optionalText(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Add a submission link or file before submitting.' });
  const student = await query('SELECT id,current_class_id,current_section_id FROM students WHERE user_id=$1 AND school_id=$2 AND archived_at IS NULL', [req.user.id,req.user.school_id]);
  if (!student.rowCount) return res.status(403).json({ error: 'Your student profile is not linked to this account.' });
  const assignment = await query('SELECT id,due_at,class_id,section_id FROM assignments WHERE id=$1 AND school_id=$2 AND status=\'published\'', [req.params.id,req.user.school_id]);
  if (!assignment.rowCount || assignment.rows[0].class_id !== student.rows[0].current_class_id || (assignment.rows[0].section_id && assignment.rows[0].section_id !== student.rows[0].current_section_id)) return res.status(404).json({ error: 'Assignment not found for your class.' });
  const status = assignment.rows[0].due_at && new Date(assignment.rows[0].due_at) < new Date() ? 'late' : 'submitted';
  const result = await query(
    `INSERT INTO assignment_submissions (school_id,assignment_id,student_id,submitted_at,submission_url,comments,status)
     VALUES ($1,$2,$3,now(),$4,$5,$6) ON CONFLICT (assignment_id,student_id) DO UPDATE
     SET submitted_at=now(),submission_url=EXCLUDED.submission_url,comments=EXCLUDED.comments,status=EXCLUDED.status,updated_at=now()
     RETURNING id,status,submitted_at`,
    [req.user.school_id,req.params.id,student.rows[0].id,parsed.data.submissionUrl,parsed.data.comments,status],
  );
  res.json({ submission: result.rows[0] });
}));

router.get('/study-materials', requirePermission('study_materials', 'view'), asyncRoute(async (req, res) => {
  const values = [req.user.school_id];
  let filter = '';
  if (req.user.roles.includes('student')) {
    values.push(req.user.id);
    filter = `AND (m.class_id IS NULL OR m.class_id=(SELECT current_class_id FROM students WHERE user_id=$${values.length} AND school_id=m.school_id))`;
  } else if (req.user.roles.includes('teacher')) {
    values.push(req.user.id);
    filter = `AND (m.class_id IS NULL OR EXISTS(SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id WHERE t.user_id=$${values.length} AND ts.school_id=m.school_id AND ts.class_id=m.class_id))`;
  }
  const rows = await query(`SELECT m.id,m.title,m.description,m.material_type,m.resource_url,m.created_at,c.name AS class_name,s.name AS subject_name,u.full_name AS uploaded_by
     FROM study_materials m LEFT JOIN classes c ON c.id=m.class_id AND c.school_id=m.school_id
     LEFT JOIN subjects s ON s.id=m.subject_id AND s.school_id=m.school_id LEFT JOIN users u ON u.id=m.uploaded_by AND u.school_id=m.school_id
     WHERE m.school_id=$1 ${filter} ORDER BY m.created_at DESC LIMIT 100`, values);
  res.json({ data: rows.rows });
}));

router.post('/study-materials', requirePermission('study_materials', 'create'), asyncRoute(async (req, res) => {
  const parsed = z.object({ title: z.string().trim().min(2).max(180), description: optionalText(1000), materialType: z.enum(['pdf','document','presentation','video','link','note']), resourceUrl: z.string().trim().min(1).max(500), classId: uuid.nullable().optional(), sectionId: uuid.nullable().optional(), subjectId: uuid.nullable().optional(), academicYearId: uuid.nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the material details.' });
  const data = parsed.data;
  const result = await query(`INSERT INTO study_materials (school_id,title,description,material_type,resource_url,class_id,section_id,subject_id,academic_year_id,uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [req.user.school_id,data.title,data.description,data.materialType,data.resourceUrl,data.classId||null,data.sectionId||null,data.subjectId||null,data.academicYearId||null,req.user.id]);
  await audit(getPool(), req, { action: 'created', entity: 'study_material', entityId: result.rows[0].id });
  res.status(201).json({ material: result.rows[0] });
}));

function gradeFor(percentage) {
  if (percentage >= 90) return 'A+';
  if (percentage >= 80) return 'A';
  if (percentage >= 70) return 'B';
  if (percentage >= 60) return 'C';
  if (percentage >= 50) return 'D';
  return 'F';
}

export default router;
