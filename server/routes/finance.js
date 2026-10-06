import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { audit, asyncRoute, optionalText, pagination } from '../http.js';
import { requirePermission } from '../access.js';

const router = Router();
const uuid = z.string().uuid();
const dateValue = z.string().date();
const money = z.coerce.number().finite().nonnegative().max(99999999.99);
const receiptCode = (prefix) => `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

router.get('/finance/summary', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const [summary, daily, monthly, overdue, methods] = await Promise.all([
    query(
      `SELECT
        (SELECT COALESCE(sum(amount),0) FROM payments WHERE school_id=$1 AND payment_date::date=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))::date)::numeric AS today_collection,
        (SELECT COALESCE(sum(amount),0) FROM payments WHERE school_id=$1 AND date_trunc('month',payment_date AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))=date_trunc('month',now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1)))::numeric AS month_collection,
        (SELECT COALESCE(sum(amount),0) FROM payments WHERE school_id=$1 AND date_trunc('year',payment_date AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1))=date_trunc('year',now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1)))::numeric AS year_collection,
        (SELECT COALESCE(sum(total-paid),0) FROM invoices WHERE school_id=$1 AND status NOT IN ('paid','void','draft'))::numeric AS outstanding,
        (SELECT COALESCE(sum(total-paid),0) FROM invoices WHERE school_id=$1 AND due_date<CURRENT_DATE AND paid<total AND status<>'void')::numeric AS overdue,
        (SELECT COALESCE(sum(discount),0) FROM invoices WHERE school_id=$1 AND status<>'void')::numeric AS discounts,
        (SELECT COALESCE(sum(fine),0) FROM invoices WHERE school_id=$1 AND status<>'void')::numeric AS fines`,
      [req.user.school_id],
    ),
    query(`SELECT date_trunc('day',payment_date)::date AS date,sum(amount)::numeric AS total,count(*)::int AS payments FROM payments WHERE school_id=$1 AND payment_date>=CURRENT_DATE-INTERVAL '29 days' GROUP BY date_trunc('day',payment_date) ORDER BY date`, [req.user.school_id]),
    query(`SELECT date_trunc('month',payment_date)::date AS month,sum(amount)::numeric AS total FROM payments WHERE school_id=$1 AND payment_date>=date_trunc('month',CURRENT_DATE)-INTERVAL '11 months' GROUP BY date_trunc('month',payment_date) ORDER BY month`, [req.user.school_id]),
    query(`SELECT i.id,i.invoice_number,i.due_date,i.total,i.paid,i.total-i.paid AS balance,
            concat_ws(' ',s.first_name,s.last_name) AS student_name,s.student_id AS student_code,c.name AS class_name
           FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
           LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
           WHERE i.school_id=$1 AND i.status<>'void' AND i.due_date<CURRENT_DATE AND i.paid<i.total ORDER BY i.due_date LIMIT 12`, [req.user.school_id]),
    query(`SELECT method,sum(amount)::numeric AS total,count(*)::int AS count FROM payments WHERE school_id=$1 AND payment_date>=date_trunc('month',CURRENT_DATE) GROUP BY method ORDER BY total DESC`, [req.user.school_id]),
  ]);
  res.json({ summary: summary.rows[0], daily: daily.rows, monthly: monthly.rows, overdue: overdue.rows, methods: methods.rows });
}));

router.get('/finance/fee-types', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const result = await query('SELECT id,name,code,description,is_recurring FROM fee_types WHERE school_id=$1 AND archived_at IS NULL ORDER BY name', [req.user.school_id]);
  res.json({ data: result.rows });
}));

router.post('/finance/fee-types', requirePermission('finance', 'create'), asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100), code: optionalText(30), description: optionalText(500), isRecurring: z.boolean().optional().default(false) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter a fee name.' });
  try {
    const result = await query(`INSERT INTO fee_types (school_id,name,code,description,is_recurring) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.school_id,parsed.data.name,parsed.data.code?.toUpperCase(),parsed.data.description,parsed.data.isRecurring]);
    await audit(getPool(), req, { action: 'created', entity: 'fee_type', entityId: result.rows[0].id });
    res.status(201).json({ feeType: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A fee type with that name already exists.' });
    throw error;
  }
}));

