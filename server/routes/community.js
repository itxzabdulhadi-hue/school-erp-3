import { Router } from 'express';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText } from '../http.js';
import { requirePermission } from '../access.js';

const router = Router();
const uuid = z.string().uuid();
const dateValue = z.string().date();
const optionalDateTime = z.preprocess((value) => value === '' || value === null ? undefined : value, z.string().datetime().optional());

router.get('/announcements', requirePermission('announcements', 'view'), asyncRoute(async (req, res) => {
  let audienceFilter = '';
  const values = [req.user.school_id];
  if (req.user.roles.includes('student')) {
    values.push(req.user.id);
    audienceFilter = `AND (a.audience IN ('all','students') OR (a.audience='class' AND a.class_id=(SELECT current_class_id FROM students WHERE user_id=$${values.length} AND school_id=a.school_id)))`;
  } else if (req.user.roles.includes('teacher')) {
    audienceFilter = "AND a.audience IN ('all','teachers','class')";
  } else if (req.user.roles.includes('staff') || req.user.roles.some((role) => ['librarian','transport_manager'].includes(role))) {
    audienceFilter = "AND a.audience IN ('all','staff')";
  }
  const result = await query(
    `SELECT a.id,a.title,a.description,a.category,a.priority,a.audience,a.class_id,a.section_id,a.publish_at,a.expires_at,
            a.attachment_url,a.created_at,c.name AS class_name,sec.name AS section_name,u.full_name AS author
     FROM announcements a LEFT JOIN classes c ON c.id=a.class_id AND c.school_id=a.school_id
     LEFT JOIN sections sec ON sec.id=a.section_id AND sec.school_id=a.school_id
     LEFT JOIN users u ON u.id=a.created_by AND u.school_id=a.school_id
     WHERE a.school_id=$1 AND a.archived_at IS NULL AND a.publish_at<=now() AND (a.expires_at IS NULL OR a.expires_at>=now()) ${audienceFilter}
     ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,a.publish_at DESC LIMIT 100`, values,
  );
  res.json({ data: result.rows });
}));

const announcementSchema = z.object({
  title: z.string().trim().min(2).max(180), description: z.string().trim().min(2).max(5000),
  category: z.enum(['general','academic','examination','fees','event','emergency']).default('general'),
  priority: z.enum(['low','normal','high','urgent']).default('normal'),
  audience: z.enum(['all','students','teachers','staff','parents','class']).default('all'),
  classId: uuid.nullable().optional(), sectionId: uuid.nullable().optional(),
  publishAt: optionalDateTime, expiresAt: optionalDateTime, attachmentUrl: optionalText(500),
}).refine((value) => !value.publishAt || !value.expiresAt || value.expiresAt >= value.publishAt, { path: ['expiresAt'], message: 'The expiry date must be after the publish date.' });

router.post('/announcements', requirePermission('announcements', 'create'), asyncRoute(async (req, res) => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the announcement.' });
  const data = parsed.data;
  const result = await query(
    `INSERT INTO announcements (school_id,title,description,category,priority,audience,class_id,section_id,publish_at,expires_at,attachment_url,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()),$10,$11,$12) RETURNING id,title`,
    [req.user.school_id,data.title,data.description,data.category,data.priority,data.audience,data.classId||null,data.sectionId||null,data.publishAt||null,data.expiresAt||null,data.attachmentUrl,req.user.id],
  );
  await audit(getPool(), req, { action: 'created', entity: 'announcement', entityId: result.rows[0].id, metadata: { category: data.category, audience: data.audience } });
  res.status(201).json({ announcement: result.rows[0] });
}));

