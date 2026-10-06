import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, BookOpenCheck, Check, CheckCircle2, ChevronRight, Database, GraduationCap, LockKeyhole, Palette, ShieldCheck, Sparkles, School } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Field, Notice, useToast } from '../components/UI';

const steps = [
  { id: 'database', label: 'Database', icon: Database },
  { id: 'school', label: 'School profile', icon: School },
  { id: 'administrator', label: 'Administrator', icon: ShieldCheck },
];

function dateInYear(offset = 0, month = 8, day = 1) {
  const date = new Date();
  date.setFullYear(date.getFullYear() + offset, month, day);
  return date.toISOString().slice(0, 10);
}

export default function SetupWizard({ snapshot, onComplete }) {
  const toast = useToast();
  const [step, setStep] = useState(snapshot.step || 'database');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(snapshot.database?.connected || false);
  const [schoolSaving, setSchoolSaving] = useState(false);
  const [adminSaving, setAdminSaving] = useState(false);
  const [error, setError] = useState('');
  const thisYear = new Date().getFullYear();
  const [school, setSchool] = useState({
    name: '', motto: '', logoUrl: '', faviconUrl: '', address: '', city: '', country: '', phone: '', email: '', website: '',
    principalName: '', registrationInfo: '', currency: 'USD', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    primaryColor: '#3157d5', secondaryColor: '#14294f', accentColor: '#26a69a',
    academicYear: `${thisYear}–${thisYear + 1}`, academicStart: dateInYear(0, 8, 1), academicEnd: dateInYear(1, 5, 30),
    currentTerm: 'Term 1', termStart: dateInYear(0, 8, 1), termEnd: dateInYear(0, 11, 19),
  });
  const [admin, setAdmin] = useState({ fullName: '', email: '', password: '', confirmPassword: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [showDatabaseUrl, setShowDatabaseUrl] = useState(false);
  const activeIndex = steps.findIndex((item) => item.id === step);
  const progress = useMemo(() => `${Math.max(activeIndex + 1, 1)} of ${steps.length}`, [activeIndex]);

  function setSchoolField(event) { setSchool((current) => ({ ...current, [event.target.name]: event.target.value })); }
  function setAdminField(event) { setAdmin((current) => ({ ...current, [event.target.name]: event.target.value })); }

  async function testConnection(event) {
    event.preventDefault(); setError(''); setTesting(true); setConnectionVerified(false);
    try {
      const result = await api('/setup/test-connection', { method: 'POST', body: { databaseUrl: databaseUrl.trim() } });
      setConnectionVerified(true); toast(result.message || 'Connection verified.');
    } catch (err) { setError(err.message); }
    finally { setTesting(false); }
  }

  async function continueDatabase(event) {
    event.preventDefault(); setError(''); setInstalling(true);
    try {
      const result = await api('/setup/database', { method: 'POST', body: { databaseUrl: databaseUrl.trim() } });
      setConnectionVerified(true); setStep(result.step || 'school'); toast('PostgreSQL schema installed successfully.');
    } catch (err) { setError(err.message); }
    finally { setInstalling(false); }
  }

  async function saveSchool(event) {
    event.preventDefault(); setError(''); setSchoolSaving(true);
    try {
      const result = await api('/setup/school', { method: 'POST', body: school });
      setStep(result.step || 'administrator'); toast('School profile saved.');
    } catch (err) { setError(err.message); }
    finally { setSchoolSaving(false); }
  }

  async function createAdmin(event) {
    event.preventDefault(); setError('');
    if (admin.password.length < 12 || !/[a-z]/.test(admin.password) || !/[A-Z]/.test(admin.password) || !/[0-9]/.test(admin.password)) {
      setError('Use at least 12 characters with an uppercase letter, a lowercase letter, and a number.'); return;
    }
    if (admin.password !== admin.confirmPassword) { setError('The passwords do not match.'); return; }
    setAdminSaving(true);
    try {
      await api('/setup/administrator', { method: 'POST', body: admin });
      toast('Your administrator account is ready. Welcome aboard.');
      await onComplete();
    } catch (err) { setError(err.message); }
    finally { setAdminSaving(false); }
  }

  return <div className="setup-screen" style={{ '--school-primary': school.primaryColor, '--school-accent': school.accentColor }}>
    <aside className="setup-sidebar">
      <div className="brand-lockup setup-brand"><div className="brand-mark"><GraduationCap size={22}/></div><div><strong>School ERP</strong><span>INSTALLATION WIZARD</span></div></div>
      <div className="setup-sidebar-body">
        <div className="setup-kicker"><Sparkles size={14}/> A better school day starts here</div>
        <h1>Make it<br/><span>your school.</span></h1>
        <p>Set up your secure school workspace. Your profile, people and learning records stay in your own PostgreSQL database.</p>
        <div className="setup-progress-card">
          <div className="progress-heading"><span>Installation progress</span><b>{progress}</b></div>
          <div className="progress-track"><i style={{ width: `${((Math.max(activeIndex, 0) + 1) / steps.length) * 100}%` }}/></div>
          <div className="setup-step-list">
            {steps.map((item, index) => {
              const Icon = item.icon; const active = item.id === step; const done = index < activeIndex;
              return <div className={`setup-step ${active ? 'active' : ''} ${done ? 'done' : ''}`} key={item.id}>
                <div className="step-icon">{done ? <Check size={16}/> : <Icon size={16}/>}</div>
                <div><strong>{item.label}</strong><span>{done ? 'Completed' : active ? 'In progress' : 'Up next'}</span></div>
                {active && <ChevronRight size={15} className="step-chevron"/>}
              </div>;
            })}
          </div>
        </div>
        <div className="setup-security-note"><div className="security-icon"><LockKeyhole size={17}/></div><div><strong>Private by design</strong><span>Your database connection stays on this server and is never sent back to the browser.</span></div></div>
      </div>
      <div className="setup-footer"><span>DEVZARD SCHOOL ERP</span><span>SECURE · PRIVATE · YOURS</span></div>
    </aside>

    <main className="setup-main">
      <div className="setup-topline"><span>FIRST-RUN INSTALLATION</span><div className="setup-encrypted"><ShieldCheck size={14}/> Encrypted connection</div></div>
      <div className="setup-content">
        {step === 'database' && <section className="setup-panel">
          <div className="step-overline"><span className="overline-icon"><Database size={18}/></span><span>STEP 01 <i>/</i> DATABASE</span></div>
          <h2>Welcome to School ERP</h2>
          <p className="setup-lede">Let’s configure your database to get started. Connect a PostgreSQL database where your school’s records will live.</p>
          {snapshot.database?.error && <Notice tone="warning" title="We couldn’t reach the saved database">{snapshot.database.error} Enter an updated PostgreSQL URL below, or check your server configuration.</Notice>}
          {snapshot.database?.configured && !snapshot.database?.error && <Notice title="Database connection detected">The connection is stored securely on this server. You can continue without entering it again.</Notice>}
          <form onSubmit={connectionVerified ? continueDatabase : testConnection}>
            <Field label="PostgreSQL database URL" name="databaseUrl" value={databaseUrl} onChange={(event) => { setDatabaseUrl(event.target.value); setConnectionVerified(false); setError(''); }} type={showDatabaseUrl?'text':'password'} placeholder={snapshot.database?.configured ? 'Stored securely on this server' : 'postgresql://username:password@host:5432/database'} hint="Use a dedicated database and database user with permission to create tables, indexes and functions." required={!snapshot.database?.configured}/>
            <div className="setup-url-foot"><span><LockKeyhole size={13}/> Credentials are stored server-side only</span><button type="button" onClick={() => setShowDatabaseUrl((value) => !value)}>{showDatabaseUrl ? 'Hide URL' : 'Show URL'}</button></div>
            {error && <Notice tone="error" title="Setup needs your attention">{error}</Notice>}
            <div className="setup-db-actions">
              {!connectionVerified ? <Button type="submit" loading={testing} variant="secondary" icon={CheckCircle2}>Test connection</Button> : <div className="connection-ok"><CheckCircle2 size={17}/> Connection verified</div>}
              <Button type="button" onClick={continueDatabase} loading={installing} disabled={!connectionVerified}>Install database <ArrowRight size={16}/></Button>
            </div>
            {!connectionVerified && <div className="setup-hint-card"><div><BadgeCheck size={18}/></div><p><strong>What happens next?</strong><span>We’ll check database access, then apply versioned migrations to build your ERP schema. No school data is created until you choose to continue.</span></p></div>}
          </form>
        </section>}

        {step === 'school' && <section className="setup-panel setup-panel-wide">
          <div className="step-overline"><span className="overline-icon"><School size={18}/></span><span>STEP 02 <i>/</i> SCHOOL PROFILE</span></div>
          <h2>Make it feel like home.</h2>
          <p className="setup-lede">Add the details that make this workspace yours. Your name, colors and contact information will appear across every school portal and report.</p>
          <form onSubmit={saveSchool} className="school-setup-form">
            <div className="form-section-title"><div><strong>School identity</strong><span>This appears throughout the ERP.</span></div><BookOpenCheck size={18}/></div>
            <div className="form-grid two-col">
              <Field label="School name" name="name" value={school.name} onChange={setSchoolField} placeholder="e.g. Northfield Academy" required/>
              <Field label="Motto or tagline" name="motto" value={school.motto} onChange={setSchoolField} placeholder="Learning today, leading tomorrow"/>
              <Field label="School logo URL" name="logoUrl" value={school.logoUrl} onChange={setSchoolField} placeholder="https://…" hint="You can upload a logo from Settings after setup."/>
              <Field label="Favicon URL" name="faviconUrl" value={school.faviconUrl} onChange={setSchoolField} placeholder="https://…"/>
            </div>
            <div className="form-section-title section-space"><div><strong>Contact & registration</strong><span>These details can be changed at any time.</span></div></div>
            <div className="form-grid three-col">
              <Field label="Email" name="email" value={school.email} onChange={setSchoolField} type="email" placeholder="office@school.edu"/>
              <Field label="Phone" name="phone" value={school.phone} onChange={setSchoolField} placeholder="+1 555 0142"/>
              <Field label="Website" name="website" value={school.website} onChange={setSchoolField} placeholder="https://school.edu"/>
              <Field label="City" name="city" value={school.city} onChange={setSchoolField} placeholder="City"/>
              <Field label="Country" name="country" value={school.country} onChange={setSchoolField} placeholder="Country"/>
              <Field label="Principal / head" name="principalName" value={school.principalName} onChange={setSchoolField} placeholder="Full name"/>
              <Field label="Address" name="address" value={school.address} onChange={setSchoolField} placeholder="Street address" className="span-2"/>
              <Field label="Registration details" name="registrationInfo" value={school.registrationInfo} onChange={setSchoolField} placeholder="School registration number"/>
            </div>
            <div className="form-section-title section-space"><div><strong>Regional preferences</strong><span>Used for dates, schedules and fee receipts.</span></div></div>
            <div className="form-grid three-col">
              <Field label="Currency" name="currency" value={school.currency} onChange={setSchoolField} placeholder="USD" required hint="Three-letter code, e.g. USD, GBP or PKR"/>
              <Field label="Timezone" name="timezone" value={school.timezone} onChange={setSchoolField} placeholder="UTC" required/>
              <Field label="Academic year" name="academicYear" value={school.academicYear} onChange={setSchoolField} placeholder="2026–2027" required/>
              <Field label="Year starts" name="academicStart" value={school.academicStart} onChange={setSchoolField} type="date" required/>
              <Field label="Year ends" name="academicEnd" value={school.academicEnd} onChange={setSchoolField} type="date" required/>
              <Field label="Current term" name="currentTerm" value={school.currentTerm} onChange={setSchoolField} placeholder="Term 1" required/>
              <Field label="Term starts" name="termStart" value={school.termStart} onChange={setSchoolField} type="date" required/>
              <Field label="Term ends" name="termEnd" value={school.termEnd} onChange={setSchoolField} type="date" required/>
            </div>
            <div className="form-section-title section-space"><div><strong>Your brand colors</strong><span>These power buttons, links and highlights in every portal.</span></div><Palette size={18}/></div>
            <div className="brand-color-row">
              {[['primaryColor','Primary'],['secondaryColor','Secondary'],['accentColor','Accent']].map(([name,label])=><label className="brand-color-field" key={name}><span>{label}</span><input type="color" name={name} value={school[name]} onChange={setSchoolField}/><code>{school[name].toUpperCase()}</code></label>)}
              <div className="brand-preview"><div className="brand-preview-chip" style={{background:school.primaryColor}}/><div className="brand-preview-chip" style={{background:school.secondaryColor}}/><div className="brand-preview-chip" style={{background:school.accentColor}}/><span>BRAND PREVIEW</span></div>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="setup-form-footer"><Button variant="secondary" onClick={() => setStep('database')}><ArrowLeft size={16}/> Back</Button><Button type="submit" loading={schoolSaving}>Save school profile <ArrowRight size={16}/></Button></div>
          </form>
        </section>}

        {step === 'administrator' && <section className="setup-panel admin-setup-panel">
          <div className="step-overline"><span className="overline-icon"><ShieldCheck size={18}/></span><span>STEP 03 <i>/</i> FIRST ADMINISTRATOR</span></div>
          <h2>Your keys to the school.</h2>
          <p className="setup-lede">Create the first administrator account. This account can invite staff and manage permissions for your school.</p>
          <div className="setup-school-preview"><div className="school-avatar" style={{background:school.primaryColor}}>{school.logoUrl ? <img src={school.logoUrl} alt="School logo"/> : <School size={19}/>}</div><div><strong>{snapshot.school?.name || school.name || 'Your school'}</strong><span>School Administrator · Full access</span></div><CheckCircle2 size={18}/></div>
          <form onSubmit={createAdmin} className="admin-setup-form">
            <Field label="Full name" name="fullName" value={admin.fullName} onChange={setAdminField} placeholder="Your name" required autoComplete="name"/>
            <Field label="Work email" name="email" value={admin.email} onChange={setAdminField} type="email" placeholder="you@school.edu" required autoComplete="email"/>
            <Field label="Password" name="password" value={admin.password} onChange={setAdminField} type={showPassword ? 'text' : 'password'} placeholder="Create a strong password" required autoComplete="new-password" hint="At least 12 characters, including uppercase, lowercase and a number."/>
            <Field label="Confirm password" name="confirmPassword" value={admin.confirmPassword} onChange={setAdminField} type={showPassword ? 'text' : 'password'} placeholder="Enter your password again" required autoComplete="new-password"/>
            <label className="show-password-option"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)}/> Show passwords</label>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="setup-form-footer"><Button variant="secondary" onClick={() => setStep('school')}><ArrowLeft size={16}/> Back</Button><Button type="submit" loading={adminSaving}>Create administrator <ArrowRight size={16}/></Button></div>
            <div className="admin-lock-note"><LockKeyhole size={14}/> Passwords are one-way hashed before they reach the database.</div>
          </form>
        </section>}
      </div>
      <div className="setup-bottom"><span>By continuing, you confirm you’re authorized to configure this school.</span><span>NEED HELP? <a href="mailto:support@devzard.com">CONTACT SUPPORT</a></span></div>
    </main>
  </div>;
}
