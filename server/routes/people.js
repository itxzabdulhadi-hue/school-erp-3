import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText, pagination } from '../http.js';
import { requirePermission, userRolesFor } from '../access.js';
import { strongPasswordSchema } from '../auth.js';

const router = Router();
const uuid = z.string().uuid();
const optionalDate = z.preprocess((value) => value === '' || value === null ? undefined : value, z.string().date().optional());
const optionalEmail = z.preprocess((value) => value === '' || value === null ? undefined : value, z.string().trim().email().max(254).optional());
const optionalId = z.preprocess((value) => value === '' || value === null ? undefined : value, uuid.optional());
const gender = z.enum(['female', 'male', 'non_binary', 'prefer_not_to_say']).optional();

const guardianSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  relationship: optionalText(60),
  phone: optionalText(40),
  email: optionalEmail,
  address: optionalText(300),
  occupation: optionalText(120),
  emergencyContact: z.boolean().optional().default(false),
  isPrimary: z.boolean().optional().default(false),
});

const studentBaseSchema = z.object({
  studentId: optionalText(40),
  admissionNumber: z.string().trim().min(1).max(40),
  rollNumber: optionalText(40),
  firstName: z.string().trim().min(1).max(80),
  middleName: optionalText(80),
  lastName: z.string().trim().min(1).max(80),
  gender,
  dateOfBirth: optionalDate,
  bloodGroup: optionalText(8),
  nationality: optionalText(80),
  religion: optionalText(80),
  phone: optionalText(40),
  email: optionalEmail,
  address: optionalText(300),
  city: optionalText(100),
  previousSchool: optionalText(180),
  admissionDate: optionalDate,
  classId: optionalId,
  sectionId: optionalId,
  status: z.enum(['active','inactive','graduated','transferred','withdrawn']).default('active'),
  guardians: z.array(guardianSchema).max(5).optional().default([]),
  portalPassword: z.preprocess((value) => value === '' ? undefined : value, strongPasswordSchema.optional()),
});
const studentSchema = studentBaseSchema.refine((value) => !value.portalPassword || !!value.email, {
  path: ['email'], message: 'Add an email address to create a student portal login.',
});

const teacherBaseSchema = z.object({
  employeeId: optionalText(40),
  fullName: z.string().trim().min(2).max(160),
  email: optionalEmail,
  phone: optionalText(40),
  gender,
  dateOfBirth: optionalDate,
  address: optionalText(300),
  qualification: optionalText(180),
  specialization: optionalText(160),
  joiningDate: optionalDate,
  departmentId: optionalId,
  designation: optionalText(120),
  employmentStatus: z.enum(['active','on_leave','inactive']).default('active'),
  portalPassword: z.preprocess((value) => value === '' ? undefined : value, strongPasswordSchema.optional()),
});
const teacherSchema = teacherBaseSchema.refine((value) => !value.portalPassword || !!value.email, {
  path: ['email'], message: 'Add an email address to create a teacher portal login.',
});

const staffBaseSchema = z.object({
  employeeId: optionalText(40),
  fullName: z.string().trim().min(2).max(160),
  email: optionalEmail,
  phone: optionalText(40),
  designation: optionalText(120),
  departmentId: optionalId,
  joiningDate: optionalDate,
  employmentStatus: z.enum(['active','on_leave','inactive']).default('active'),
  portalPassword: z.preprocess((value) => value === '' ? undefined : value, strongPasswordSchema.optional()),
  portalRole: z.enum(['staff','accountant','librarian','transport_manager']).optional().default('staff'),
});
const staffSchema = staffBaseSchema.refine((value) => !value.portalPassword || !!value.email, {
  path: ['email'], message: 'Add an email address to create a staff portal login.',
});