router.patch('/announcements/:id', requirePermission('announcements', 'edit'), asyncRoute(async (req, res) => {
  const parsed = announcementSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the announcement.' });
  const columns = { title:'title',description:'description',category:'category',priority:'priority',audience:'audience',classId:'class_id',sectionId:'section_id',publishAt:'publish_at',expiresAt:'expires_at',attachmentUrl:'attachment_url' };
  const fields = Object.entries(parsed.data).filter(([key]) => columns[key]);
  if (!fields.length) return res.status(400).json({ error: 'There are no announcement changes to save.' });
  const values = [req.params.id,req.user.school_id];
  const updates = fields.map(([key,value]) => { values.push(value || null); return `${columns[key]}=$${values.length}`; });
  updates.push('updated_at=now()');
  const result = await query(`UPDATE announcements SET ${updates.join(',')} WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING id,title`,values);
  if (!result.rowCount) return res.status(404).json({ error: 'Announcement not found.' });
  await audit(getPool(), req, { action: 'updated', entity: 'announcement', entityId: req.params.id });
  res.json({ announcement: result.rows[0] });
}));
router.delete('/announcements/:id', requirePermission('announcements', 'delete'), asyncRoute(async (req, res) => {
  const result = await query(`UPDATE announcements SET archived_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING id`,[req.params.id,req.user.school_id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Announcement not found.' });
  await audit(getPool(), req, { action: 'archived', entity: 'announcement', entityId: req.params.id });
  res.json({ success:true });
}));

router.get('/events', requirePermission('events', 'view'), asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT id,title,description,category,starts_at,ends_at,location,organizer,audience,attachment_url
     FROM events WHERE school_id=$1 AND starts_at>=now()-INTERVAL '30 days'
     AND ($2::boolean OR audience IN ('all',$3)) ORDER BY starts_at LIMIT 100`,
    [req.user.school_id,req.user.roles.some((role) => ['school_admin','super_admin','principal'].includes(role)),
      req.user.roles.includes('student') ? 'students' : req.user.roles.includes('teacher') ? 'teachers' : 'staff'],
  );
  res.json({ data: result.rows });
}));

const eventSchema = z.object({ title:z.string().trim().min(2).max(180),description:optionalText(3000),category:optionalText(60),
  startsAt:z.string().datetime(),endsAt:optionalDateTime,location:optionalText(160),organizer:optionalText(120),audience:z.enum(['all','students','teachers','staff','parents']).default('all'),attachmentUrl:optionalText(500) })
  .refine((value) => !value.endsAt || value.endsAt>=value.startsAt,{path:['endsAt'],message:'The event end time must be after its start time.'});
router.post('/events', requirePermission('events', 'create'), asyncRoute(async (req,res)=>{
  const parsed=eventSchema.safeParse(req.body); if(!parsed.success) return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the event details.'});
  const d=parsed.data;
  const result=await query(`INSERT INTO events (school_id,title,description,category,starts_at,ends_at,location,organizer,audience,attachment_url,created_by)
    VALUES ($1,$2,$3,COALESCE($4,'general'),$5,$6,$7,$8,$9,$10,$11) RETURNING id,title`,[req.user.school_id,d.title,d.description,d.category,d.startsAt,d.endsAt||null,d.location,d.organizer,d.audience,d.attachmentUrl,req.user.id]);
  await audit(getPool(),req,{action:'created',entity:'event',entityId:result.rows[0].id});
  res.status(201).json({event:result.rows[0]});
}));
router.delete('/events/:id',requirePermission('events','delete'),asyncRoute(async(req,res)=>{
  const result=await query('DELETE FROM events WHERE id=$1 AND school_id=$2 RETURNING id',[req.params.id,req.user.school_id]);
  if(!result.rowCount) return res.status(404).json({error:'Event not found.'});
  await audit(getPool(),req,{action:'deleted',entity:'event',entityId:req.params.id});
  res.json({success:true});
}));

router.get('/leave', requirePermission('leave','view'), asyncRoute(async(req,res)=>{
  const ownOnly=!req.user.roles.some((role)=>['school_admin','super_admin','principal'].includes(role));
  const result=await query(`SELECT l.id,l.leave_type,l.start_date,l.end_date,l.reason,l.status,l.notes,l.created_at,
      a.full_name AS applicant_name,a.email AS applicant_email,r.full_name AS reviewed_by
    FROM leave_requests l JOIN users a ON a.id=l.applicant_user_id AND a.school_id=l.school_id
    LEFT JOIN users r ON r.id=l.reviewed_by AND r.school_id=l.school_id
    WHERE l.school_id=$1 AND ($2::boolean=false OR l.applicant_user_id=$3) ORDER BY l.created_at DESC LIMIT 100`,
    [req.user.school_id,ownOnly,req.user.id]);
  res.json({data:result.rows});
}));
router.post('/leave',requirePermission('leave','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({leaveType:z.string().trim().min(2).max(80),startDate:dateValue,endDate:dateValue,reason:z.string().trim().min(4).max(1500)}).refine(v=>v.endDate>=v.startDate,{path:['endDate'],message:'End date must be on or after the start date.'}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the leave request.'});
  const d=parsed.data;
  const result=await query(`INSERT INTO leave_requests (school_id,applicant_user_id,leave_type,start_date,end_date,reason)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,status`,[req.user.school_id,req.user.id,d.leaveType,d.startDate,d.endDate,d.reason]);
  await audit(getPool(),req,{action:'created',entity:'leave_request',entityId:result.rows[0].id});
  res.status(201).json({leaveRequest:result.rows[0]});
}));
router.post('/leave/:id/review',requirePermission('leave','approve'),asyncRoute(async(req,res)=>{
  const parsed=z.object({status:z.enum(['approved','rejected']),notes:optionalText(1000)}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:'Choose whether to approve or reject this leave request.'});
  const result=await query(`UPDATE leave_requests SET status=$1,notes=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now()
    WHERE id=$4 AND school_id=$5 AND status='pending' RETURNING id,applicant_user_id,leave_type,status`,[parsed.data.status,parsed.data.notes,req.user.id,req.params.id,req.user.school_id]);
  if(!result.rowCount) return res.status(404).json({error:'Pending leave request not found.'});
  await query(`INSERT INTO notifications (school_id,user_id,category,title,body) VALUES ($1,$2,'leave_update','Leave request updated',$3)`,[req.user.school_id,result.rows[0].applicant_user_id,`Your ${result.rows[0].leave_type} request was ${result.rows[0].status}.`]);
  await audit(getPool(),req,{action:parsed.data.status,entity:'leave_request',entityId:req.params.id});
  res.json({leaveRequest:result.rows[0]});
}));

router.get('/staff-attendance',requirePermission('attendance','view'),asyncRoute(async(req,res)=>{
  const date=dateValue.safeParse(req.query.date||new Date().toISOString().slice(0,10));
  if(!date.success) return res.status(400).json({error:'Choose a valid attendance date.'});
  const result=await query(`SELECT u.id AS user_id,u.full_name,u.email,COALESCE(t.employee_id,s.employee_id) AS employee_id,
      COALESCE(t.designation,s.designation) AS designation,sa.status,sa.note
    FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.school_id=u.school_id JOIN roles r ON r.id=ur.role_id AND r.school_id=ur.school_id
    LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=u.school_id LEFT JOIN staff s ON s.user_id=u.id AND s.school_id=u.school_id
    LEFT JOIN staff_attendance sa ON sa.user_id=u.id AND sa.school_id=u.school_id AND sa.attendance_date=$2
    WHERE u.school_id=$1 AND u.status='active' AND (r.code IN ('teacher','staff','accountant','librarian','transport_manager','principal'))
    GROUP BY u.id,t.employee_id,s.employee_id,t.designation,s.designation,sa.status,sa.note ORDER BY u.full_name`,[req.user.school_id,date.data]);
  res.json({date:date.data,data:result.rows});
}));
router.post('/staff-attendance',requirePermission('attendance','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({date:dateValue,records:z.array(z.object({userId:uuid,status:z.enum(['present','absent','late','half_day','leave']),note:optionalText(500)})).min(1).max(500)}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:parsed.error.issues[0]?.message||'Review staff attendance.'});
  if(new Set(parsed.data.records.map(r=>r.userId)).size!==parsed.data.records.length) return res.status(400).json({error:'Each staff member can only be marked once.'});
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');
    for(const record of parsed.data.records){
      const valid=await client.query(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.school_id=ur.school_id
        WHERE ur.user_id=$1 AND ur.school_id=$2 AND r.code NOT IN ('student','parent')`,[record.userId,req.user.school_id]);
      if(!valid.rowCount) throw Object.assign(new Error('Invalid staff record'),{status:400,publicMessage:'One or more selected accounts are not staff members.'});
      await client.query(`INSERT INTO staff_attendance (school_id,user_id,attendance_date,status,note,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (school_id,user_id,attendance_date) DO UPDATE
        SET status=EXCLUDED.status,note=EXCLUDED.note,recorded_by=EXCLUDED.recorded_by`,[req.user.school_id,record.userId,parsed.data.date,record.status,record.note,req.user.id]);
    }
    await audit(client,req,{action:'bulk_marked',entity:'staff_attendance',metadata:{date:parsed.data.date,count:parsed.data.records.length}});
    await client.query('COMMIT'); res.json({success:true,saved:parsed.data.records.length});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));

