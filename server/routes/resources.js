import { Router } from 'express';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText } from '../http.js';
import { requirePermission } from '../access.js';

const router = Router();
const uuid = z.string().uuid();
const dateValue = z.string().date();
const money = z.coerce.number().finite().nonnegative().max(99999999.99);

router.get('/library/books',requirePermission('library','view'),asyncRoute(async(req,res)=>{
  const term=String(req.query.q||'').trim().slice(0,100);const values=[req.user.school_id];let filter='';
  if(term){values.push(`%${term}%`);filter=`AND (b.title ILIKE $2 OR b.author ILIKE $2 OR b.isbn ILIKE $2 OR b.category ILIKE $2)`;}
  const result=await query(`SELECT b.id,b.isbn,b.title,b.author,b.publisher,b.category,b.quantity,b.shelf,b.location,b.archived_at,
      (b.quantity-count(lt.id) FILTER(WHERE lt.returned_at IS NULL))::int AS available,
      count(lt.id) FILTER(WHERE lt.returned_at IS NULL)::int AS borrowed,
      count(lt.id) FILTER(WHERE lt.returned_at IS NULL AND lt.due_date<CURRENT_DATE)::int AS overdue
    FROM books b LEFT JOIN library_transactions lt ON lt.book_id=b.id AND lt.school_id=b.school_id
    WHERE b.school_id=$1 AND b.archived_at IS NULL ${filter} GROUP BY b.id ORDER BY b.title LIMIT 200`,values);
  res.json({data:result.rows});
}));