function generatedCode(prefix) {
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function insertUserAccount(client, { schoolId, email, fullName, password, roleCode }) {
  if (!password) return null;
  const hash = await bcrypt.hash(password, 12);
  const userResult = await client.query(
    `INSERT INTO users (school_id, email, password_hash, full_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [schoolId, email.toLowerCase(), hash, fullName],
  );
  const roleResult = await client.query('SELECT id FROM roles WHERE school_id = $1 AND code = $2', [schoolId, roleCode]);
  if (!roleResult.rowCount) throw new Error('That portal role is not configured for this school.');
  await client.query('INSERT INTO user_roles (school_id, user_id, role_id) VALUES ($1, $2, $3)', [schoolId, userResult.rows[0].id, roleResult.rows[0].id]);
  return userResult.rows[0].id;
}

async function ensureTeacherAssignment(req, studentId) {
  if (!req.user.roles.includes('teacher')) return true;
  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM students s
       JOIN teacher_subjects ts ON ts.school_id = s.school_id AND ts.class_id = s.current_class_id
         AND (ts.section_id IS NULL OR ts.section_id = s.current_section_id)
       JOIN teachers t ON t.id = ts.teacher_id AND t.school_id = ts.school_id
       WHERE s.id = $1 AND s.school_id = $2 AND t.user_id = $3
     ) AS allowed`,
    [studentId, req.user.school_id, req.user.id],
  );
  return result.rows[0]?.allowed;
}

router.get('/people/students', requirePermission('students', 'view'), asyncRoute(async (req, res) => {
  const { limit, offset, page } = pagination(req.query, { limit: 20, maxLimit: 100 });
  const search = String(req.query.q || '').trim().slice(0, 120);
  const classId = req.query.classId || null;
  const sectionId = req.query.sectionId || null;
  const status = req.query.status || null;
  if (classId && !uuid.safeParse(classId).success) return res.status(400).json({ error: 'Invalid class filter.' });
  if (sectionId && !uuid.safeParse(sectionId).success) return res.status(400).json({ error: 'Invalid section filter.' });
  let teacherFilter = '';
  const values = [req.user.school_id];
  if (req.user.roles.includes('teacher')) {
    values.push(req.user.id);
    teacherFilter = ` AND EXISTS (
      SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id = ts.teacher_id AND t.school_id = ts.school_id
      WHERE ts.school_id = s.school_id AND t.user_id = $${values.length} AND ts.class_id = s.current_class_id
        AND (ts.section_id IS NULL OR ts.section_id = s.current_section_id)
    )`;
  }
  const filters = [];
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(s.first_name ILIKE $${values.length} OR s.middle_name ILIKE $${values.length} OR s.last_name ILIKE $${values.length}
      OR s.student_id ILIKE $${values.length} OR s.admission_number ILIKE $${values.length} OR s.phone ILIKE $${values.length})`);
  }
  if (classId) { values.push(classId); filters.push(`s.current_class_id = $${values.length}`); }
  if (sectionId) { values.push(sectionId); filters.push(`s.current_section_id = $${values.length}`); }
  if (status) { values.push(status); filters.push(`s.status = $${values.length}`); }
  const where = `s.school_id = $1 AND s.archived_at IS NULL ${teacherFilter}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
  const count = await query(`SELECT count(*)::int AS total FROM students s WHERE ${where}`, values);
  values.push(limit, offset);
  const rows = await query(
    `SELECT s.id, s.student_id, s.admission_number, s.roll_number, s.first_name, s.middle_name, s.last_name,
            s.gender, s.email, s.phone, s.status, s.admission_date, s.photo_url,
            s.current_class_id, s.current_section_id, c.name AS class_name, sec.name AS section_name,
            COALESCE(att.present_count, 0)::int AS present_count,
            COALESCE(att.total_count, 0)::int AS attendance_count,
            COALESCE(finance.balance, 0)::numeric AS balance
     FROM students s
     LEFT JOIN classes c ON c.id = s.current_class_id AND c.school_id = s.school_id
     LEFT JOIN sections sec ON sec.id = s.current_section_id AND sec.school_id = s.school_id
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE status IN ('present','late')) AS present_count, count(*) AS total_count
       FROM attendance a WHERE a.student_id = s.id AND a.school_id = s.school_id
     ) att ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total - paid),0) AS balance FROM invoices i
       WHERE i.student_id = s.id AND i.school_id = s.school_id AND i.status <> 'void'
     ) finance ON true
     WHERE ${where}
     ORDER BY s.last_name, s.first_name LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  res.json({ data: rows.rows, total: count.rows[0].total, page, pageSize: limit });
}));

router.post('/people/students', requirePermission('students', 'create'), asyncRoute(async (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the student details.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const year = await client.query('SELECT id FROM academic_years WHERE school_id = $1 AND is_current = true', [req.user.school_id]);
    if (data.classId) {
      const classResult = await client.query(
        `SELECT c.capacity, count(s.id)::int AS student_count FROM classes c
         LEFT JOIN students s ON s.current_class_id = c.id AND s.school_id = c.school_id
           AND s.status = 'active' AND s.archived_at IS NULL
         WHERE c.id = $1 AND c.school_id = $2 GROUP BY c.id`,
        [data.classId, req.user.school_id],
      );
      if (!classResult.rowCount) throw Object.assign(new Error('Select a class that belongs to this school.'), { status: 400, publicMessage: 'The selected class could not be found.' });
      if (classResult.rows[0].capacity && classResult.rows[0].student_count >= classResult.rows[0].capacity) {
        throw Object.assign(new Error('Class at capacity'), { status: 409, publicMessage: 'That class has reached its enrollment capacity.' });
      }
    }
    if (data.sectionId && !data.classId) throw Object.assign(new Error('A section must belong to a class.'), { status: 400, publicMessage: 'Choose a class before selecting a section.' });
    if (data.sectionId) {
      const section = await client.query('SELECT id FROM sections WHERE id = $1 AND class_id = $2 AND school_id = $3 AND archived_at IS NULL', [data.sectionId, data.classId, req.user.school_id]);
      if (!section.rowCount) throw Object.assign(new Error('Invalid section'), { status: 400, publicMessage: 'The selected section does not belong to this class.' });
    }
    const userId = await insertUserAccount(client, {
      schoolId: req.user.school_id,
      email: data.email,
      fullName: [data.firstName, data.middleName, data.lastName].filter(Boolean).join(' '),
      password: data.portalPassword,
      roleCode: 'student',
    });
    const studentId = data.studentId || generatedCode('STU');
    const created = await client.query(
      `INSERT INTO students
       (school_id, user_id, student_id, admission_number, roll_number, first_name, middle_name, last_name,
        gender, date_of_birth, blood_group, nationality, religion, phone, email, address, city,
        previous_school, admission_date, admission_class_id, current_class_id, current_section_id,
        academic_year_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               COALESCE($19::date, CURRENT_DATE),$20,$20,$21,$22,$23)
       RETURNING *`,
      [req.user.school_id, userId, studentId, data.admissionNumber, data.rollNumber, data.firstName,
        data.middleName, data.lastName, data.gender, data.dateOfBirth, data.bloodGroup, data.nationality,
        data.religion, data.phone, data.email?.toLowerCase(), data.address, data.city, data.previousSchool,
        data.admissionDate, data.classId, data.sectionId, year.rows[0]?.id || null, data.status],
    );
    const student = created.rows[0];
    if (data.classId && year.rowCount) {
      await client.query(
        `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_number)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.school_id, student.id, year.rows[0].id, data.classId, data.sectionId, data.rollNumber],
      );
    }
    let hasPrimary = false;
    for (const guardian of data.guardians) {
      const guardianResult = await client.query(
        `INSERT INTO guardians (school_id, full_name, relationship, phone, email, address, occupation, emergency_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.school_id, guardian.fullName, guardian.relationship, guardian.phone, guardian.email?.toLowerCase(), guardian.address, guardian.occupation, guardian.emergencyContact],
      );
      const isPrimary = guardian.isPrimary || (!hasPrimary && data.guardians.length === 1);
      hasPrimary ||= isPrimary;
      await client.query(
        `INSERT INTO student_guardians (school_id, student_id, guardian_id, is_primary)
         VALUES ($1,$2,$3,$4)`,
        [req.user.school_id, student.id, guardianResult.rows[0].id, isPrimary],
      );
    }
    await audit(client, req, { action: 'created', entity: 'student', entityId: student.id, metadata: { admissionNumber: student.admission_number } });
    await client.query('COMMIT');
    res.status(201).json({ student: formatStudent(student) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'A student or portal account already uses that ID, admission number, or email.' });
    throw error;
  } finally {
    client.release();
  }
}));

router.get('/people/students/:id', requirePermission('students', 'view'), asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT s.*, c.name AS class_name, sec.name AS section_name, ay.name AS academic_year_name,
            u.status AS portal_status
     FROM students s
     LEFT JOIN classes c ON c.id = s.current_class_id AND c.school_id = s.school_id
     LEFT JOIN sections sec ON sec.id = s.current_section_id AND sec.school_id = s.school_id
     LEFT JOIN academic_years ay ON ay.id = s.academic_year_id AND ay.school_id = s.school_id
     LEFT JOIN users u ON u.id = s.user_id AND u.school_id = s.school_id
     WHERE s.id = $1 AND s.school_id = $2 AND s.archived_at IS NULL`,
    [req.params.id, req.user.school_id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Student not found.' });
  if (!(await ensureTeacherAccessToStudent(req, result.rows[0]))) return res.status(403).json({ error: 'You can only view students in your assigned classes.' });
  const student = result.rows[0];
  const isAdmin = req.user.roles.some((role) => ['school_admin','super_admin'].includes(role));
  const permissionResult = isAdmin ? { rows: [{ module:'finance',action:'view' },{ module:'attendance',action:'view' },{ module:'exams',action:'view' },{ module:'assignments',action:'view' }] } : await query(
    `SELECT DISTINCT p.module,p.action FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.school_id=ur.school_id
     JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1 AND ur.school_id=$2`,[req.user.id,req.user.school_id],
  );
  const capabilities=new Set(permissionResult.rows.map(row=>`${row.module}.${row.action}`));
  const canViewFinance=capabilities.has('finance.view');const canViewAttendance=capabilities.has('attendance.view');
  const canViewResults=capabilities.has('exams.view');const canViewAssignments=capabilities.has('assignments.view');
  const [guardians, attendance, invoices, results, assignments] = await Promise.all([
    query(`SELECT g.id, g.full_name, g.relationship, g.phone, g.email, g.address, g.occupation, g.emergency_contact, sg.is_primary
           FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
           WHERE sg.student_id = $1 AND sg.school_id = $2 ORDER BY sg.is_primary DESC, g.full_name`, [student.id, req.user.school_id]),
    canViewAttendance
      ? query(`SELECT attendance_date, status, note FROM attendance WHERE student_id = $1 AND school_id = $2 ORDER BY attendance_date DESC LIMIT 30`, [student.id, req.user.school_id])
      : Promise.resolve({ rows: [] }),
    canViewFinance
      ? query(`SELECT id, invoice_number, issue_date, due_date, total, paid, total - paid AS balance, status
               FROM invoices WHERE student_id = $1 AND school_id = $2 AND status <> 'void' ORDER BY issue_date DESC LIMIT 12`, [student.id, req.user.school_id])
      : Promise.resolve({ rows: [] }),
    canViewResults
      ? query(`SELECT e.name AS exam_name, sub.name AS subject_name, r.marks_obtained, es.maximum_marks, r.grade, r.remarks
               FROM results r JOIN exam_subjects es ON es.id = r.exam_subject_id AND es.school_id = r.school_id
               JOIN exams e ON e.id = es.exam_id AND e.school_id = es.school_id
               JOIN subjects sub ON sub.id = es.subject_id AND sub.school_id = es.school_id
               WHERE r.student_id = $1 AND r.school_id = $2 ORDER BY e.start_date DESC LIMIT 30`, [student.id, req.user.school_id])
      : Promise.resolve({ rows: [] }),
    canViewAssignments
      ? query(`SELECT a.id, a.title, a.due_at, s.name AS subject_name, sub.status AS submission_status
               FROM assignments a JOIN subjects s ON s.id = a.subject_id AND s.school_id = a.school_id
               LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = $1 AND sub.school_id = a.school_id
               WHERE a.school_id = $2 AND a.class_id = $3 AND (a.section_id IS NULL OR a.section_id = $4)
                 AND a.status = 'published' ORDER BY a.due_at NULLS LAST LIMIT 20`,
        [student.id, req.user.school_id, student.current_class_id, student.current_section_id])
      : Promise.resolve({ rows: [] }),
  ]);
  res.json({
    student: formatStudent(student),
    guardians: guardians.rows,
    attendance: attendance.rows,
    invoices: invoices.rows,
    results: results.rows,
    assignments: assignments.rows,
    permissions: { finance:canViewFinance,attendance:canViewAttendance,results:canViewResults,assignments:canViewAssignments },
  });
}));

async function ensureTeacherAccessToStudent(req, student) {
  if (!req.user.roles.includes('teacher')) return true;
  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM teacher_subjects ts JOIN teachers t ON t.id = ts.teacher_id AND t.school_id = ts.school_id
       WHERE ts.school_id = $1 AND t.user_id = $2 AND ts.class_id = $3
         AND (ts.section_id IS NULL OR ts.section_id = $4)
     ) AS allowed`,
    [req.user.school_id, req.user.id, student.current_class_id, student.current_section_id],
  );
  return result.rows[0]?.allowed;
}

router.patch('/people/students/:id', requirePermission('students', 'edit'), asyncRoute(async (req, res) => {
  const parsed = studentBaseSchema.omit({ guardians: true, portalPassword: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the student details.' });
  const data = parsed.data;
  const allowed = {
    admissionNumber: 'admission_number', rollNumber: 'roll_number', firstName: 'first_name', middleName: 'middle_name',
    lastName: 'last_name', gender: 'gender', dateOfBirth: 'date_of_birth', bloodGroup: 'blood_group', nationality: 'nationality',
    religion: 'religion', phone: 'phone', email: 'email', address: 'address', city: 'city', previousSchool: 'previous_school',
    admissionDate: 'admission_date', classId: 'current_class_id', sectionId: 'current_section_id', status: 'status', studentId: 'student_id',
  };
  const fields = Object.entries(data).filter(([key]) => allowed[key]);
  if (!fields.length) return res.status(400).json({ error: 'There are no student changes to save.' });
  const values = [req.params.id, req.user.school_id];
  const assignments = fields.map(([key, value]) => {
    values.push(key === 'email' ? value?.toLowerCase() : value);
    return `${allowed[key]} = $${values.length}`;
  });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 AND archived_at IS NULL FOR UPDATE', values.slice(0, 2));
    if (!existing.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student not found.' }); }
    const nextClass = data.classId ?? existing.rows[0].current_class_id;
    const nextSection = data.sectionId ?? existing.rows[0].current_section_id;
    if (nextSection) {
      const section = await client.query('SELECT id FROM sections WHERE id = $1 AND class_id = $2 AND school_id = $3', [nextSection, nextClass, req.user.school_id]);
      if (!section.rowCount) throw Object.assign(new Error('Invalid section'), { status: 400, publicMessage: 'The selected section does not belong to the chosen class.' });
    }
    assignments.push('updated_at = now()');
    const saved = await client.query(
      `UPDATE students SET ${assignments.join(', ')} WHERE id = $1 AND school_id = $2 RETURNING *`, values,
    );
    if (data.classId || data.sectionId || data.rollNumber) {
      const yearId = saved.rows[0].academic_year_id;
      if (yearId && saved.rows[0].current_class_id) {
        await client.query(
          `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_number)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (school_id, student_id, academic_year_id) DO UPDATE
           SET class_id = EXCLUDED.class_id, section_id = EXCLUDED.section_id,
               roll_number = EXCLUDED.roll_number, updated_at = now()`,
          [req.user.school_id, saved.rows[0].id, yearId, saved.rows[0].current_class_id, saved.rows[0].current_section_id, saved.rows[0].roll_number],
        );
      }
    }
    await audit(client, req, { action: 'updated', entity: 'student', entityId: req.params.id, metadata: { changedFields: fields.map(([key]) => key) } });
    await client.query('COMMIT');
    res.json({ student: formatStudent(saved.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'That student ID, admission number, or email is already in use.' });
    throw error;
  } finally {
    client.release();
  }
}));

router.delete('/people/students/:id', requirePermission('students', 'delete'), asyncRoute(async (req, res) => {
  const result = await query(
    `UPDATE students SET archived_at = now(), status = 'inactive', updated_at = now()
     WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING id`,
    [req.params.id, req.user.school_id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Student not found.' });
  await audit(getPool(), req, { action: 'archived', entity: 'student', entityId: req.params.id });
  res.json({ success: true });
}));

router.post('/people/students/:id/promote', requirePermission('students', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ classId: uuid, sectionId: optionalId, academicYearId: uuid, rollNumber: optionalText(40) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Select a valid academic year and destination class.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const student = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 AND archived_at IS NULL FOR UPDATE', [req.params.id, req.user.school_id]);
    if (!student.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student not found.' }); }
    if (data.sectionId) {
      const section = await client.query('SELECT id FROM sections WHERE id = $1 AND class_id = $2 AND school_id = $3', [data.sectionId, data.classId, req.user.school_id]);
      if (!section.rowCount) throw Object.assign(new Error('Invalid section'), { status: 400, publicMessage: 'The selected section does not belong to the destination class.' });
    }
    await client.query(
      `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_number, status)
       VALUES ($1,$2,$3,$4,$5,$6,'enrolled')
       ON CONFLICT (school_id, student_id, academic_year_id) DO UPDATE
       SET class_id = EXCLUDED.class_id, section_id = EXCLUDED.section_id,
           roll_number = EXCLUDED.roll_number, status = 'enrolled', updated_at = now()`,
      [req.user.school_id, req.params.id, data.academicYearId, data.classId, data.sectionId, data.rollNumber],
    );
    const saved = await client.query(
      `UPDATE students SET current_class_id = $1, current_section_id = $2, roll_number = $3,
          academic_year_id = $4, updated_at = now() WHERE id = $5 AND school_id = $6 RETURNING *`,
      [data.classId, data.sectionId, data.rollNumber, data.academicYearId, req.params.id, req.user.school_id],
    );
    await audit(client, req, { action: 'promoted', entity: 'student', entityId: req.params.id, metadata: { classId: data.classId, academicYearId: data.academicYearId } });
    await client.query('COMMIT');
    res.json({ student: formatStudent(saved.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.get('/people/teachers', requirePermission('teachers', 'view'), asyncRoute(async (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 100);
  const { limit, offset, page } = pagination(req.query, { limit: 30, maxLimit: 100 });
  const values = [req.user.school_id];
  const searchSql = search ? `AND (t.full_name ILIKE $2 OR t.employee_id ILIKE $2 OR t.email ILIKE $2 OR d.name ILIKE $2)` : '';
  if (search) values.push(`%${search}%`);
  const rows = await query(
    `SELECT t.id, t.employee_id, t.full_name, t.email, t.phone, t.gender, t.qualification, t.specialization,
            t.designation, t.department_id, t.employment_status, t.joining_date, t.photo_url, d.name AS department_name,
            u.id AS user_id, count(DISTINCT ts.class_id)::int AS class_count,
            count(DISTINCT ts.subject_id)::int AS subject_count
     FROM teachers t LEFT JOIN departments d ON d.id = t.department_id AND d.school_id = t.school_id
     LEFT JOIN users u ON u.id = t.user_id AND u.school_id = t.school_id
     LEFT JOIN teacher_subjects ts ON ts.teacher_id = t.id AND ts.school_id = t.school_id
     WHERE t.school_id = $1 AND t.archived_at IS NULL ${searchSql}
     GROUP BY t.id, d.name, u.id ORDER BY t.full_name LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const countResult = await query(
    `SELECT count(*)::int AS total FROM teachers t LEFT JOIN departments d ON d.id = t.department_id AND d.school_id = t.school_id
     WHERE t.school_id = $1 AND t.archived_at IS NULL ${searchSql}`,
    values,
  );
  res.json({ data: rows.rows, total: countResult.rows[0].total, page, pageSize: limit });
}));

