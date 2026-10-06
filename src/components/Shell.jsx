import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, Bell, BookMarked, BookOpen, BusFront, CalendarDays, ChartNoAxesCombined,
  Check, ChevronDown, CircleDollarSign, ClipboardCheck, ClipboardList, FileCheck2, FileText, GraduationCap,
  LayoutDashboard, Library, LogOut, Menu, MessageSquareText, Package, Search, Settings2, ShieldCheck,
  SquareUserRound, Users, WalletCards, X, UsersRound, Clock3, NotebookPen, BriefcaseBusiness,
} from 'lucide-react';
import { api } from '../lib/api';
import { IconButton, LoadingState, useToast } from './UI';
const DashboardPage=lazy(()=>import('../pages/DashboardPage'));
const PeoplePage=lazy(()=>import('../pages/PeoplePage'));
const StructurePage=lazy(()=>import('../pages/StructurePage'));
const AttendancePage=lazy(()=>import('../pages/AttendancePage'));
const FinancePage=lazy(()=>import('../pages/FinancePage'));
const AcademicsPage=lazy(()=>import('../pages/AcademicsPage'));
const CommunicationPage=lazy(()=>import('../pages/CommunicationPage'));
const ResourcePage=lazy(()=>import('../pages/ResourcePage'));
const ReportsPage=lazy(()=>import('../pages/ReportsPage'));
const SettingsPage=lazy(()=>import('../pages/SettingsPage'));
const PortalPage=lazy(()=>import('../pages/PortalPage'));

const iconMap = {
  overview: LayoutDashboard, students: UsersRound, teachers: GraduationCap, staff: BriefcaseBusiness,
  classes: SquareUserRound, subjects: BookOpen, attendance: ClipboardCheck, exams: FileCheck2,
  assignments: NotebookPen, finance: WalletCards, payments: CircleDollarSign, announcements: MessageSquareText,
  events: CalendarDays, leave: Clock3, library: Library, transport: BusFront, inventory: Package,
  discipline: ShieldCheck, reports: ChartNoAxesCombined, audit: Activity, settings: Settings2,
  timetable: CalendarDays, materials: BookMarked, profile: SquareUserRound, 'my-attendance': ClipboardList,
  'my-results': ChartNoAxesCombined, 'my-fees': WalletCards, 'my-classes': UsersRound,
};

const group = (label, items) => ({ label, items });
const adminNav = [
  group('WORKSPACE', [{ id:'overview',label:'Overview' }]),
  group('PEOPLE', [{id:'students',label:'Students'},{id:'teachers',label:'Teachers'},{id:'staff',label:'Staff'}]),
  group('ACADEMIC', [{id:'classes',label:'Classes & sections'},{id:'subjects',label:'Subjects & timetable'},{id:'attendance',label:'Attendance'},{id:'exams',label:'Exams & results'},{id:'assignments',label:'Assignments & materials'}]),
  group('SCHOOL LIFE', [{id:'announcements',label:'Announcements'},{id:'events',label:'Events'},{id:'leave',label:'Leave requests'}]),
  group('OPERATIONS', [{id:'finance',label:'Fees & invoices'},{id:'payments',label:'Payments & receipts'},{id:'library',label:'Library'},{id:'transport',label:'Transport'},{id:'inventory',label:'Inventory'},{id:'discipline',label:'Student services'}]),
  group('INSIGHTS', [{id:'reports',label:'Reports'},{id:'audit',label:'Audit trail'}]),
  group('ADMINISTRATION', [{id:'settings',label:'School settings'}]),
];
const portalNav = {
  teacher: [group('MY TEACHING', [{id:'overview',label:'My dashboard'},{id:'classes',label:'My classes'},{id:'subjects',label:'My subjects'},{id:'attendance',label:'Attendance'},{id:'timetable',label:'My timetable'}]), group('LEARNING', [{id:'assignments',label:'Assignments'},{id:'exams',label:'Exams & results'},{id:'announcements',label:'School notices'},{id:'profile',label:'My profile'}])],
  student: [group('MY SCHOOL', [{id:'overview',label:'My dashboard'},{id:'timetable',label:'My timetable'},{id:'my-attendance',label:'Attendance'},{id:'my-results',label:'My results'}]), group('LEARNING', [{id:'assignments',label:'Assignments'},{id:'materials',label:'Study materials'},{id:'announcements',label:'Announcements'},{id:'events',label:'Events'},{id:'my-fees',label:'Fee status'},{id:'profile',label:'My profile'}])],
  staff: [group('MY WORKSPACE', [{id:'overview',label:'My dashboard'},{id:'leave',label:'Leave & attendance'},{id:'announcements',label:'School notices'},{id:'events',label:'Events'},{id:'profile',label:'My profile'}])],
  accountant: [group('FINANCE', [{id:'overview',label:'Overview'},{id:'finance',label:'Fees & invoices'},{id:'payments',label:'Payments & receipts'},{id:'reports',label:'Finance reports'}]), group('SCHOOL', [{id:'students',label:'Students'},{id:'announcements',label:'Announcements'},{id:'profile',label:'My profile'}])],
  librarian: [group('LIBRARY', [{id:'overview',label:'Overview'},{id:'library',label:'Catalog & circulation'},{id:'students',label:'Students'},{id:'profile',label:'My profile'}])],
  transport_manager: [group('TRANSPORT', [{id:'overview',label:'Overview'},{id:'transport',label:'Routes & fleet'},{id:'students',label:'Students'},{id:'profile',label:'My profile'}])],
  principal: adminNav,
};

