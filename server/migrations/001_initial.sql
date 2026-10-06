CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  motto text,
  logo_url text,
  favicon_url text,
  address text,
  city text,
  country text,
  phone text,
  email text,
  website text,
  principal_name text,
  registration_info text,
  currency char(3) NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'UTC',
  primary_color text NOT NULL DEFAULT '#3157d5',
  secondary_color text NOT NULL DEFAULT '#14294f',
  accent_color text NOT NULL DEFAULT '#26a69a',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (id, slug)
);

CREATE TABLE school_settings (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  date_format text NOT NULL DEFAULT 'DD MMM YYYY',
  time_format text NOT NULL DEFAULT '12h',
  language text NOT NULL DEFAULT 'en',
  attendance_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  finance_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE installation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  state text NOT NULL DEFAULT 'database_ready' CHECK (state IN ('database_ready','school_ready','initialized')),
  school_id uuid REFERENCES schools(id) ON DELETE RESTRICT,
  initialized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, code),
  UNIQUE (id, school_id)
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  module text NOT NULL,
  action text NOT NULL CHECK (action IN ('view','create','edit','delete','approve','export')),
  description text
);

CREATE TABLE role_permissions (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id, school_id) REFERENCES roles(id, school_id) ON DELETE CASCADE
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  phone text,
  avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended','archived')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (id, school_id)
);
CREATE UNIQUE INDEX users_school_email_unique ON users (school_id, lower(email)) WHERE archived_at IS NULL;
CREATE INDEX users_school_status_idx ON users (school_id, status);

CREATE TABLE user_roles (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, school_id) REFERENCES roles(id, school_id) ON DELETE CASCADE
);

CREATE TABLE academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (end_date > start_date),
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);
CREATE UNIQUE INDEX one_current_academic_year_per_school ON academic_years (school_id) WHERE is_current = true AND archived_at IS NULL;

CREATE TABLE terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  UNIQUE (academic_year_id, name),
  UNIQUE (id, school_id),
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_current_term_per_year ON terms (academic_year_id) WHERE is_current = true;

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);

CREATE TABLE teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  employee_id text NOT NULL,
  full_name text NOT NULL,
  email text,
  phone text,
  gender text,
  date_of_birth date,
  photo_url text,
  address text,
  qualification text,
  specialization text,
  joining_date date,
  department_id uuid,
  designation text,
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','on_leave','inactive','archived')),
  salary numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, employee_id),
  UNIQUE (id, school_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (department_id, school_id) REFERENCES departments(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX teachers_school_name_idx ON teachers (school_id, lower(full_name));

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  employee_id text NOT NULL,
  full_name text NOT NULL,
  email text,
  phone text,
  designation text,
  department_id uuid,
  joining_date date,
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','on_leave','inactive','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, employee_id),
  UNIQUE (id, school_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (department_id, school_id) REFERENCES departments(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  grade_level integer,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);

CREATE TABLE sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id uuid NOT NULL,
  name text NOT NULL,
  room text,
  class_teacher_id uuid,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (class_id, name),
  UNIQUE (id, school_id),
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  subject_type text NOT NULL DEFAULT 'core' CHECK (subject_type IN ('core','elective','practical','activity')),
  credits numeric(5,2),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, code),
  UNIQUE (id, school_id)
);

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  student_id text NOT NULL,
  admission_number text NOT NULL,
  roll_number text,
  first_name text NOT NULL,
  middle_name text,
  last_name text NOT NULL,
  gender text,
  date_of_birth date,
  blood_group text,
  nationality text,
  religion text,
  photo_url text,
  phone text,
  email text,
  address text,
  city text,
  previous_school text,
  admission_date date NOT NULL DEFAULT CURRENT_DATE,
  admission_class_id uuid,
  current_class_id uuid,
  current_section_id uuid,
  academic_year_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','transferred','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, student_id),
  UNIQUE (school_id, admission_number),
  UNIQUE (id, school_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (admission_class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX students_school_class_idx ON students (school_id, current_class_id, current_section_id) WHERE archived_at IS NULL;
CREATE INDEX students_school_name_idx ON students (school_id, lower(last_name), lower(first_name));
CREATE INDEX students_admission_date_idx ON students (school_id, admission_date DESC);

CREATE TABLE guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  full_name text NOT NULL,
  relationship text,
  phone text,
  email text,
  address text,
  occupation text,
  emergency_contact boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE student_guardians (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, guardian_id),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (guardian_id, school_id) REFERENCES guardians(id, school_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_primary_guardian_per_student ON student_guardians (student_id) WHERE is_primary = true;

CREATE TABLE class_subjects (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  academic_year_id uuid,
  weekly_hours numeric(4,1),
  PRIMARY KEY (class_id, subject_id, academic_year_id),
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE teacher_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  class_id uuid NOT NULL,
  section_id uuid,
  academic_year_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, subject_id, class_id, section_id, academic_year_id),
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX teacher_subject_assignment_unique ON teacher_subjects
  (school_id, teacher_id, subject_id, class_id,
   COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  class_id uuid NOT NULL,
  section_id uuid,
  roll_number text,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','promoted','transferred','withdrawn','completed')),
  enrolled_at date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id, academic_year_id),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX enrollments_class_idx ON enrollments (school_id, class_id, section_id, academic_year_id);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  section_id uuid,
  subject_id uuid,
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','late','excused')),
  note text,
  recorded_by uuid,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','biometric')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX attendance_school_date_idx ON attendance (school_id, attendance_date DESC, class_id);
CREATE INDEX attendance_student_date_idx ON attendance (school_id, student_id, attendance_date DESC);

CREATE TABLE staff_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  teacher_id uuid,
  staff_id uuid,
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','late','half_day','leave')),
  note text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id, attendance_date),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id, school_id) REFERENCES staff(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  applicant_user_id uuid NOT NULL,
  leave_type text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  FOREIGN KEY (applicant_user_id, school_id) REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  class_id uuid NOT NULL,
  section_id uuid,
  subject_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  room text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX timetable_lookup_idx ON timetable_entries (school_id, academic_year_id, class_id, section_id, day_of_week, start_time);

CREATE TABLE exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  term_id uuid,
  name text NOT NULL,
  exam_type text NOT NULL DEFAULT 'custom',
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('draft','scheduled','in_progress','completed','archived')),
  description text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id),
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_id, school_id) REFERENCES terms(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE exam_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  exam_date date,
  start_time time,
  end_time time,
  room text,
  maximum_marks numeric(7,2) NOT NULL DEFAULT 100 CHECK (maximum_marks > 0),
  passing_marks numeric(7,2) NOT NULL DEFAULT 40 CHECK (passing_marks >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, class_id, subject_id),
  UNIQUE (id, school_id),
  FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE RESTRICT,
  CHECK (passing_marks <= maximum_marks),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time)
);