router.post('/people/teachers', requirePermission('teachers', 'create'), asyncRoute(async (req, res) => {
  const parsed = teacherSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the teacher details.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const userId = await insertUserAccount(client, {
      schoolId: req.user.school_id,
      email: data.email,
      fullName: data.fullName,
      password: data.portalPassword,
      roleCode: 'teacher',
    });
    const employeeId = data.employeeId || generatedCode('EMP');
    const created = await client.query(
      `INSERT INTO teachers
       (school_id,user_id,employee_id,full_name,email,phone,gender,date_of_birth,address,qualification,
        specialization,joining_date,department_id,designation,employment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.school_id, userId, employeeId, data.fullName, data.email?.toLowerCase(), data.phone,
        data.gender, data.dateOfBirth, data.address, data.qualification, data.specialization,
        data.joiningDate, data.departmentId, data.designation, data.employmentStatus],
    );
    await audit(client, req, { action: 'created', entity: 'teacher', entityId: created.rows[0].id, metadata: { employeeId } });
    await client.query('COMMIT');
    res.status(201).json({ teacher: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'That employee ID or email is already in use.' });
    throw error;
  } finally { client.release(); }
}));

router.patch('/people/teachers/:id', requirePermission('teachers', 'edit'), asyncRoute(async (req, res) => {
  const schema = teacherBaseSchema.omit({ portalPassword: true }).partial();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the teacher details.' });
  const columns = {
    employeeId: 'employee_id', fullName: 'full_name', email: 'email', phone: 'phone', gender: 'gender',
    dateOfBirth: 'date_of_birth', address: 'address', qualification: 'qualification', specialization: 'specialization',
    joiningDate: 'joining_date', departmentId: 'department_id', designation: 'designation', employmentStatus: 'employment_status',
  };
  const fields = Object.entries(parsed.data).filter(([key]) => columns[key]);
  if (!fields.length) return res.status(400).json({ error: 'There are no teacher changes to save.' });
  const values = [req.params.id, req.user.school_id];
  const updates = fields.map(([key, value]) => {
    values.push(key === 'email' ? value?.toLowerCase() : value);
    return `${columns[key]} = $${values.length}`;
  });
  updates.push('updated_at = now()');
  const result = await query(`UPDATE teachers SET ${updates.join(', ')} WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING *`, values);
  if (!result.rowCount) return res.status(404).json({ error: 'Teacher not found.' });
  await audit(getPool(), req, { action: 'updated', entity: 'teacher', entityId: req.params.id, metadata: { changedFields: fields.map(([key]) => key) } });
  res.json({ teacher: result.rows[0] });
}));

router.delete('/people/teachers/:id', requirePermission('teachers', 'delete'), asyncRoute(async (req, res) => {
  const result = await query(`UPDATE teachers SET archived_at = now(), employment_status = 'archived', updated_at = now() WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING id`, [req.params.id, req.user.school_id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Teacher not found.' });
  await audit(getPool(), req, { action: 'archived', entity: 'teacher', entityId: req.params.id });
  res.json({ success: true });
}));

router.get('/people/staff', requirePermission('staff', 'view'), asyncRoute(async (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 100);
  const values = [req.user.school_id];
  let filter = '';
  if (search) { values.push(`%${search}%`); filter = 'AND (s.full_name ILIKE $2 OR s.employee_id ILIKE $2 OR s.email ILIKE $2 OR d.name ILIKE $2)'; }
  const result = await query(
    `SELECT s.id, s.employee_id, s.full_name, s.email, s.phone, s.designation, s.department_id, s.employment_status,
            s.joining_date, d.name AS department_name, u.id AS user_id, COALESCE(r.label, 'Staff') AS portal_role
     FROM staff s LEFT JOIN departments d ON d.id = s.department_id AND d.school_id = s.school_id
     LEFT JOIN users u ON u.id = s.user_id AND u.school_id = s.school_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
     LEFT JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id
     WHERE s.school_id = $1 AND s.archived_at IS NULL ${filter} ORDER BY s.full_name`, values,
  );
  res.json({ data: result.rows });
}));

router.post('/people/staff', requirePermission('staff', 'create'), asyncRoute(async (req, res) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the staff details.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const userId = await insertUserAccount(client, {
      schoolId: req.user.school_id, email: data.email, fullName: data.fullName,
      password: data.portalPassword, roleCode: data.portalRole,
    });
    const employeeId = data.employeeId || generatedCode('EMP');
    const created = await client.query(
      `INSERT INTO staff (school_id,user_id,employee_id,full_name,email,phone,designation,department_id,joining_date,employment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.school_id, userId, employeeId, data.fullName, data.email?.toLowerCase(), data.phone,
        data.designation, data.departmentId, data.joiningDate, data.employmentStatus],
    );
    await audit(client, req, { action: 'created', entity: 'staff', entityId: created.rows[0].id, metadata: { employeeId } });
    await client.query('COMMIT');
    res.status(201).json({ staff: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'That employee ID or email is already in use.' });
    throw error;
  } finally { client.release(); }
}));