export function portalFor(user) {
  const roles = user?.roles || [];
  if (roles.includes('school_admin') || roles.includes('super_admin')) return 'admin';
  if (roles.includes('principal')) return 'principal';
  if (roles.includes('teacher')) return 'teacher';
  if (roles.includes('student')) return 'student';
  if (roles.includes('accountant')) return 'accountant';
  if (roles.includes('librarian')) return 'librarian';
  if (roles.includes('transport_manager')) return 'transport_manager';
  return 'staff';
}

export function Shell({ user, school, onLogout, onSchoolUpdate }) {
  const toast = useToast();
  const persona = portalFor(user);
  const navSource = persona === 'admin' ? adminNav : (portalNav[persona] || portalNav.staff);
  const [permissions, setPermissions] = useState([]);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const mayViewPage = (page) => {
    if (page === 'profile') return true;
    if (!permissionsLoaded) return true;
    const code = permissionForPage(page, persona);
    return !code || permissions.includes(code);
  };
  const nav = useMemo(() => navSource.map(section => ({ ...section, items: section.items.filter(item => mayViewPage(item.id)) })).filter(section => section.items.length), [navSource, permissions, permissionsLoaded, persona]);
  const allowedPages = useMemo(() => new Set(nav.flatMap((item)=>item.items.map((entry)=>entry.id))),[nav]);
  const initialPage = getInitialPage(allowedPages);
  const [activePage, setActivePage] = useState(initialPage);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const searchRef = useRef(null);

  useEffect(() => {
    const update = () => {
      const page = getInitialPage(allowedPages);
      setActivePage(page);
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, [allowedPages]);

  useEffect(() => {
    if (permissionsLoaded && !allowedPages.has(activePage)) navigate('overview', true);
  }, [permissionsLoaded, allowedPages, activePage]);

  useEffect(() => {
    let alive = true;
    api('/auth/permissions').then((result)=>{if(alive){setPermissions(result.permissions||[]);setPermissionsLoaded(true);}}).catch(()=>{if(alive)setPermissionsLoaded(true);});
    if ((user.roles||[]).some((role)=>['school_admin','super_admin','principal','teacher'].includes(role))) {
      api('/notifications').then((result)=>{if(alive)setNotifications(result.data||[]);}).catch(()=>{});
    }
    return ()=>{alive=false;};
  }, [user.id, user.roles]);

  useEffect(() => {
    const onShortcut=(event)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();searchRef.current?.querySelector('input')?.focus();setSearchOpen(true);}};
    window.addEventListener('keydown',onShortcut);return()=>window.removeEventListener('keydown',onShortcut);
  },[]);

  useEffect(() => {
    if (!searchTerm.trim() || searchTerm.trim().length < 2) { setSearchResults([]); return undefined; }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try { const result = await api(`/search?q=${encodeURIComponent(searchTerm.trim())}`); if (alive) setSearchResults(result.results||[]); }
      catch { if (alive) setSearchResults([]); }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [searchTerm]);

  function navigate(page, replace = false) {
    const next = allowedPages.has(page) ? page : 'overview';
    setActivePage(next); setMobileOpen(false); setSearchOpen(false); setNotificationOpen(false); setUserMenu(false);
    const route = next === 'overview' ? '/' : `/${next}`;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', route);
  }

  const title = nav.flatMap((item)=>item.items).find((item)=>item.id===activePage)?.label || 'Overview';
  const primary = school?.primaryColor || '#3157d5';
  const colorStyle = { '--brand-primary': primary, '--brand-secondary': school?.secondaryColor||'#14294f', '--brand-accent': school?.accentColor||'#26a69a' };
  const roleName = ({ admin:'School administrator',principal:'Principal',teacher:'Teacher',student:'Student',accountant:'Accountant',librarian:'Librarian',transport_manager:'Transport manager',staff:'School staff' })[persona];
  const queryText = (event) => { setSearchTerm(event.target.value); setSearchOpen(true); };

  async function markRead(id) {
    try { await api(`/notifications/${id}/read`, {method:'POST'}); setNotifications((items)=>items.map((item)=>item.id===id?{...item,read_at:new Date().toISOString()}:item)); }
    catch (error) { toast(error.message,'error'); }
  }

  return <div className="app-shell" style={colorStyle}>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setMobileOpen(false)}/>}
    <aside className={`app-sidebar ${mobileOpen?'sidebar-open':''}`}>
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark" style={{background:primary}}>{school?.logoUrl?<img src={school.logoUrl} alt=""/>:<GraduationCap size={21}/>}</div>
        <div className="sidebar-school-name"><strong>{school?.name||'Your school'}</strong><span>{persona==='student'?'STUDENT PORTAL':persona==='teacher'?'TEACHER PORTAL':persona==='admin'?'SCHOOL WORKSPACE':'STAFF PORTAL'}</span></div>
        <IconButton icon={X} label="Close menu" className="mobile-close" onClick={()=>setMobileOpen(false)}/>
      </div>
      <div className="sidebar-school-switch"><div className="school-switch-avatar">{school?.name?.slice(0,1)||'S'}</div><div><span>ACTIVE SCHOOL</span><strong>{school?.name||'School workspace'}</strong></div><ChevronDown size={14}/></div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {nav.map((section)=><div className="nav-group" key={section.label}><span className="nav-group-label">{section.label}</span>{section.items.map((item)=>{
          const Icon=iconMap[item.id]||LayoutDashboard;const active=activePage===item.id;
          return <button className={`nav-item ${active?'nav-active':''}`} key={item.id} onClick={()=>navigate(item.id)} aria-current={active?'page':undefined}>
            <Icon size={17} strokeWidth={active?2.1:1.8}/><span>{item.label}</span>{item.id==='leave'&&persona==='staff'&&<span className="nav-dot"/>}
          </button>;
        })}</div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-help"><div className="help-icon"><ShieldCheck size={16}/></div><div><strong>Need a hand?</strong><span>Your school data is securely yours.</span></div><a href={`mailto:${school?.email||'support@devzard.com'}`} aria-label="Contact support"><ArrowRight size={15}/></a></div>
        <div className="sidebar-version"><span>DEVZARD ERP</span><span>v1.0.0</span></div>
      </div>
    </aside>

    <div className="app-main-column">
      <header className="topbar">
        <div className="topbar-left"><IconButton icon={Menu} label="Open menu" className="menu-toggle" onClick={()=>setMobileOpen(true)}/><div className="breadcrumb"><span>{persona==='admin'?'Workspace':persona==='student'?'Student portal':persona==='teacher'?'Teacher portal':'Staff portal'}</span><i>/</i><strong>{title}</strong></div></div>
        <div className="topbar-right">
          <div className={`global-search ${searchOpen?'search-focused':''}`} ref={searchRef}>
            <Search size={16}/><input value={searchTerm} onChange={queryText} onFocus={()=>setSearchOpen(true)} placeholder="Search students, invoices…" aria-label="Search school records" onKeyDown={(event)=>event.key==='Escape'&&setSearchOpen(false)}/><kbd>⌘ K</kbd>
            {searchOpen&&searchTerm.length>=2&&<div className="search-results-popover">
              {searching?<div className="search-result-state">Searching…</div>:searchResults.length?searchResults.map((result)=><button key={`${result.kind}-${result.id}`} onClick={()=>{
                setSearchTerm('');setSearchOpen(false);if(result.kind==='student'){navigate('students');toast(`${result.label} · ${result.code||''}`);}else if(result.kind==='invoice'){navigate('finance');toast(`Invoice ${result.code}`);}else {navigate(result.kind==='teacher'?'teachers':'staff');toast(`${result.label} · ${result.code||''}`);}
              }}><span className={`search-kind kind-${result.kind}`}>{result.kind==='student'?'STU':result.kind==='invoice'?'INV':result.kind==='teacher'?'TCH':'STF'}</span><span><strong>{result.label}</strong><small>{result.group_name||result.reference||result.code}</small></span><ArrowRight size={14}/></button>):<div className="search-result-state">No matches for “{searchTerm}”</div>}
            </div>}
          </div>
          <div className="topbar-action-wrap">
            <IconButton icon={Bell} label="Notifications" variant="topbar" onClick={()=>{setNotificationOpen((value)=>!value);setUserMenu(false);}}/>
            {notifications.some((item)=>!item.read_at)&&<span className="notification-count">{Math.min(notifications.filter((item)=>!item.read_at).length,9)}</span>}
            {notificationOpen&&<div className="topbar-popover notification-popover"><div className="popover-heading"><div><strong>Notifications</strong><span>{notifications.filter((item)=>!item.read_at).length} unread</span></div><button onClick={()=>setNotificationOpen(false)}><X size={15}/></button></div>{notifications.length?notifications.slice(0,8).map((item)=><button className={`notification-item ${item.read_at?'':'unread'}`} key={item.id} onClick={()=>markRead(item.id)}><span className="notification-dot"/><span><strong>{item.title}</strong><small>{item.body||item.category} · {new Date(item.created_at).toLocaleDateString()}</small></span>{!item.read_at&&<Check size={14}/>}</button>):<div className="popover-empty">You’re all caught up.</div>}</div>}
          </div>
          <div className="profile-menu-wrap">
            <button className="profile-menu-button" onClick={()=>{setUserMenu((value)=>!value);setNotificationOpen(false);}} aria-expanded={userMenu}><span className="user-avatar">{initials(user.full_name)}</span><span className="profile-menu-text"><strong>{user.full_name}</strong><small>{roleName}</small></span><ChevronDown size={14}/></button>
            {userMenu&&<div className="topbar-popover user-popover"><button onClick={()=>navigate('profile')}><SquareUserRound size={16}/>My profile</button>{persona==='admin'&&<button onClick={()=>navigate('settings')}><Settings2 size={16}/>School settings</button>}<hr/><button onClick={onLogout} className="logout-menu-item"><LogOut size={16}/>Sign out</button></div>}
          </div>
        </div>
      </header>
      <main className="page-content" key={activePage}>
        <Suspense fallback={<div className="page-main"><LoadingState label="Opening your school workspace…"/></div>}><PageRouter page={activePage} user={user} school={school} persona={persona} permissions={permissions} onNavigate={navigate} onSchoolUpdate={onSchoolUpdate} onRefresh={()=>setRefreshToken((x)=>x+1)} refreshToken={refreshToken}/></Suspense>
      </main>
      <footer className="app-footer"><span>© {new Date().getFullYear()} {school?.name || 'Your school'}</span><span><span className="online-indicator"/> Secure school workspace</span><a href={`mailto:${school?.email||'support@devzard.com'}`}>Help & support</a></footer>
    </div>
  </div>;
}

function PageRouter(props) {
  const {page,user,school,persona}=props;
  if(page==='overview')return <DashboardPage {...props}/>;
  if(['students','teachers','staff'].includes(page))return <PeoplePage {...props} type={page}/>;
  if(page==='timetable'&&persona==='student')return <PortalPage {...props} panel="timetable"/>;
  if(['classes','subjects','timetable'].includes(page))return <StructurePage {...props} mode={page}/>;
  if(['attendance','my-attendance'].includes(page))return persona==='student'?<PortalPage {...props} panel="attendance"/>:<AttendancePage {...props}/>;
  if(['finance','payments','my-fees'].includes(page))return persona==='student'?<PortalPage {...props} panel="fees"/>:<FinancePage {...props} mode={page}/>;
  if(['exams','my-results'].includes(page))return persona==='student'?<PortalPage {...props} panel="results"/>:<AcademicsPage {...props} mode="exams"/>;
  if(page==='assignments')return <AcademicsPage {...props} mode="assignments"/>;
  if(page==='materials')return <PortalPage {...props} panel="materials"/>;
  if(['announcements','events','leave'].includes(page))return <CommunicationPage {...props} mode={page}/>;
  if(['library','transport','inventory','discipline'].includes(page))return <ResourcePage {...props} mode={page}/>;
  if(page==='reports'||page==='audit')return <ReportsPage {...props} mode={page}/>;
  if(page==='settings')return <SettingsPage {...props}/>;
  if(page==='profile')return <PortalPage {...props} panel="profile"/>;
  if(page==='my-classes')return <StructurePage {...props} mode="classes"/>;
  return <DashboardPage {...props}/>;
}

function permissionForPage(page, persona) {
  const permissions = {
    overview:'dashboard.view',students:'students.view',teachers:'teachers.view',staff:'staff.view',
    classes:'classes.view',subjects:'subjects.view',attendance:'attendance.view',exams:'exams.view',
    assignments:'assignments.view',finance:'finance.view',payments:'finance.view',announcements:'announcements.view',
    events:'events.view',leave:'leave.view',library:'library.view',transport:'transport.view',inventory:'inventory.view',
    discipline:'discipline.view',reports:'reports.view',audit:'audit.view',settings:'settings.edit',
    timetable:persona==='student'?'dashboard.view':'classes.view',materials:'study_materials.view',
    'my-attendance':'attendance.view','my-results':'exams.view','my-fees':'finance.view','my-classes':'classes.view',
  };
  return permissions[page] || null;
}

function getInitialPage(allowed) {
  const value=window.location.pathname.replace(/^\/+|\/+$/g,'');
  return allowed.has(value)?value:'overview';
}
function initials(name='') { return name.trim().split(/\s+/).slice(0,2).map((part)=>part[0]?.toUpperCase()||'').join('')||'S'; }