router.get('/portal/profile',asyncRoute(async(req,res)=>{
  let profile=null;
  if(req.user.roles.includes('student')){
    const result=await query(`SELECT s.*,c.name AS class_name,sec.name AS section_name,ay.name AS academic_year_name FROM students s
      LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id LEFT JOIN sections sec ON sec.id=s.current_section_id AND sec.school_id=s.school_id
      LEFT JOIN academic_years ay ON ay.id=s.academic_year_id AND ay.school_id=s.school_id WHERE s.user_id=$1 AND s.school_id=$2 AND s.archived_at IS NULL`,[req.user.id,req.user.school_id]);
    profile=result.rows[0]||null;
  }else if(req.user.roles.includes('teacher')){
    const result=await query(`SELECT t.*,d.name AS department_name FROM teachers t LEFT JOIN departments d ON d.id=t.department_id AND d.school_id=t.school_id WHERE t.user_id=$1 AND t.school_id=$2 AND t.archived_at IS NULL`,[req.user.id,req.user.school_id]);
    profile=result.rows[0]||null;
  }else{
    const result=await query(`SELECT s.*,d.name AS department_name FROM staff s LEFT JOIN departments d ON d.id=s.department_id AND d.school_id=s.school_id WHERE s.user_id=$1 AND s.school_id=$2 AND s.archived_at IS NULL`,[req.user.id,req.user.school_id]);
    profile=result.rows[0]||null;
  }
  res.json({profile});
}));

export default router;
