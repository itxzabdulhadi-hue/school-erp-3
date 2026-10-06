import { query } from './db.js';

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];
export const MODULES = [
  'dashboard', 'students', 'teachers', 'staff', 'classes', 'subjects', 'attendance', 'exams',
  'finance', 'assignments', 'study_materials', 'announcements', 'events', 'library', 'transport',
  'inventory', 'discipline', 'documents', 'certificates', 'reports', 'settings', 'users',
  'communications', 'audit', 'leave',
];

const CRUD = ['view', 'create', 'edit', 'delete', 'export'];
const permissionsFor = (role) => {
  const map = {
    school_admin: MODULES.flatMap((module) => ACTIONS.map((action) => `${module}.${action}`)),
    super_admin: MODULES.flatMap((module) => ACTIONS.map((action) => `${module}.${action}`)),
    principal: [
      'dashboard.view', 'students.view', 'students.create', 'students.edit', 'students.export',
      'teachers.view', 'staff.view', 'classes.view', 'subjects.view', 'attendance.view', 'attendance.create',
      'attendance.edit', 'attendance.export', 'exams.view', 'exams.create', 'exams.edit', 'exams.approve',
      'assignments.view', 'announcements.view', 'announcements.create', 'announcements.edit',
      'events.view', 'events.create', 'reports.view', 'reports.export', 'discipline.view', 'discipline.create',
      'leave.view', 'leave.approve', 'settings.view',
    ],
    accountant: [
      'dashboard.view', 'students.view', 'finance.view', 'finance.create', 'finance.edit', 'finance.export',
      'reports.view', 'reports.export', 'announcements.view',
    ],
    teacher: [
      'dashboard.view', 'students.view', 'classes.view', 'subjects.view', 'attendance.view', 'attendance.create',
      'attendance.edit', 'exams.view', 'exams.create', 'exams.edit', 'assignments.view', 'assignments.create',
      'assignments.edit', 'assignments.delete', 'study_materials.view', 'study_materials.create',
      'study_materials.edit', 'study_materials.delete', 'announcements.view', 'events.view', 'reports.view',
      'leave.view', 'leave.create', 'settings.view',
    ],
    student: [
      'dashboard.view', 'attendance.view', 'exams.view', 'assignments.view', 'assignments.create',
      'study_materials.view', 'announcements.view', 'events.view', 'finance.view', 'leave.view', 'leave.create',
    ],
    parent: [
      'dashboard.view', 'students.view', 'attendance.view', 'exams.view', 'assignments.view',
      'study_materials.view', 'announcements.view', 'events.view', 'finance.view', 'communications.view',
    ],
    staff: ['dashboard.view', 'attendance.view', 'leave.view', 'leave.create', 'announcements.view', 'events.view'],
    librarian: ['dashboard.view', 'students.view', 'library.view', 'library.create', 'library.edit', 'library.delete', 'reports.view'],
    transport_manager: ['dashboard.view', 'students.view', 'transport.view', 'transport.create', 'transport.edit', 'transport.delete', 'reports.view'],
  };
  return map[role] || [];
};

export async function seedRolesAndPermissions(client, schoolId) {
  const permissionRows = MODULES.flatMap((module) => ACTIONS.map((action) => ({
    code: `${module}.${action}`,
    module,
    action,
  })));
  for (const permission of permissionRows) {
    await client.query(
      `INSERT INTO permissions (code, module, action) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [permission.code, permission.module, permission.action],
    );
  }
  const roleDefs = [
    ['school_admin', 'School Administrator', 'Full school-level administrative access'],
    ['principal', 'Principal', 'Academic and school leadership access'],
    ['accountant', 'Accountant', 'Finance and fee management access'],
    ['teacher', 'Teacher', 'Assigned classes, attendance, learning and results'],
    ['student', 'Student', 'Own learning, attendance, results and fee information'],
    ['parent', 'Parent / Guardian', 'Linked children and school communication'],
    ['staff', 'Staff', 'Personal attendance, leave and school notices'],
    ['librarian', 'Librarian', 'Library circulation and catalog'],
    ['transport_manager', 'Transport Manager', 'Vehicles, routes and student transport'],
    ['super_admin', 'Platform Administrator', 'Platform-level administration'],
  ];
  const roleIds = new Map();
  for (const [code, label, description] of roleDefs) {
    const result = await client.query(
      `INSERT INTO roles (school_id, code, label, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, code) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [schoolId, code, label, description],
    );
    roleIds.set(code, result.rows[0].id);
  }
  const permissions = await client.query('SELECT id, code FROM permissions');
  const permissionIds = new Map(permissions.rows.map((row) => [row.code, row.id]));
  for (const [roleCode, codes] of Object.entries(Object.fromEntries(roleDefs.map(([code]) => [code, permissionsFor(code)])))) {
    const roleId = roleIds.get(roleCode);
    for (const code of codes) {
      const permissionId = permissionIds.get(code);
      if (!permissionId) continue;
      await client.query(
        `INSERT INTO role_permissions (school_id, role_id, permission_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [schoolId, roleId, permissionId],
      );
    }
  }
  return roleIds;
}

export function requirePermission(module, action) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
      if (req.user.roles.includes('school_admin') || req.user.roles.includes('super_admin')) return next();
      const result = await query(
        `SELECT EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.school_id = ur.school_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = $1 AND ur.school_id = $2 AND p.module = $3 AND p.action = $4
         ) AS allowed`,
        [req.user.id, req.user.school_id, module, action],
      );
      if (!result.rows[0]?.allowed) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      return next();
    } catch {
      return res.status(500).json({ error: 'Unable to verify access permissions right now.' });
    }
  };
}

export function requireAnyRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!req.user.roles.some((role) => roles.includes(role))) return res.status(403).json({ error: 'This portal is not available to your account.' });
    return next();
  };
}

export function userRolesFor(type) {
  if (type === 'teacher') return ['teacher'];
  if (type === 'student') return ['student'];
  if (type === 'parent') return ['parent'];
  if (type === 'librarian') return ['librarian'];
  if (type === 'transport_manager') return ['transport_manager'];
  if (type === 'accountant') return ['accountant'];
  if (type === 'principal') return ['principal'];
  return ['staff'];
}

export function allCrud(module) {
  return CRUD.map((action) => `${module}.${action}`);
}
