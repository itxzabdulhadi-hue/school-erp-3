import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, query } from '../db.js';
import { getStorageDir } from '../config.js';
import { audit, asyncRoute, optionalText } from '../http.js';
import { requirePermission } from '../access.js';

export const brandingUploadsDir = path.join(getStorageDir(), 'public', 'branding');
const privateUploadsDir = path.join(getStorageDir(), 'private');
const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!['image/png','image/jpeg','image/webp','application/pdf'].includes(file.mimetype)) {
      return callback(new Error('This file type is not supported. Upload a PNG, JPEG, WebP image, or PDF.'));
    }
    callback(null, true);
  },
});

router.post('/upload/branding', requirePermission('settings','edit'), upload.single('file'), asyncRoute(async (req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a PNG, JPEG, or WebP image to upload.'});
  const type=detectType(req.file.buffer);
  if(!type||type.kind!=='image')return res.status(400).json({error:'That image could not be verified. Upload a PNG, JPEG, or WebP image.'});
  await fs.mkdir(brandingUploadsDir,{recursive:true,mode:0o700});
  const name=`${randomUUID()}.${type.extension}`;
  await fs.writeFile(path.join(brandingUploadsDir,name),req.file.buffer,{flag:'wx',mode:0o644});
  const url=`/uploads/branding/${name}`;
  await audit(getPool(),req,{action:'uploaded',entity:'school_branding',metadata:{mimeType:type.mimeType,sizeBytes:req.file.size}});
  res.status(201).json({url,mimeType:type.mimeType,sizeBytes:req.file.size});
}));

router.get('/documents',requirePermission('documents','view'),asyncRoute(async(req,res)=>{
  const ownerType=String(req.query.ownerType||'').trim();
  const ownerId=String(req.query.ownerId||'').trim();
  const values=[req.user.school_id];let filter='';
  if(['student','teacher','staff','class','school'].includes(ownerType)){values.push(ownerType);filter+=` AND d.owner_type=$${values.length}`;}
  if(ownerId){values.push(ownerId);filter+=` AND d.owner_id=$${values.length}`;}
  const result=await query(`SELECT d.id,d.owner_type,d.owner_id,d.name,d.file_name,d.mime_type,d.size_bytes,d.description,d.created_at,u.full_name AS uploaded_by
    FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by AND u.school_id=d.school_id WHERE d.school_id=$1 ${filter} ORDER BY d.created_at DESC LIMIT 200`,values);
  res.json({data:result.rows});
}));

router.post('/documents',requirePermission('documents','create'),upload.single('file'),asyncRoute(async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a file to upload.'});
  const schema=z.object({ownerType:z.enum(['student','teacher','staff','class','school']),ownerId:z.preprocess(v=>v===''?undefined:v,z.string().uuid().optional()),name:z.string().trim().min(2).max(180),description:optionalText(1000)});
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Review the document details.'});
  const kind=detectType(req.file.buffer);
  if(!kind)return res.status(400).json({error:'File contents did not match an allowed PDF or image type.'});
  if(parsed.data.ownerType!=='school'&&!parsed.data.ownerId)return res.status(400).json({error:'Select the record this document belongs to.'});
  const tables={student:['students','id'],teacher:['teachers','id'],staff:['staff','id'],class:['classes','id']};
  const owner=parsed.data.ownerType==='school'?{rowCount:1}:await query(`SELECT id FROM ${tables[parsed.data.ownerType][0]} WHERE id=$1 AND school_id=$2 AND archived_at IS NULL`,[parsed.data.ownerId,req.user.school_id]);
  if(!owner.rowCount)return res.status(404).json({error:'The selected record was not found.'});
  const folder=path.join(privateUploadsDir,req.user.school_id);
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const fileName=`${randomUUID()}.${kind.extension}`;
  const fullPath=path.join(folder,fileName);
  await fs.writeFile(fullPath,req.file.buffer,{flag:'wx',mode:0o600});
  const storageKey=path.posix.join('private',req.user.school_id,fileName);
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');
    const result=await client.query(`INSERT INTO documents (school_id,owner_type,owner_id,name,file_name,mime_type,size_bytes,storage_key,description,uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,mime_type,size_bytes,created_at`,
      [req.user.school_id,parsed.data.ownerType,parsed.data.ownerId||null,parsed.data.name,req.file.originalname.replace(/[\\/\r\n]/g,'_').slice(0,180),kind.mimeType,req.file.size,storageKey,parsed.data.description,req.user.id]);
    await audit(client,req,{action:'uploaded',entity:'document',entityId:result.rows[0].id,metadata:{ownerType:parsed.data.ownerType,sizeBytes:req.file.size}});
    await client.query('COMMIT');res.status(201).json({document:result.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});await fs.unlink(fullPath).catch(()=>{});throw error;}finally{client.release();}
}));

router.get('/documents/:id/download',requirePermission('documents','view'),asyncRoute(async(req,res)=>{
  const result=await query(`SELECT file_name,mime_type,storage_key FROM documents WHERE id=$1 AND school_id=$2`,[req.params.id,req.user.school_id]);
  if(!result.rowCount)return res.status(404).json({error:'Document not found.'});
  const safeKey=path.normalize(result.rows[0].storage_key);
  const root=path.resolve(privateUploadsDir);
  const target=path.resolve(getStorageDir(),safeKey);
  if(!target.startsWith(`${root}${path.sep}`))return res.status(400).json({error:'Invalid document path.'});
  try{await fs.access(target);}catch{return res.status(404).json({error:'The stored document could not be found.'});}
  const name=String(result.rows[0].file_name).replace(/[\r\n"\\]/g,'_');
  res.setHeader('Content-Type',result.rows[0].mime_type);
  res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.sendFile(target);
}));

router.delete('/documents/:id',requirePermission('documents','delete'),asyncRoute(async(req,res)=>{
  const result=await query('DELETE FROM documents WHERE id=$1 AND school_id=$2 RETURNING storage_key',[req.params.id,req.user.school_id]);
  if(!result.rowCount)return res.status(404).json({error:'Document not found.'});
  await fs.unlink(path.resolve(getStorageDir(),result.rows[0].storage_key)).catch(()=>{});
  await audit(getPool(),req,{action:'deleted',entity:'document',entityId:req.params.id});
  res.json({success:true});
}));

function detectType(buffer){
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return{kind:'image',mimeType:'image/png',extension:'png'};
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return{kind:'image',mimeType:'image/jpeg',extension:'jpg'};
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return{kind:'image',mimeType:'image/webp',extension:'webp'};
  if(buffer.length>=5&&buffer.toString('ascii',0,5)==='%PDF-')return{kind:'document',mimeType:'application/pdf',extension:'pdf'};
  return null;
}

export default router;
export { router as uploadRoutes };