router.patch('/people/staff/:id', requirePermission('staff', 'edit'), asyncRoute(async (req, res) => {
  const parsed = staffBaseSchema.omit({ portalPassword: true, portalRole: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the staff details.' });
  const columns = { employeeId: 'employee_id', fullName: 'full_name', email: 'email', phone: 'phone', designation: 'designation', departmentId: 'department_id', joiningDate: 'joining_date', employmentStatus: 'employment_status' };
  const fields = Object.entries(parsed.data).filter(([key]) => columns[key]);
  if (!fields.length) return res.status(400).json({ error: 'There are no staff changes to save.' });
  const values = [req.params.id, req.user.school_id];
  const updates = fields.map(([key, value]) => { values.push(key === 'email' ? value?.toLowerCase() : value); return `${columns[key]} = $${values.length}`; });
  updates.push('updated_at = now()');
  const result = await query(`UPDATE staff SET ${updates.join(', ')} WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING *`, values);
  if (!result.rowCount) return res.status(404).json({ error: 'Staff record not found.' });
  await audit(getPool(), req, { action: 'updated', entity: 'staff', entityId: req.params.id, metadata: { changedFields: fields.map(([key]) => key) } });
  res.json({ staff: result.rows[0] });
}));

router.delete('/people/staff/:id', requirePermission('staff', 'delete'), asyncRoute(async (req, res) => {
  const result = await query(`UPDATE staff SET archived_at = now(), employment_status = 'archived', updated_at = now() WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING id`, [req.params.id, req.user.school_id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Staff record not found.' });
  await audit(getPool(), req, { action: 'archived', entity: 'staff', entityId: req.params.id });
  res.json({ success: true });
}));

router.get('/academic/structure', requirePermission('classes', 'view'), asyncRoute(async (req, res) => {
  const teacherScope = req.user.roles.includes('teacher');
  const schoolId = req.user.school_id;
  const [classes, subjects, years, departments, sections] = await Promise.all([
    query(`SELECT c.id,c.name,c.grade_level,c.capacity,
              count(DISTINCT sec.id)::int AS sections_count,count(DISTINCT s.id)::int AS students_count
           FROM classes c LEFT JOIN sections sec ON sec.class_id=c.id AND sec.school_id=c.school_id AND sec.archived_at IS NULL
           LEFT JOIN students s ON s.current_class_id=c.id AND s.school_id=c.school_id AND s.status='active' AND s.archived_at IS NULL
           WHERE c.school_id=$1 AND c.archived_at IS NULL
             AND (NOT $2 OR EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers assigned ON assigned.id=ts.teacher_id AND assigned.school_id=ts.school_id
               WHERE ts.school_id=c.school_id AND assigned.user_id=$3 AND ts.class_id=c.id))
           GROUP BY c.id ORDER BY c.grade_level NULLS LAST,c.name`, [schoolId,teacherScope,req.user.id]),
    query(`SELECT su.id,su.name,su.code,su.subject_type,su.credits,
              count(DISTINCT cs.class_id)::int AS classes_count,count(DISTINCT ts.teacher_id)::int AS teachers_count
           FROM subjects su LEFT JOIN class_subjects cs ON cs.subject_id=su.id AND cs.school_id=su.school_id
           LEFT JOIN teacher_subjects ts ON ts.subject_id=su.id AND ts.school_id=su.school_id
           WHERE su.school_id=$1 AND su.archived_at IS NULL
             AND (NOT $2 OR EXISTS (SELECT 1 FROM teacher_subjects assigned_ts JOIN teachers assigned ON assigned.id=assigned_ts.teacher_id AND assigned.school_id=assigned_ts.school_id
               WHERE assigned_ts.school_id=su.school_id AND assigned.user_id=$3 AND assigned_ts.subject_id=su.id))
           GROUP BY su.id ORDER BY su.name`, [schoolId,teacherScope,req.user.id]),
    query(`SELECT id,name,start_date,end_date,is_current FROM academic_years WHERE school_id=$1 AND archived_at IS NULL ORDER BY start_date DESC`, [schoolId]),
    query(`SELECT id,name FROM departments WHERE school_id=$1 AND archived_at IS NULL ORDER BY name`, [schoolId]),
    query(`SELECT sec.id,sec.class_id,sec.name,sec.room,sec.capacity,t.full_name AS teacher_name,count(DISTINCT s.id)::int AS students_count
           FROM sections sec LEFT JOIN teachers t ON t.id=sec.class_teacher_id AND t.school_id=sec.school_id
           LEFT JOIN students s ON s.current_section_id=sec.id AND s.school_id=sec.school_id AND s.status='active' AND s.archived_at IS NULL
           WHERE sec.school_id=$1 AND sec.archived_at IS NULL
             AND (NOT $2 OR EXISTS (SELECT 1 FROM teacher_subjects ts JOIN teachers assigned ON assigned.id=ts.teacher_id AND assigned.school_id=ts.school_id
               WHERE ts.school_id=sec.school_id AND assigned.user_id=$3 AND ts.class_id=sec.class_id AND (ts.section_id IS NULL OR ts.section_id=sec.id)))
           GROUP BY sec.id,t.full_name ORDER BY sec.name`, [schoolId,teacherScope,req.user.id]),
  ]);
  res.json({ classes: classes.rows, sections: sections.rows, subjects: subjects.rows, academicYears: years.rows, departments: departments.rows });
}));

const classSchema = z.object({ name: z.string().trim().min(1).max(80), gradeLevel: z.coerce.number().int().min(0).max(20).optional(), capacity: z.coerce.number().int().positive().max(5000).optional(), description: optionalText(500) });
router.post('/academic/classes', requirePermission('classes', 'create'), asyncRoute(async (req, res) => {
  const parsed = classSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the class details.' });
  const data = parsed.data;
  try {
    const result = await query(
      `INSERT INTO classes (school_id,name,grade_level,capacity,description) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.school_id, data.name, data.gradeLevel, data.capacity, data.description],
    );
    await audit(getPool(), req, { action: 'created', entity: 'class', entityId: result.rows[0].id });
    res.status(201).json({ class: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A class with that name already exists.' });
    throw error;
  }
}));

router.patch('/academic/classes/:id', requirePermission('classes', 'edit'), asyncRoute(async (req, res) => {
  const parsed = classSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the class details.' });
  const columns = { name: 'name', gradeLevel: 'grade_level', capacity: 'capacity', description: 'description' };
  const fields = Object.entries(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'There are no class changes to save.' });
  const values = [req.params.id, req.user.school_id];
  const updates = fields.map(([key, value]) => { values.push(value); return `${columns[key]} = $${values.length}`; });
  updates.push('updated_at = now()');
  const result = await query(`UPDATE classes SET ${updates.join(', ')} WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING *`, values);
  if (!result.rowCount) return res.status(404).json({ error: 'Class not found.' });
  await audit(getPool(), req, { action: 'updated', entity: 'class', entityId: req.params.id });
  res.json({ class: result.rows[0] });
}));

router.post('/academic/classes/:id/sections', requirePermission('classes', 'create'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(40), room: optionalText(80), capacity: z.coerce.number().int().positive().max(5000).optional(), classTeacherId: optionalId }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the section details.' });
  const data = parsed.data;
  try {
    const result = await query(
      `INSERT INTO sections (school_id,class_id,name,room,capacity,class_teacher_id)
       SELECT $1,id,$3,$4,$5,$6 FROM classes WHERE id = $2 AND school_id = $1 AND archived_at IS NULL
       RETURNING *`,
      [req.user.school_id, req.params.id, data.name, data.room, data.capacity, data.classTeacherId],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Class not found.' });
    await audit(getPool(), req, { action: 'created', entity: 'section', entityId: result.rows[0].id });
    res.status(201).json({ section: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A section with that name already exists in this class.' });
    throw error;
  }
}));

const subjectSchema = z.object({ name: z.string().trim().min(1).max(120), code: z.string().trim().min(1).max(40), subjectType: z.enum(['core','elective','practical','activity']).default('core'), credits: z.coerce.number().nonnegative().max(100).optional(), description: optionalText(500) });
router.post('/academic/subjects', requirePermission('subjects', 'create'), asyncRoute(async (req, res) => {
  const parsed = subjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the subject details.' });
  const data = parsed.data;
  try {
    const result = await query(
      `INSERT INTO subjects (school_id,name,code,subject_type,credits,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.school_id, data.name, data.code.toUpperCase(), data.subjectType, data.credits, data.description],
    );
    await audit(getPool(), req, { action: 'created', entity: 'subject', entityId: result.rows[0].id });
    res.status(201).json({ subject: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That subject code is already in use.' });
    throw error;
  }
}));

router.patch('/academic/subjects/:id', requirePermission('subjects', 'edit'), asyncRoute(async (req, res) => {
  const parsed = subjectSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the subject details.' });
  const columns = { name: 'name', code: 'code', subjectType: 'subject_type', credits: 'credits', description: 'description' };
  const fields = Object.entries(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'There are no subject changes to save.' });
  const values = [req.params.id, req.user.school_id];
  const updates = fields.map(([key, value]) => { values.push(key === 'code' ? value.toUpperCase() : value); return `${columns[key]} = $${values.length}`; });
  updates.push('updated_at = now()');
  try {
    const result = await query(`UPDATE subjects SET ${updates.join(', ')} WHERE id = $1 AND school_id = $2 AND archived_at IS NULL RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ error: 'Subject not found.' });
    await audit(getPool(), req, { action: 'updated', entity: 'subject', entityId: req.params.id });
    res.json({ subject: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That subject code is already in use.' });
    throw error;
  }
}));

router.get('/academic/teaching-assignments', requirePermission('classes', 'view'), asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT cs.class_id,cs.subject_id,cs.academic_year_id,cs.weekly_hours,c.name AS class_name,s.name AS subject_name,
            ay.name AS academic_year_name,ts.id AS assignment_id,ts.teacher_id,ts.section_id,t.full_name AS teacher_name,sec.name AS section_name
     FROM class_subjects cs JOIN classes c ON c.id=cs.class_id AND c.school_id=cs.school_id
     JOIN subjects s ON s.id=cs.subject_id AND s.school_id=cs.school_id
     LEFT JOIN academic_years ay ON ay.id=cs.academic_year_id AND ay.school_id=cs.school_id
     LEFT JOIN teacher_subjects ts ON ts.school_id=cs.school_id AND ts.class_id=cs.class_id AND ts.subject_id=cs.subject_id
       AND ts.academic_year_id=cs.academic_year_id
     LEFT JOIN teachers t ON t.id=ts.teacher_id AND t.school_id=ts.school_id
     LEFT JOIN sections sec ON sec.id=ts.section_id AND sec.school_id=ts.school_id
     WHERE cs.school_id=$1 AND (NOT $2 OR ts.id IS NOT NULL AND t.user_id=$3)
     ORDER BY c.grade_level NULLS LAST,c.name,s.name,t.full_name`, [req.user.school_id,req.user.roles.includes('teacher'),req.user.id],
  );
  res.json({ data: result.rows });
}));

router.post('/academic/class-subjects', requirePermission('classes', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ classId: uuid, subjectId: uuid, academicYearId: uuid, weeklyHours: z.coerce.number().positive().max(60).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a class, subject and academic year.' });
  const data = parsed.data;
  try {
    await query(
      `INSERT INTO class_subjects (school_id,class_id,subject_id,academic_year_id,weekly_hours)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (class_id,subject_id,academic_year_id) DO UPDATE SET weekly_hours=EXCLUDED.weekly_hours`,
      [req.user.school_id,data.classId,data.subjectId,data.academicYearId,data.weeklyHours],
    );
    await audit(getPool(), req, { action: 'assigned', entity: 'class_subject', entityId: data.classId, metadata: { subjectId: data.subjectId, academicYearId: data.academicYearId } });
    res.status(201).json({ success: true });
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'The selected class, subject or academic year could not be found.' });
    throw error;
  }
}));

router.post('/academic/teacher-subjects', requirePermission('classes', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ teacherId: uuid, classId: uuid, sectionId: optionalId, subjectId: uuid, academicYearId: uuid }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a teacher, class, subject and academic year.' });
  const data = parsed.data;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const assigned = await client.query(
      `SELECT id FROM class_subjects WHERE school_id=$1 AND class_id=$2 AND subject_id=$3 AND academic_year_id=$4`,
      [req.user.school_id,data.classId,data.subjectId,data.academicYearId],
    );
    if (!assigned.rowCount) throw Object.assign(new Error('Class subject not assigned'), { status: 400, publicMessage: 'Assign this subject to the class before choosing a teacher.' });
    if (data.sectionId) {
      const section = await client.query('SELECT id FROM sections WHERE id=$1 AND class_id=$2 AND school_id=$3', [data.sectionId,data.classId,req.user.school_id]);
      if (!section.rowCount) throw Object.assign(new Error('Section does not match class'), { status: 400, publicMessage: 'The selected section does not belong to this class.' });
    }
    const result = await client.query(
      `INSERT INTO teacher_subjects (school_id,teacher_id,subject_id,class_id,section_id,academic_year_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [req.user.school_id,data.teacherId,data.subjectId,data.classId,data.sectionId||null,data.academicYearId],
    );
    if (!result.rowCount) throw Object.assign(new Error('Assignment already exists'), { status: 409, publicMessage: 'This teacher is already assigned to that class and subject.' });
    await audit(client, req, { action: 'assigned', entity: 'teacher_subject', entityId: result.rows[0].id, metadata: { teacherId: data.teacherId, classId: data.classId, subjectId: data.subjectId } });
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503') return res.status(400).json({ error: 'The selected class, teacher, subject or academic year could not be found.' });
    throw error;
  } finally { client.release(); }
}));

router.patch('/academic/sections/:id', requirePermission('classes', 'edit'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(40).optional(), room: optionalText(80), capacity: z.coerce.number().int().positive().max(5000).optional(), classTeacherId: optionalId }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the section details.' });
  const columns = { name:'name', room:'room', capacity:'capacity', classTeacherId:'class_teacher_id' };
  const fields = Object.entries(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'There are no section changes to save.' });
  const values = [req.params.id,req.user.school_id];
  const updates = fields.map(([key,value])=>{values.push(value||null);return `${columns[key]}=$${values.length}`;});
  updates.push('updated_at=now()');
  const result = await query(`UPDATE sections SET ${updates.join(',')} WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING *`,values);
  if(!result.rowCount)return res.status(404).json({error:'Section not found.'});
  await audit(getPool(),req,{action:'updated',entity:'section',entityId:req.params.id});res.json({section:result.rows[0]});
}));
router.delete('/academic/sections/:id',requirePermission('classes','delete'),asyncRoute(async(req,res)=>{
  const result=await query('UPDATE sections SET archived_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING id',[req.params.id,req.user.school_id]);
  if(!result.rowCount)return res.status(404).json({error:'Section not found.'});
  await audit(getPool(),req,{action:'archived',entity:'section',entityId:req.params.id});res.json({success:true});
}));
router.delete('/academic/classes/:id',requirePermission('classes','delete'),asyncRoute(async(req,res)=>{
  const result=await query('UPDATE classes SET archived_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING id',[req.params.id,req.user.school_id]);
  if(!result.rowCount)return res.status(404).json({error:'Class not found.'});
  await audit(getPool(),req,{action:'archived',entity:'class',entityId:req.params.id});res.json({success:true});
}));
router.delete('/academic/subjects/:id',requirePermission('subjects','delete'),asyncRoute(async(req,res)=>{
  const result=await query('UPDATE subjects SET archived_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING id',[req.params.id,req.user.school_id]);
  if(!result.rowCount)return res.status(404).json({error:'Subject not found.'});
  await audit(getPool(),req,{action:'archived',entity:'subject',entityId:req.params.id});res.json({success:true});
}));

router.get('/people/departments', requirePermission('staff', 'view'), asyncRoute(async (req, res) => {
  const result = await query('SELECT id,name,description FROM departments WHERE school_id=$1 AND archived_at IS NULL ORDER BY name', [req.user.school_id]);
  res.json({ data: result.rows });
}));
router.post('/people/departments', requirePermission('staff', 'create'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(120), description: optionalText(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a department name.' });
  try {
    const result = await query('INSERT INTO departments (school_id,name,description) VALUES ($1,$2,$3) RETURNING *', [req.user.school_id, parsed.data.name, parsed.data.description]);
    await audit(getPool(), req, { action: 'created', entity: 'department', entityId: result.rows[0].id });
    res.status(201).json({ department: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That department already exists.' });
    throw error;
  }
}));

function formatStudent(student) {
  return {
    id: student.id,
    studentId: student.student_id,
    admissionNumber: student.admission_number,
    rollNumber: student.roll_number,
    firstName: student.first_name,
    middleName: student.middle_name,
    lastName: student.last_name,
    fullName: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' '),
    gender: student.gender,
    dateOfBirth: student.date_of_birth,
    bloodGroup: student.blood_group,
    nationality: student.nationality,
    religion: student.religion,
    email: student.email,
    phone: student.phone,
    address: student.address,
    city: student.city,
    previousSchool: student.previous_school,
    admissionDate: student.admission_date,
    classId: student.current_class_id,
    sectionId: student.current_section_id,
    className: student.class_name,
    sectionName: student.section_name,
    academicYearId: student.academic_year_id,
    academicYearName: student.academic_year_name,
    status: student.status,
    photoUrl: student.photo_url,
    portalStatus: student.portal_status || null,
  };
}

export default router;