router.get('/finance/fee-structures', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const result = await query(`SELECT fs.id,fs.amount,fs.due_date,ay.name AS academic_year_name,c.name AS class_name,ft.name AS fee_name
    FROM fee_structures fs JOIN academic_years ay ON ay.id=fs.academic_year_id AND ay.school_id=fs.school_id
    LEFT JOIN classes c ON c.id=fs.class_id AND c.school_id=fs.school_id JOIN fee_types ft ON ft.id=fs.fee_type_id AND ft.school_id=fs.school_id
    WHERE fs.school_id=$1 ORDER BY ay.start_date DESC,c.grade_level NULLS LAST,ft.name`, [req.user.school_id]);
  res.json({ data: result.rows });
}));
router.post('/finance/fee-structures', requirePermission('finance', 'create'), asyncRoute(async (req, res) => {
  const parsed = z.object({ feeTypeId: uuid, academicYearId: uuid, classId: uuid.nullable().optional(), amount: money, dueDate: dateValue.nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid fee, academic year, and amount.' });
  const data = parsed.data;
  const result = await query(`INSERT INTO fee_structures (school_id,fee_type_id,academic_year_id,class_id,amount,due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.school_id,data.feeTypeId,data.academicYearId,data.classId||null,Number(data.amount).toFixed(2),data.dueDate||null]);
  await audit(getPool(), req, { action: 'created', entity: 'fee_structure', entityId: result.rows[0].id });
  res.status(201).json({ feeStructure: result.rows[0] });
}));

router.get('/finance/invoices', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const { limit, offset, page } = pagination(req.query, { limit: 25, maxLimit: 100 });
  const term = String(req.query.q || '').trim().slice(0, 100);
  const status = String(req.query.status || '').trim();
  const values = [req.user.school_id];
  const filters = ["i.archived_at IS NULL"];
  if (term) { values.push(`%${term}%`); filters.push(`(i.invoice_number ILIKE $${values.length} OR s.first_name ILIKE $${values.length} OR s.last_name ILIKE $${values.length} OR s.admission_number ILIKE $${values.length})`); }
  if (status && ['draft','unpaid','partial','paid','overdue','void'].includes(status)) { values.push(status); filters.push(`i.status=$${values.length}`); }
  const where = `i.school_id=$1 AND ${filters.join(' AND ')}`;
  const count = await query(`SELECT count(*)::int AS total FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id WHERE ${where}`, values);
  const result = await query(
    `SELECT i.id,i.invoice_number,i.issue_date,i.due_date,i.subtotal,i.discount,i.fine,i.total,i.paid,i.total-i.paid AS balance,i.status,
            i.currency,concat_ws(' ',s.first_name,s.last_name) AS student_name,s.student_id AS student_code,
            s.admission_number,c.name AS class_name,
            COALESCE(json_agg(json_build_object('id',ii.id,'description',ii.description,'quantity',ii.quantity,'unitAmount',ii.unit_amount,'amount',ii.amount)
              ORDER BY ii.created_at) FILTER (WHERE ii.id IS NOT NULL),'[]') AS items
     FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
     LEFT JOIN invoice_items ii ON ii.invoice_id=i.id AND ii.school_id=i.school_id
     WHERE ${where} GROUP BY i.id,s.id,c.name ORDER BY i.created_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,limit,offset],
  );
  res.json({ data: result.rows, total: count.rows[0].total, page, pageSize: limit });
}));

const invoiceSchema = z.object({
  studentId: uuid,
  academicYearId: uuid.nullable().optional(),
  issueDate: dateValue.optional(),
  dueDate: dateValue.nullable().optional(),
  discount: money.optional().default(0),
  fine: money.optional().default(0),
  notes: optionalText(1000),
  items: z.array(z.object({ feeTypeId: uuid.nullable().optional(), description: z.string().trim().min(2).max(180), quantity: z.coerce.number().positive().max(10000).default(1), unitAmount: money })).min(1).max(30),
});

router.post('/finance/invoices', requirePermission('finance', 'create'), asyncRoute(async (req, res) => {
  const parsed = invoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the invoice details.' });
  const data = parsed.data;
  const subtotalCents = data.items.reduce((total,item) => total + Math.round(Number(item.quantity) * Number(item.unitAmount) * 100),0);
  const discountCents = Math.round(Number(data.discount)*100);
  const fineCents = Math.round(Number(data.fine)*100);
  if (discountCents > subtotalCents) return res.status(400).json({ error: 'Discount cannot be greater than the invoice subtotal.' });
  const totalCents = subtotalCents - discountCents + fineCents;
  if (totalCents <= 0) return res.status(400).json({ error: 'Invoice total must be greater than zero.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const student = await client.query('SELECT id FROM students WHERE id=$1 AND school_id=$2 AND archived_at IS NULL', [data.studentId,req.user.school_id]);
    if (!student.rowCount) throw Object.assign(new Error('Student not found'), { status: 404, publicMessage: 'Student not found.' });
    const school = await client.query('SELECT currency FROM schools WHERE id=$1', [req.user.school_id]);
    const invoiceNumber = receiptCode('INV');
    const created = await client.query(
      `INSERT INTO invoices (school_id,invoice_number,student_id,academic_year_id,issue_date,due_date,subtotal,discount,fine,total,paid,status,notes,created_by,currency)
       VALUES ($1,$2,$3,COALESCE($4,(SELECT id FROM academic_years WHERE school_id=$1 AND is_current=true)),$5,$6,$7,$8,$9,$10,0,'unpaid',$11,$12,$13)
       RETURNING id,invoice_number`,
      [req.user.school_id,invoiceNumber,data.studentId,data.academicYearId||null,data.issueDate||new Date().toISOString().slice(0,10),data.dueDate||null,
        (subtotalCents/100).toFixed(2),(discountCents/100).toFixed(2),(fineCents/100).toFixed(2),(totalCents/100).toFixed(2),data.notes,req.user.id,school.rows[0].currency],
    );
    const invoice = created.rows[0];
    for (const item of data.items) {
      const amountCents = Math.round(Number(item.quantity)*Number(item.unitAmount)*100);
      await client.query(
        `INSERT INTO invoice_items (school_id,invoice_id,fee_type_id,description,quantity,unit_amount,amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.school_id,invoice.id,item.feeTypeId||null,item.description,Number(item.quantity),Number(item.unitAmount).toFixed(2),(amountCents/100).toFixed(2)],
      );
    }
    await audit(client, req, { action: 'created', entity: 'invoice', entityId: invoice.id, metadata: { invoiceNumber, total: totalCents/100, studentId: data.studentId } });
    await client.query('COMMIT');
    res.status(201).json({ invoice: { id: invoice.id, invoiceNumber: invoice.invoice_number, total: totalCents/100 } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.get('/finance/payments', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const { limit, offset, page } = pagination(req.query, { limit: 30, maxLimit: 100 });
  const term = String(req.query.q || '').trim().slice(0,100);
  const values = [req.user.school_id];
  let filter = '';
  if (term) { values.push(`%${term}%`); filter = `AND (p.receipt_number ILIKE $2 OR i.invoice_number ILIKE $2 OR s.first_name ILIKE $2 OR s.last_name ILIKE $2)`; }
  const [count,result] = await Promise.all([
    query(`SELECT count(*)::int AS total FROM payments p JOIN students s ON s.id=p.student_id AND s.school_id=p.school_id JOIN invoices i ON i.id=p.invoice_id AND i.school_id=p.school_id WHERE p.school_id=$1 ${filter}`,values),
    query(`SELECT p.id,p.receipt_number,p.amount,p.method,p.reference,p.notes,p.payment_date,
            i.invoice_number,i.total AS invoice_total,i.paid AS invoice_paid,i.total-i.paid AS remaining,
            s.id AS student_id,s.student_id AS student_code,concat_ws(' ',s.first_name,s.last_name) AS student_name,
            u.full_name AS received_by
           FROM payments p JOIN invoices i ON i.id=p.invoice_id AND i.school_id=p.school_id
           JOIN students s ON s.id=p.student_id AND s.school_id=p.school_id
           LEFT JOIN users u ON u.id=p.received_by AND u.school_id=p.school_id
           WHERE p.school_id=$1 ${filter} ORDER BY p.payment_date DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values,limit,offset]),
  ]);
  res.json({ data: result.rows, total: count.rows[0].total, page, pageSize: limit });
}));

const paymentSchema = z.object({
  invoiceId: uuid,
  amount: z.coerce.number().positive().max(99999999.99),
  method: z.enum(['cash','bank_transfer','card','online','other']),
  paymentDate: z.string().datetime().optional(),
  reference: optionalText(120),
  notes: optionalText(500),
});
router.post('/finance/payments', requirePermission('finance', 'create'), asyncRoute(async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the payment details.' });
  const data = parsed.data;
  const amountCents = Math.round(Number(data.amount)*100);
  if (amountCents <= 0) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const invoice = await client.query('SELECT * FROM invoices WHERE id=$1 AND school_id=$2 AND archived_at IS NULL FOR UPDATE', [data.invoiceId,req.user.school_id]);
    if (!invoice.rowCount) throw Object.assign(new Error('Invoice not found'), { status: 404, publicMessage: 'Invoice not found.' });
    const record = invoice.rows[0];
    if (record.status === 'void' || record.status === 'draft') throw Object.assign(new Error('Invoice not payable'), { status: 400, publicMessage: 'This invoice is not available for payment.' });
    const balanceCents = Math.round((Number(record.total)-Number(record.paid))*100);
    if (amountCents > balanceCents) throw Object.assign(new Error('Payment over balance'), { status: 400, publicMessage: `This invoice has a remaining balance of ${record.currency} ${(balanceCents/100).toFixed(2)}.` });
    const receiptNumber = receiptCode('RCT');
    const created = await client.query(
      `INSERT INTO payments (school_id,receipt_number,invoice_id,student_id,amount,payment_date,method,reference,notes,received_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()),$7,$8,$9,$10) RETURNING id,receipt_number,amount,payment_date`,
      [req.user.school_id,receiptNumber,record.id,record.student_id,(amountCents/100).toFixed(2),data.paymentDate||null,data.method,data.reference,data.notes,req.user.id],
    );
    const nextPaidCents = Math.round(Number(record.paid)*100)+amountCents;
    const nextStatus = nextPaidCents >= Math.round(Number(record.total)*100) ? 'paid' : (record.due_date && new Date(`${record.due_date}T23:59:59Z`) < new Date() ? 'overdue' : 'partial');
    await client.query('UPDATE invoices SET paid=$1,status=$2,updated_at=now() WHERE id=$3 AND school_id=$4', [(nextPaidCents/100).toFixed(2),nextStatus,record.id,req.user.school_id]);
    const studentUser = await client.query('SELECT user_id FROM students WHERE id=$1 AND school_id=$2', [record.student_id,req.user.school_id]);
    if (studentUser.rows[0]?.user_id) {
      await client.query(`INSERT INTO notifications (school_id,user_id,category,title,body,link) VALUES ($1,$2,'fee_payment','Payment received',$3,$4)`,
        [req.user.school_id,studentUser.rows[0].user_id,`Payment of ${record.currency} ${(amountCents/100).toFixed(2)} recorded for invoice ${record.invoice_number}.`,`/finance/receipts/${created.rows[0].id}`]);
    }
    await audit(client, req, { action: 'payment_recorded', entity: 'payment', entityId: created.rows[0].id, metadata: { receiptNumber, invoiceId: record.id, amount: amountCents/100, method: data.method } });
    await client.query('COMMIT');
    res.status(201).json({ payment: { ...created.rows[0], remaining: (balanceCents-amountCents)/100, status: nextStatus } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

router.get('/finance/receipts/:id', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT p.id,p.receipt_number,p.amount,p.method,p.reference,p.notes,p.payment_date,
            i.invoice_number,i.total AS invoice_total,i.paid AS invoice_paid,i.total-i.paid AS remaining,i.currency,
            s.id AS student_id,s.student_id AS student_code,s.admission_number,concat_ws(' ',s.first_name,s.middle_name,s.last_name) AS student_name,
            c.name AS class_name,sec.name AS section_name,sch.name AS school_name,sch.logo_url,sch.address,sch.city,sch.country,sch.phone,sch.email,sch.website
     FROM payments p JOIN invoices i ON i.id=p.invoice_id AND i.school_id=p.school_id
     JOIN students s ON s.id=p.student_id AND s.school_id=p.school_id
     LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id
     LEFT JOIN sections sec ON sec.id=s.current_section_id AND sec.school_id=s.school_id
     JOIN schools sch ON sch.id=p.school_id WHERE p.id=$1 AND p.school_id=$2`,
    [req.params.id,req.user.school_id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Receipt not found.' });
  res.json({ receipt: result.rows[0] });
}));

router.get('/finance/invoices/:id', requirePermission('finance', 'view'), asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT i.*,s.student_id AS student_code,s.admission_number,concat_ws(' ',s.first_name,s.middle_name,s.last_name) AS student_name,
            c.name AS class_name,sec.name AS section_name,sch.name AS school_name,sch.logo_url,sch.address,sch.city,sch.country,sch.phone,sch.email,sch.website,
            COALESCE((SELECT json_agg(json_build_object('id',ii.id,'description',ii.description,'quantity',ii.quantity,'unitAmount',ii.unit_amount,'amount',ii.amount) ORDER BY ii.created_at) FROM invoice_items ii WHERE ii.invoice_id=i.id AND ii.school_id=i.school_id),'[]') AS items,
            COALESCE((SELECT json_agg(json_build_object('id',p.id,'receiptNumber',p.receipt_number,'amount',p.amount,'method',p.method,'paymentDate',p.payment_date) ORDER BY p.payment_date DESC) FROM payments p WHERE p.invoice_id=i.id AND p.school_id=i.school_id),'[]') AS payments
     FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id JOIN schools sch ON sch.id=i.school_id
     LEFT JOIN classes c ON c.id=s.current_class_id AND c.school_id=s.school_id LEFT JOIN sections sec ON sec.id=s.current_section_id AND sec.school_id=s.school_id
     WHERE i.id=$1 AND i.school_id=$2`, [req.params.id,req.user.school_id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ invoice: result.rows[0] });
}));

router.post('/finance/invoices/:id/void', requirePermission('finance', 'approve'), asyncRoute(async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const invoice = await client.query('SELECT id,status,paid FROM invoices WHERE id=$1 AND school_id=$2 FOR UPDATE', [req.params.id,req.user.school_id]);
    if (!invoice.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found.' }); }
    if (Number(invoice.rows[0].paid) > 0) throw Object.assign(new Error('Invoice has payments'), { status: 409, publicMessage: 'An invoice with recorded payments cannot be voided. Contact your finance administrator.' });
    await client.query("UPDATE invoices SET status='void',updated_at=now() WHERE id=$1 AND school_id=$2", [req.params.id,req.user.school_id]);
    await audit(client, req, { action: 'voided', entity: 'invoice', entityId: req.params.id });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

export default router;