CREATE TABLE grade_scales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  min_percentage numeric(5,2) NOT NULL,
  max_percentage numeric(5,2) NOT NULL,
  grade text NOT NULL,
  gpa numeric(4,2),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_percentage >= 0 AND max_percentage <= 100 AND min_percentage <= max_percentage),
  UNIQUE (school_id, name, grade)
);

CREATE TABLE results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_subject_id uuid NOT NULL,
  student_id uuid NOT NULL,
  marks_obtained numeric(7,2) NOT NULL CHECK (marks_obtained >= 0),
  grade text,
  gpa numeric(4,2),
  remarks text,
  entered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_subject_id, student_id),
  FOREIGN KEY (exam_subject_id, school_id) REFERENCES exam_subjects(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (entered_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE fee_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  description text,
  is_recurring boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);

CREATE TABLE fee_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  fee_type_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  class_id uuid,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fee_type_id, school_id) REFERENCES fee_types(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  student_id uuid NOT NULL,
  academic_year_id uuid,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  subtotal numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  fine numeric(12,2) NOT NULL DEFAULT 0 CHECK (fine >= 0),
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('draft','unpaid','partial','paid','overdue','void')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, invoice_number),
  UNIQUE (id, school_id),
  UNIQUE (id, student_id, school_id),
  CHECK (total = subtotal - discount + fine),
  CHECK (paid <= total),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX invoices_school_due_idx ON invoices (school_id, due_date, status);