const bookSchema=z.object({isbn:optionalText(30),title:z.string().trim().min(2).max(200),author:optionalText(160),publisher:optionalText(160),category:optionalText(100),quantity:z.coerce.number().int().nonnegative().max(100000).default(1),shelf:optionalText(60),location:optionalText(160)});
router.post('/library/books',requirePermission('library','create'),asyncRoute(async(req,res)=>{
  const parsed=bookSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the book details.'});const d=parsed.data;
  try{const result=await query(`INSERT INTO books (school_id,isbn,title,author,publisher,category,quantity,shelf,location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user.school_id,d.isbn,d.title,d.author,d.publisher,d.category,d.quantity,d.shelf,d.location]);
    await audit(getPool(),req,{action:'created',entity:'book',entityId:result.rows[0].id});res.status(201).json({book:result.rows[0]});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'A book with that ISBN already exists.'});throw error;}
}));
router.patch('/library/books/:id',requirePermission('library','edit'),asyncRoute(async(req,res)=>{
  const parsed=bookSchema.partial().safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the book details.'});
  const columns={isbn:'isbn',title:'title',author:'author',publisher:'publisher',category:'category',quantity:'quantity',shelf:'shelf',location:'location'};const fields=Object.entries(parsed.data);
  if(!fields.length)return res.status(400).json({error:'There are no book changes to save.'});
  const values=[req.params.id,req.user.school_id];const updates=fields.map(([key,value])=>{values.push(value);return `${columns[key]}=$${values.length}`});updates.push('updated_at=now()');
  try{const result=await query(`UPDATE books SET ${updates.join(',')} WHERE id=$1 AND school_id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rowCount)return res.status(404).json({error:'Book not found.'});
    await audit(getPool(),req,{action:'updated',entity:'book',entityId:req.params.id});res.json({book:result.rows[0]});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'A book with that ISBN already exists.'});throw error;}
}));
router.post('/library/issues',requirePermission('library','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({bookId:uuid,studentId:uuid,dueDate:dateValue}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Choose a book, student, and due date.'});const d=parsed.data;
  const client=await getPool().connect();try{await client.query('BEGIN');
    const book=await client.query('SELECT quantity,title FROM books WHERE id=$1 AND school_id=$2 AND archived_at IS NULL FOR UPDATE',[d.bookId,req.user.school_id]);
    if(!book.rowCount)throw Object.assign(new Error('Book not found'),{status:404,publicMessage:'Book not found.'});
    const [borrowed,student]=await Promise.all([
      client.query('SELECT count(*)::int AS count FROM library_transactions WHERE book_id=$1 AND school_id=$2 AND returned_at IS NULL',[d.bookId,req.user.school_id]),
      client.query('SELECT id FROM students WHERE id=$1 AND school_id=$2 AND status=\'active\' AND archived_at IS NULL',[d.studentId,req.user.school_id]),
    ]);
    if(!student.rowCount)throw Object.assign(new Error('Student not found'),{status:404,publicMessage:'Active student not found.'});
    if(borrowed.rows[0].count>=book.rows[0].quantity)throw Object.assign(new Error('No copies available'),{status:409,publicMessage:'There are no available copies of this book right now.'});
    const created=await client.query('INSERT INTO library_transactions (school_id,book_id,student_id,due_date,issued_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',[req.user.school_id,d.bookId,d.studentId,d.dueDate,req.user.id]);
    await audit(client,req,{action:'issued',entity:'library_transaction',entityId:created.rows[0].id,metadata:{bookId:d.bookId,studentId:d.studentId}});
    await client.query('COMMIT');res.status(201).json({transactionId:created.rows[0].id,success:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));
router.get('/library/transactions',requirePermission('library','view'),asyncRoute(async(req,res)=>{
  const onlyOpen=req.query.status==='open';const result=await query(`SELECT lt.id,lt.issued_at,lt.due_date,lt.returned_at,lt.fine,b.title AS book_title,b.isbn,
      s.id AS student_id,s.student_id AS student_code,concat_ws(' ',s.first_name,s.last_name) AS student_name,
      (lt.returned_at IS NULL AND lt.due_date<CURRENT_DATE) AS overdue
    FROM library_transactions lt JOIN books b ON b.id=lt.book_id AND b.school_id=lt.school_id JOIN students s ON s.id=lt.student_id AND s.school_id=lt.school_id
    WHERE lt.school_id=$1 AND ($2::boolean=false OR lt.returned_at IS NULL) ORDER BY lt.returned_at NULLS FIRST,lt.due_date LIMIT 200`,[req.user.school_id,onlyOpen]);
  res.json({data:result.rows});
}));
router.post('/library/transactions/:id/return',requirePermission('library','edit'),asyncRoute(async(req,res)=>{
  const client=await getPool().connect();try{await client.query('BEGIN');
    const transaction=await client.query('SELECT id,due_date,returned_at FROM library_transactions WHERE id=$1 AND school_id=$2 FOR UPDATE',[req.params.id,req.user.school_id]);
    if(!transaction.rowCount)throw Object.assign(new Error('Transaction not found'),{status:404,publicMessage:'Library transaction not found.'});
    if(transaction.rows[0].returned_at)throw Object.assign(new Error('Already returned'),{status:409,publicMessage:'This book has already been returned.'});
    const settings=await client.query('SELECT finance_rules FROM school_settings WHERE school_id=$1',[req.user.school_id]);
    const finePerDay=Number(settings.rows[0]?.finance_rules?.libraryFinePerDay||0);
    const daysLate=Math.max(0,Math.floor((Date.now()-new Date(`${transaction.rows[0].due_date}T00:00:00Z`).getTime())/86400000));
    const fine=(daysLate*finePerDay).toFixed(2);
    await client.query('UPDATE library_transactions SET returned_at=CURRENT_DATE,fine=$1 WHERE id=$2 AND school_id=$3',[fine,req.params.id,req.user.school_id]);
    await audit(client,req,{action:'returned',entity:'library_transaction',entityId:req.params.id,metadata:{fine:Number(fine)}});
    await client.query('COMMIT');res.json({success:true,fine:Number(fine)});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));

router.get('/transport/routes',requirePermission('transport','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT r.id,r.name,r.pickup_time,r.dropoff_time,count(DISTINCT st.student_id)::int AS students,
      COALESCE(json_agg(json_build_object('id',rs.id,'name',rs.name,'order',rs.stop_order,'pickupTime',rs.pickup_time,'dropoffTime',rs.dropoff_time) ORDER BY rs.stop_order) FILTER(WHERE rs.id IS NOT NULL),'[]') AS stops
    FROM routes r LEFT JOIN student_transport st ON st.route_id=r.id AND st.school_id=r.school_id AND (st.end_date IS NULL OR st.end_date>=CURRENT_DATE)
    LEFT JOIN route_stops rs ON rs.route_id=r.id AND rs.school_id=r.school_id WHERE r.school_id=$1 GROUP BY r.id ORDER BY r.name`,[req.user.school_id]);
  res.json({data:result.rows});
}));
router.post('/transport/routes',requirePermission('transport','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({name:z.string().trim().min(2).max(120),pickupTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),dropoffTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),stops:z.array(z.object({name:z.string().trim().min(2).max(120),pickupTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),dropoffTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()})).max(40).optional().default([])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the route details.'});const d=parsed.data;const client=await getPool().connect();
  try{await client.query('BEGIN');const route=await client.query('INSERT INTO routes (school_id,name,pickup_time,dropoff_time) VALUES ($1,$2,$3,$4) RETURNING id',[req.user.school_id,d.name,d.pickupTime,d.dropoffTime]);
    for(let index=0;index<d.stops.length;index++){const stop=d.stops[index];await client.query('INSERT INTO route_stops (school_id,route_id,name,stop_order,pickup_time,dropoff_time) VALUES ($1,$2,$3,$4,$5,$6)',[req.user.school_id,route.rows[0].id,stop.name,index+1,stop.pickupTime,stop.dropoffTime]);}
    await audit(client,req,{action:'created',entity:'route',entityId:route.rows[0].id});await client.query('COMMIT');res.status(201).json({id:route.rows[0].id,success:true});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')return res.status(409).json({error:'A route with that name already exists.'});throw error;}finally{client.release();}
}));
router.get('/transport/vehicles',requirePermission('transport','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT v.id,v.vehicle_number,v.registration,v.vehicle_type,v.capacity,v.status,d.full_name AS driver_name,r.name AS route_name
    FROM vehicles v LEFT JOIN drivers d ON d.id=v.driver_id AND d.school_id=v.school_id LEFT JOIN routes r ON r.id=v.route_id AND r.school_id=v.school_id
    WHERE v.school_id=$1 ORDER BY v.vehicle_number`,[req.user.school_id]);res.json({data:result.rows});
}));
router.post('/transport/vehicles',requirePermission('transport','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({vehicleNumber:z.string().trim().min(1).max(40),registration:optionalText(40),vehicleType:optionalText(80),capacity:z.coerce.number().int().positive().max(200).optional(),driverId:uuid.nullable().optional(),routeId:uuid.nullable().optional(),status:z.enum(['active','maintenance','inactive']).default('active')}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the vehicle details.'});const d=parsed.data;
  try{const result=await query(`INSERT INTO vehicles (school_id,vehicle_number,registration,vehicle_type,capacity,driver_id,route_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[req.user.school_id,d.vehicleNumber,d.registration,d.vehicleType,d.capacity,d.driverId||null,d.routeId||null,d.status]);
    await audit(getPool(),req,{action:'created',entity:'vehicle',entityId:result.rows[0].id});res.status(201).json({vehicle:result.rows[0]});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'That vehicle number is already registered.'});throw error;}
}));
router.post('/transport/drivers',requirePermission('transport','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({fullName:z.string().trim().min(2).max(160),phone:optionalText(40),licenseNumber:z.string().trim().min(3).max(60),status:z.enum(['active','inactive']).default('active')}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Enter a name and license number for the driver.'});
  try{const result=await query('INSERT INTO drivers (school_id,full_name,phone,license_number,status) VALUES ($1,$2,$3,$4,$5) RETURNING *',[req.user.school_id,parsed.data.fullName,parsed.data.phone,parsed.data.licenseNumber,parsed.data.status]);
    await audit(getPool(),req,{action:'created',entity:'driver',entityId:result.rows[0].id});res.status(201).json({driver:result.rows[0]});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'That driver license number is already registered.'});throw error;}
}));

router.get('/inventory',requirePermission('inventory','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT i.id,i.name,i.category,i.quantity,i.purchase_date,i.unit_cost,i.supplier,i.location,i.condition,d.name AS department_name,
      COALESCE(i.unit_cost*i.quantity,0)::numeric AS total_value FROM inventory_items i LEFT JOIN departments d ON d.id=i.department_id AND d.school_id=i.school_id
    WHERE i.school_id=$1 AND i.archived_at IS NULL ORDER BY i.name`,[req.user.school_id]);res.json({data:result.rows});
}));
const inventorySchema=z.object({name:z.string().trim().min(2).max(180),category:optionalText(100),quantity:z.coerce.number().int().nonnegative().max(100000).default(0),purchaseDate:dateValue.nullable().optional(),unitCost:money.nullable().optional(),supplier:optionalText(160),location:optionalText(160),condition:optionalText(80),departmentId:uuid.nullable().optional()});
router.post('/inventory',requirePermission('inventory','create'),asyncRoute(async(req,res)=>{
  const parsed=inventorySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the inventory item.'});const d=parsed.data;const client=await getPool().connect();
  try{await client.query('BEGIN');const result=await client.query(`INSERT INTO inventory_items (school_id,name,category,quantity,purchase_date,unit_cost,supplier,location,condition,department_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user.school_id,d.name,d.category,d.quantity,d.purchaseDate||null,d.unitCost==null?null:Number(d.unitCost).toFixed(2),d.supplier,d.location,d.condition,d.departmentId||null]);
    if(d.quantity>0)await client.query(`INSERT INTO inventory_transactions (school_id,item_id,transaction_type,quantity,to_location,notes,performed_by) VALUES ($1,$2,'purchase',$3,$4,'Initial stock', $5)`,[req.user.school_id,result.rows[0].id,d.quantity,d.location,req.user.id]);
    await audit(client,req,{action:'created',entity:'inventory_item',entityId:result.rows[0].id});await client.query('COMMIT');res.status(201).json({item:result.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));
router.post('/inventory/:id/transactions',requirePermission('inventory','edit'),asyncRoute(async(req,res)=>{
  const parsed=z.object({type:z.enum(['purchase','issue','return','transfer','disposal']),quantity:z.coerce.number().int().positive().max(100000),fromLocation:optionalText(160),toLocation:optionalText(160),notes:optionalText(500)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the stock transaction.'});const d=parsed.data;const client=await getPool().connect();
  try{await client.query('BEGIN');const item=await client.query('SELECT id,quantity FROM inventory_items WHERE id=$1 AND school_id=$2 AND archived_at IS NULL FOR UPDATE',[req.params.id,req.user.school_id]);
    if(!item.rowCount)throw Object.assign(new Error('Item not found'),{status:404,publicMessage:'Inventory item not found.'});
    const delta=['purchase','return'].includes(d.type)?d.quantity:['issue','disposal'].includes(d.type)?-d.quantity:0;
    const next=Number(item.rows[0].quantity)+delta;if(next<0)throw Object.assign(new Error('Insufficient quantity'),{status:409,publicMessage:'There is not enough stock for that transaction.'});
    await client.query('UPDATE inventory_items SET quantity=$1,updated_at=now() WHERE id=$2 AND school_id=$3',[next,req.params.id,req.user.school_id]);
    const tx=await client.query(`INSERT INTO inventory_transactions (school_id,item_id,transaction_type,quantity,from_location,to_location,notes,performed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[req.user.school_id,req.params.id,d.type,d.quantity,d.fromLocation,d.toLocation,d.notes,req.user.id]);
    await audit(client,req,{action:d.type,entity:'inventory_item',entityId:req.params.id,metadata:{quantity:d.quantity,transactionId:tx.rows[0].id}});await client.query('COMMIT');res.json({success:true,quantity:next});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}));
router.get('/inventory/:id/transactions',requirePermission('inventory','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT id,transaction_type,quantity,from_location,to_location,notes,created_at FROM inventory_transactions WHERE item_id=$1 AND school_id=$2 ORDER BY created_at DESC LIMIT 100`,[req.params.id,req.user.school_id]);res.json({data:result.rows});
}));

router.get('/discipline',requirePermission('discipline','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT d.id,d.incident_date,d.incident,d.description,d.severity,d.action_taken,d.follow_up_date,
      s.id AS student_id,s.student_id AS student_code,concat_ws(' ',s.first_name,s.last_name) AS student_name,c.name AS class_name,u.full_name AS recorded_by
    FROM discipline_records d JOIN students s ON s.id=d.student_id AND s.school_id=d.school_id LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
    LEFT JOIN users u ON u.id=d.recorded_by AND u.school_id=d.school_id WHERE d.school_id=$1 ORDER BY d.incident_date DESC LIMIT 200`,[req.user.school_id]);res.json({data:result.rows});
}));
router.post('/discipline',requirePermission('discipline','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({studentId:uuid,incidentDate:dateValue.optional(),incident:z.string().trim().min(2).max(180),description:optionalText(2000),severity:z.enum(['low','medium','high','critical']).default('low'),actionTaken:optionalText(1000),notes:optionalText(1000),followUpDate:dateValue.nullable().optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the incident details.'});const d=parsed.data;
  const result=await query(`INSERT INTO discipline_records (school_id,student_id,incident_date,incident,description,severity,action_taken,notes,follow_up_date,recorded_by)
    SELECT $1,s.id,COALESCE($3::date,CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10 FROM students s WHERE s.id=$2 AND s.school_id=$1 AND s.archived_at IS NULL RETURNING id`,[req.user.school_id,d.studentId,d.incidentDate||null,d.incident,d.description,d.severity,d.actionTaken,d.notes,d.followUpDate||null,req.user.id]);
  if(!result.rowCount)return res.status(404).json({error:'Student not found.'});await audit(getPool(),req,{action:'created',entity:'discipline_record',entityId:result.rows[0].id});res.status(201).json({id:result.rows[0].id,success:true});
}));

router.get('/transport/students',requirePermission('transport','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT st.id,st.monthly_fee,st.pickup_stop_id,st.dropoff_stop_id,r.name AS route_name,s.id AS student_id,s.student_id AS student_code,concat_ws(' ',s.first_name,s.last_name) AS student_name
    FROM student_transport st JOIN routes r ON r.id=st.route_id AND r.school_id=st.school_id JOIN students s ON s.id=st.student_id AND s.school_id=st.school_id
    WHERE st.school_id=$1 AND (st.end_date IS NULL OR st.end_date>=CURRENT_DATE) ORDER BY s.last_name`,[req.user.school_id]);res.json({data:result.rows});
}));
router.post('/transport/students',requirePermission('transport','create'),asyncRoute(async(req,res)=>{
  const parsed=z.object({studentId:uuid,routeId:uuid,pickupStopId:uuid.nullable().optional(),dropoffStopId:uuid.nullable().optional(),monthlyFee:money,startDate:dateValue.optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Choose a student and route, and enter a valid monthly fee.'});const d=parsed.data;
  const result=await query(`INSERT INTO student_transport (school_id,student_id,route_id,pickup_stop_id,dropoff_stop_id,monthly_fee,start_date)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE)) RETURNING id`,[req.user.school_id,d.studentId,d.routeId,d.pickupStopId||null,d.dropoffStopId||null,Number(d.monthlyFee).toFixed(2),d.startDate||null]);
  await audit(getPool(),req,{action:'assigned',entity:'student_transport',entityId:result.rows[0].id});res.status(201).json({success:true,id:result.rows[0].id});
}));

export default router;