CREATE INDEX invoices_student_idx ON invoices (school_id, student_id, created_at DESC);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  fee_type_id uuid,
  description text NOT NULL,
  quantity numeric(8,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount numeric(12,2) NOT NULL CHECK (unit_amount >= 0),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, school_id) REFERENCES invoices(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (fee_type_id, school_id) REFERENCES fee_types(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  receipt_number text NOT NULL,
  invoice_id uuid NOT NULL,
  student_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_date timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL CHECK (method IN ('cash','bank_transfer','card','online','other')),
  reference text,
  notes text,
  received_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_number),
  FOREIGN KEY (invoice_id, student_id, school_id) REFERENCES invoices(id, student_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (received_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX payments_school_date_idx ON payments (school_id, payment_date DESC);
CREATE INDEX payments_invoice_idx ON payments (school_id, invoice_id);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  teacher_id uuid,
  class_id uuid NOT NULL,
  section_id uuid,
  subject_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  due_at timestamptz,
  attachment_url text,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id),
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  submitted_at timestamptz,
  submission_url text,
  comments text,
  score numeric(7,2),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','late','graded','returned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id),
  FOREIGN KEY (assignment_id, school_id) REFERENCES assignments(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE
);

CREATE TABLE study_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  material_type text NOT NULL CHECK (material_type IN ('pdf','document','presentation','video','link','note')),
  resource_url text NOT NULL,
  class_id uuid,
  section_id uuid,
  subject_id uuid,
  academic_year_id uuid,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (academic_year_id, school_id) REFERENCES academic_years(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (uploaded_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL DEFAULT 'general' CHECK (category IN ('general','academic','examination','fees','event','emergency')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','students','teachers','staff','parents','class')),
  class_id uuid,
  section_id uuid,
  publish_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  attachment_url text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (section_id, school_id) REFERENCES sections(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX announcements_publish_idx ON announcements (school_id, publish_at DESC) WHERE archived_at IS NULL;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  location text,
  organizer text,
  audience text NOT NULL DEFAULT 'all',
  attachment_url text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  FOREIGN KEY (created_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id)
);
CREATE TABLE conversation_participants (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, school_id) REFERENCES conversations(id, school_id) ON DELETE CASCADE
);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  body text NOT NULL,
  attachment_url text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  FOREIGN KEY (conversation_id, school_id) REFERENCES conversations(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_unread_idx ON notifications (school_id, user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  isbn text,
  title text NOT NULL,
  author text,
  publisher text,
  category text,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  shelf text,
  location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (school_id, isbn),
  UNIQUE (id, school_id)
);
CREATE TABLE library_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  book_id uuid NOT NULL,
  student_id uuid NOT NULL,
  issued_at date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL,
  returned_at date,
  fine numeric(10,2) NOT NULL DEFAULT 0 CHECK (fine >= 0),
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (book_id, school_id) REFERENCES books(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (issued_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX library_open_transactions_idx ON library_transactions (school_id, due_date) WHERE returned_at IS NULL;

CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  license_number text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, license_number),
  UNIQUE (id, school_id)
);
CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  pickup_time time,
  dropoff_time time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);
CREATE TABLE route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  route_id uuid NOT NULL,
  name text NOT NULL,
  stop_order integer NOT NULL,
  pickup_time time,
  dropoff_time time,
  UNIQUE (route_id, stop_order),
  UNIQUE (id, school_id),
  FOREIGN KEY (route_id, school_id) REFERENCES routes(id, school_id) ON DELETE CASCADE
);
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  vehicle_number text NOT NULL,
  registration text,
  vehicle_type text,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  driver_id uuid,
  route_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, vehicle_number),
  FOREIGN KEY (driver_id, school_id) REFERENCES drivers(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (route_id, school_id) REFERENCES routes(id, school_id) ON DELETE RESTRICT
);
CREATE TABLE student_transport (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  route_id uuid NOT NULL,
  pickup_stop_id uuid,
  dropoff_stop_id uuid,
  monthly_fee numeric(10,2) NOT NULL DEFAULT 0 CHECK (monthly_fee >= 0),
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id, start_date),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (route_id, school_id) REFERENCES routes(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (pickup_stop_id, school_id) REFERENCES route_stops(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (dropoff_stop_id, school_id) REFERENCES route_stops(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  purchase_date date,
  unit_cost numeric(12,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  supplier text,
  location text,
  condition text,
  department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (id, school_id),
  FOREIGN KEY (department_id, school_id) REFERENCES departments(id, school_id) ON DELETE RESTRICT
);
CREATE TABLE inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('purchase','issue','return','transfer','disposal')),
  quantity integer NOT NULL CHECK (quantity > 0),
  from_location text,
  to_location text,
  notes text,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, school_id) REFERENCES inventory_items(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (performed_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE discipline_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  incident_date date NOT NULL DEFAULT CURRENT_DATE,
  incident text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  action_taken text,
  notes text,
  follow_up_date date,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  certificate_type text NOT NULL,
  certificate_number text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_url text,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, certificate_number),
  FOREIGN KEY (student_id, school_id) REFERENCES students(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (issued_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type IN ('student','teacher','staff','class','school')),
  owner_id uuid,
  name text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL,
  description text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (uploaded_by, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX documents_owner_idx ON documents (school_id, owner_type, owner_id);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX audit_school_time_idx ON audit_logs (school_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_logs (school_id, entity, entity_id);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'schools','academic_years','terms','departments','teachers','staff','classes','sections',
    'subjects','students','guardians','enrollments','attendance','leave_requests',
    'timetable_entries','exams','results','fee_types','fee_structures','invoices',
    'assignments','assignment_submissions','announcements','events','books','drivers',
    'routes','vehicles','inventory_items'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name, table_name);
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX attendance_subject_unique ON attendance (school_id, student_id, attendance_date, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid));
