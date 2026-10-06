import React, { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BookOpenCheck, CalendarClock, Check, CircleDollarSign, Clock3,
  ClipboardCheck, FileCheck2, GraduationCap, NotebookPen, Plus, ReceiptText, Sparkles, UsersRound, WalletCards,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button, EmptyState, LoadingState, PageHeader, StatusBadge, useToast } from '../components/UI';

const chartColors = ['#526fe4','#29ad9a','#efa950','#ec786f','#8c78df','#4da7d9','#e57aab'];

export default function DashboardPage({ user, school, persona, onNavigate, refreshToken }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active=true;setLoading(true);setError('');
    api('/dashboard').then((result)=>{if(active)setData(result);}).catch((err)=>{if(active)setError(err.message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[refreshToken,retry]);

  if(loading&&!data)return <div className="page-loading"><LoadingState label="Gathering your school overview…"/><div className="skeleton-grid">{Array.from({length:4},(_,i)=><div className="skeleton" key={i}/>)}</div></div>;
  if(error&&!data)return <div className="page-main"><PageHeader title="School overview" description="Your live school operations at a glance."/><div className="inline-error">{error}<Button variant="secondary" onClick={()=>setRetry(value=>value+1)}>Try again</Button></div></div>;
  if(persona==='student')return <StudentDashboard data={data} school={school} onNavigate={onNavigate}/>;
  if(persona==='teacher')return <TeacherDashboard data={data} school={school} user={user} onNavigate={onNavigate}/>;
  if(!['admin','principal','accountant'].includes(persona))return <StaffDashboard data={data} school={school} user={user} onNavigate={onNavigate}/>;
  return <AdminDashboard data={data||{}} user={user} school={school} persona={persona} onNavigate={onNavigate} toast={toast}/>;
}

function AdminDashboard({data,user,school,persona,onNavigate,toast}){
  const counts=data.counts||{};const attendance=data.attendance||{};const finance=data.finance||{};
  const canFinance=finance.today_collection!==null&&finance.today_collection!==undefined;
  const presentPct=Number(attendance.total)?Math.round((Number(attendance.present||0)+Number(attendance.late||0))/Number(attendance.total)*100):0;
  const currency=school?.currency||'USD';
  const statCards=[
    {label:'Active students',value:counts.students||0,detail:`Across ${counts.classes||0} classes`,icon:GraduationCap,tone:'blue',change:null},
    {label:'Teaching staff',value:counts.teachers||0,detail:'Active teachers',icon:UsersRound,tone:'violet',change:null},
    {label:'Today’s attendance',value:attendance.total?`${presentPct}%`:'—',detail:`${attendance.present||0} present · ${attendance.absent||0} absent`,icon:ClipboardCheck,tone:'green',change:null},
    ...(canFinance?[{label:'Collected today',value:formatMoney(finance.today_collection,currency),detail:`${formatMoney(finance.month_collection,currency)} this month`,icon:CircleDollarSign,tone:'amber',change:null}]:[]),
  ];
  const quickActions=[
    {label:'Add student',icon:Plus,page:'students',detail:'Enroll a new student',tone:'blue'},
    {label:'Mark attendance',icon:ClipboardCheck,page:'attendance',detail:'Record today’s roll',tone:'green'},
    ...(canFinance?[{label:'Create invoice',icon:ReceiptText,page:'finance',detail:'Bill a student',tone:'amber'}]:[]),
    {label:'Add teacher',icon:GraduationCap,page:'teachers',detail:'Update your team',tone:'violet'},
    {label:'Create exam',icon:FileCheck2,page:'exams',detail:'Plan assessments',tone:'rose'},
    {label:'Post an update',icon:BookOpenCheck,page:'announcements',detail:'Share with your school',tone:'teal'},
  ];
  return <div className="page-main dashboard-page">
    <PageHeader eyebrow={greeting()} title={persona==='accountant'?'Finance overview':`Good ${greeting().toLowerCase()}, ${user.full_name.split(' ')[0]}.`} description={school?.name?`Here’s the latest from ${school.name}.`:'A live view of your school, all in one place.'}
      actions={<div className="header-status"><span className="live-pulse"/> LIVE DATA <span className="header-separator"/> {new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</div>}/>
    <div className="dashboard-stat-grid">
      {statCards.map(({label,value,detail,icon:Icon,tone})=><div className="stat-card" key={label}><div className="stat-top"><span>{label}</span><span className={`stat-icon stat-${tone}`}><Icon size={18}/></span></div><strong className="stat-value">{value}</strong><div className="stat-foot"><span>{detail}</span>{label==='Today’s attendance'&&attendance.total>0&&<span className="stat-inline-up"><ArrowUpRight size={13}/>{presentPct}%</span>}</div></div>)}
    </div>
    <div className="dashboard-main-grid">
      <div className="dashboard-chart-card attendance-chart-card">
        <div className="card-heading"><div><span className="card-eyebrow">DAILY OPERATIONS</span><h2>Attendance trend</h2><p>Student presence across the last seven days</p></div><button className="text-link" onClick={()=>onNavigate('attendance')}>View attendance <ArrowRight size={14}/></button></div>
        {data.charts?.attendance?.some((day)=>day.total>0)?<div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.charts.attendance} margin={{top:10,right:10,left:-22,bottom:0}}>
          <defs><linearGradient id="presentGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#36a890" stopOpacity={0.2}/><stop offset="98%" stopColor="#36a890" stopOpacity={0.01}/></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e9edf3"/><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{fill:'#929cac',fontSize:11}} dy={10}/><YAxis axisLine={false} tickLine={false} tick={{fill:'#929cac',fontSize:11}}/>
          <ChartTooltip content={<ChartTip/>}/><Area type="monotone" dataKey="total" stroke="#dce2ec" fill="transparent" strokeWidth={1.5} name="Marked"/><Area type="monotone" dataKey="present" stroke="#36a890" fill="url(#presentGradient)" strokeWidth={2.5} name="Present" activeDot={{r:5,strokeWidth:0}}/>
        </AreaChart></ResponsiveContainer></div>:<div className="chart-empty"><EmptyState icon={Activity} title="No attendance yet" description="Once a roll call is recorded, the weekly trend will show up here." action={<Button size="sm" variant="secondary" onClick={()=>onNavigate('attendance')}>Mark attendance</Button>}/></div>}
        <div className="chart-legend"><span><i className="legend-dot dot-primary"/> Present</span><span><i className="legend-dot dot-muted"/> Marked</span><span className="chart-footnote">Based on saved student records</span></div>
      </div>
      {canFinance&&<div className="dashboard-chart-card finance-chart-card">
        <div className="card-heading"><div><span className="card-eyebrow">FINANCE SNAPSHOT</span><h2>Fee collection</h2><p>Collected over the last six months</p></div><button className="text-link" onClick={()=>onNavigate('finance')}>Finance details <ArrowRight size={14}/></button></div>
        {data.charts?.feeCollection?.some((item)=>Number(item.total)>0)?<div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.charts.feeCollection} margin={{top:8,right:4,left:-18,bottom:0}}>
          <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e9edf3"/><XAxis dataKey="month" tickFormatter={(value)=>new Date(value).toLocaleDateString(undefined,{month:'short'})} axisLine={false} tickLine={false} tick={{fill:'#929cac',fontSize:11}} dy={10}/><YAxis axisLine={false} tickLine={false} tick={{fill:'#929cac',fontSize:11}} tickFormatter={(value)=>formatCompact(value,currency)}/><ChartTooltip content={<ChartTip currency={currency}/>}/><Bar dataKey="total" fill="#536fe4" radius={[5,5,1,1]} maxBarSize={32}/>
        </BarChart></ResponsiveContainer></div>:<div className="chart-empty"><EmptyState icon={WalletCards} title="No fee collection yet" description="Payments will appear here as invoices are settled." action={<Button size="sm" variant="secondary" onClick={()=>onNavigate('finance')}>Create an invoice</Button>}/></div>}
        <div className="finance-chart-foot"><div><span>Outstanding balance</span><strong>{formatMoney(finance.outstanding,currency)}</strong></div><div><span>Overdue invoices</span><strong className={Number(finance.overdue_count)>0?'text-danger':''}>{finance.overdue_count||0}</strong></div></div>
      </div>}
    </div>
    <div className="dashboard-secondary-grid">
      <div className="dashboard-panel quick-actions-panel"><div className="panel-heading"><div><h2>Quick actions</h2><p>Keep the day moving</p></div><span className="panel-heading-icon"><Sparkles size={16}/></span></div>
        <div className="quick-action-grid">{quickActions.map((item)=><button key={item.label} className="quick-action" onClick={()=>onNavigate(item.page)}><span className={`quick-action-icon qa-${item.tone}`}><item.icon size={17}/></span><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={14} className="qa-arrow"/></button>)}</div>
      </div>
      <div className="dashboard-panel upcoming-panel"><div className="panel-heading"><div><h2>Coming up</h2><p>Exams and school events</p></div><CalendarClock size={17}/></div>
        <div className="upcoming-list">
          {data.upcomingExams?.slice(0,3).map((item)=><div className="upcoming-item" key={`exam-${item.id}`}><div className="upcoming-date"><strong>{dateDay(item.start_date)}</strong><span>{dateMonth(item.start_date)}</span></div><div><strong>{item.name}</strong><small>{titleCase(item.exam_type)} · Exam</small></div><ArrowRight size={14}/></div>)}
          {data.upcomingEvents?.slice(0,3).map((item)=><div className="upcoming-item" key={`event-${item.id}`}><div className="upcoming-date upcoming-event-date"><CalendarClock size={16}/></div><div><strong>{item.title}</strong><small>{new Date(item.starts_at).toLocaleDateString(undefined,{month:'short',day:'numeric'})} · {item.location||'School event'}</small></div><ArrowRight size={14}/></div>)}
          {!data.upcomingExams?.length&&!data.upcomingEvents?.length&&<div className="upcoming-empty"><span><CalendarClock size={18}/></span><strong>Nothing on the calendar just yet</strong><small>Upcoming exams and events will be listed here.</small></div>}
        </div>
        <button className="panel-bottom-link" onClick={()=>onNavigate('events')}>View school calendar <ArrowRight size={14}/></button>
      </div>
      {data.charts?.population?.length>0&&<div className="dashboard-panel population-panel"><div className="panel-heading"><div><h2>Students by class</h2><p>Active enrollments today</p></div><GraduationCap size={18}/></div>
        <div className="population-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.charts.population.slice(0,6)} layout="vertical" margin={{left:4,right:14,top:0,bottom:0}}><XAxis type="number" hide/><YAxis type="category" dataKey="name" width={56} axisLine={false} tickLine={false} tick={{fill:'#798395',fontSize:11}}/><ChartTooltip content={<ChartTip/>}/><Bar dataKey="count" fill="#7b8fe2" radius={[0,4,4,0]} maxBarSize={14}/></BarChart></ResponsiveContainer></div>
      </div>}
    </div>
    <div className="dashboard-bottom-grid">
      <div className="dashboard-panel table-panel"><div className="panel-heading"><div><h2>Recent admissions</h2><p>Latest students added to the school</p></div><button className="text-link" onClick={()=>onNavigate('students')}>All students <ArrowRight size={14}/></button></div>
        {data.recentAdmissions?.length?<div className="mini-table"><div className="mini-table-head"><span>STUDENT</span><span>CLASS</span><span>ADMITTED</span></div>{data.recentAdmissions.map((item)=><div className="mini-table-row" key={item.id}><span className="person-cell"><i className="person-avatar">{`${item.first_name?.[0]||''}${item.last_name?.[0]||''}`}</i><span><strong>{item.first_name} {item.last_name}</strong><small>{item.student_id}</small></span></span><span>{item.class_name||'—'}</span><span>{formatDate(item.admission_date)}</span></div>)}</div>:<EmptyState icon={GraduationCap} title="No students yet" description="New admissions will show up here." action={<Button size="sm" onClick={()=>onNavigate('students')}>Add a student</Button>}/>}
      </div>
      {canFinance&&<div className="dashboard-panel table-panel"><div className="panel-heading"><div><h2>Recent payments</h2><p>Latest fee collections</p></div><button className="text-link" onClick={()=>onNavigate('payments')}>All payments <ArrowRight size={14}/></button></div>
        {data.recentPayments?.length?<div className="mini-table"><div className="mini-table-head payment-head"><span>RECEIPT</span><span>STUDENT</span><span>AMOUNT</span></div>{data.recentPayments.map((item)=><div className="mini-table-row payment-row" key={item.id}><span className="receipt-cell"><i><ReceiptText size={15}/></i><span><strong>{item.receipt_number}</strong><small>{item.method?.replace('_',' ')}</small></span></span><span>{item.first_name} {item.last_name}</span><strong>{formatMoney(item.amount,currency)}</strong></div>)}</div>:<EmptyState icon={CircleDollarSign} title="No payments recorded" description="Recorded transactions will appear here." action={<Button size="sm" variant="secondary" onClick={()=>onNavigate('finance')}>Open finance</Button>}/>}
      </div>}
    </div>
    <div className="dashboard-announcement-strip"><div className="announcement-strip-icon"><BookOpenCheck size={16}/></div><div><span>ON THE NOTICEBOARD</span><strong>{data.announcements?.[0]?.title||'Your school announcements will appear here'}</strong></div><button onClick={()=>onNavigate('announcements')}>Open noticeboard <ArrowRight size={14}/></button></div>
  </div>;
}

function StudentDashboard({data,school,onNavigate}){
  const profile=data?.profile;
  return <div className="page-main portal-dashboard"><PageHeader eyebrow="STUDENT PORTAL" title={profile?`Good ${greeting().toLowerCase()}, ${profile.first_name}.`:'Your learning, in one place.'} description={profile?`${profile.class_name||'School'}${profile.section_name?` · Section ${profile.section_name}`:''} · ${profile.academic_year||'Academic year'}`:'Your school has not linked a student profile to this account yet.'}
    actions={<div className="portal-student-chip"><div className="portal-avatar">{profile?.first_name?.[0]||'S'}</div><span><small>STUDENT ID</small><strong>{profile?.student_id||'—'}</strong></span></div>}/>
    {profile?<><div className="portal-summary-grid"><SummaryCard icon={Activity} label="Attendance" value={`${data.attendance?.percentage||0}%`} detail={`${data.attendance?.attended||0} of ${data.attendance?.total||0} days attended`} tone="green"/><SummaryCard icon={ClipboardCheck} label="Assignments" value={data.assignments?.filter((x)=>!['submitted','graded','late'].includes(x.submission_status)).length||0} detail="Still to complete" tone="blue"/><SummaryCard icon={WalletCards} label="Fee balance" value={formatMoney((data.invoices||[]).reduce((sum,x)=>sum+Number(x.balance||0),0),school?.currency||'USD')} detail="Across your invoices" tone="amber"/><SummaryCard icon={CalendarClock} label="Upcoming exams" value={data.upcomingExams?.length||0} detail="On your exam schedule" tone="violet"/></div>
    <div className="portal-columns"><div className="dashboard-panel"><div className="panel-heading"><div><h2>Today’s timetable</h2><p>Your classes for the day</p></div><button className="text-link" onClick={()=>onNavigate('timetable')}>Full timetable <ArrowRight size={14}/></button></div><TimetableList items={(data.timetable||[]).filter((x)=>Number(x.day_of_week)===new Date().getDay())} empty="No classes scheduled for today."/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>Next exams</h2><p>Get ready for what’s coming</p></div><FileCheck2 size={17}/></div><CompactList items={data.upcomingExams} empty="Your next exam schedule will appear here." render={(item)=><><strong>{item.subject_name}</strong><small>{item.exam_name} · {formatDate(item.exam_date)}</small></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>Assignments</h2><p>Stay on top of your work</p></div><button className="text-link" onClick={()=>onNavigate('assignments')}>View all <ArrowRight size={14}/></button></div><CompactList items={data.assignments} empty="You’re all caught up on assignments." render={(item)=><><strong>{item.title}</strong><small>{item.subject_name} · {item.due_at?`Due ${formatDate(item.due_at)}`:'No due date'}</small><StatusBadge value={item.submission_status||'pending'} label={item.submission_status||'Pending'}/></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>School notices</h2><p>Updates from your school</p></div><button className="text-link" onClick={()=>onNavigate('announcements')}>Noticeboard <ArrowRight size={14}/></button></div><CompactList items={data.announcements} empty="No recent announcements." render={(item)=><><strong>{item.title}</strong><small>{item.category} · {formatDate(item.publish_at)}</small></>}/></div>
    </div></>:<div className="dashboard-panel"><EmptyState icon={GraduationCap} title="Profile not linked" description="Your school administrator can link your student record to this account."/></div>}</div>;
}

function TeacherDashboard({data,school,user,onNavigate}){
  return <div className="page-main portal-dashboard"><PageHeader eyebrow="TEACHER PORTAL" title={`Good ${greeting().toLowerCase()}, ${user.full_name.split(' ')[0]}.`} description={data.profile?.designation||'Your classes, learning materials and school day at a glance.'} actions={<div className="header-status"><span className="live-pulse"/> TEACHER WORKSPACE</div>}/>
    <div className="portal-summary-grid"><SummaryCard icon={CalendarClock} label="Classes today" value={data.todayClasses?.length||0} detail="On today’s timetable" tone="blue"/><SummaryCard icon={UsersRound} label="Assigned students" value={data.studentCount||0} detail="Across your classes" tone="violet"/><SummaryCard icon={ClipboardCheck} label="Attendance pending" value={data.attendancePending||0} detail="Students to mark today" tone="amber"/><SummaryCard icon={NotebookPen} label="Open assignments" value={data.assignments?.length||0} detail="Shared with your classes" tone="green"/></div>
    <div className="portal-columns"><div className="dashboard-panel"><div className="panel-heading"><div><h2>Today’s classes</h2><p>Your teaching timetable</p></div><button className="text-link" onClick={()=>onNavigate('timetable')}>My timetable <ArrowRight size={14}/></button></div><CompactList items={data.todayClasses} empty="No classes on today’s timetable." render={(item)=><><span className="schedule-time">{formatTime(item.start_time)}</span><span><strong>{item.subject_name}</strong><small>{item.class_name}{item.section_name?` · ${item.section_name}`:''} · {item.room||'Room not set'}</small></span></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>My classes</h2><p>Assigned sections and subjects</p></div><UsersRound size={17}/></div><CompactList items={data.classes} empty="Your assigned classes will appear here." render={(item)=><><strong>{item.class_name}{item.section_name?` · ${item.section_name}`:''}</strong><small>{item.subject_name}</small></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>Assignment activity</h2><p>Work shared with your students</p></div><button className="text-link" onClick={()=>onNavigate('assignments')}>Manage <ArrowRight size={14}/></button></div><CompactList items={data.assignments} empty="Create an assignment when you’re ready." render={(item)=><><strong>{item.title}</strong><small>{item.due_at?`Due ${formatDate(item.due_at)}`:'No due date'}</small></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>School notices</h2><p>Recent updates</p></div><BookOpenCheck size={17}/></div><CompactList items={data.announcements} empty="No announcements right now." render={(item)=><><strong>{item.title}</strong><small>{item.category} · {formatDate(item.publish_at)}</small></>}/></div>
    </div></div>;
}

function StaffDashboard({data,school,user,onNavigate}){
  return <div className="page-main portal-dashboard"><PageHeader eyebrow="STAFF PORTAL" title={`Welcome back, ${user.full_name.split(' ')[0]}.`} description="Your school workspace, personal updates and daily schedule."/>
    <div className="portal-summary-grid"><SummaryCard icon={ClipboardCheck} label="Today’s attendance" value={data.attendance?.status?titleCase(data.attendance.status):'Not recorded'} detail="Staff attendance record" tone="green"/><SummaryCard icon={Clock3} label="Leave requests" value={data.leaveRequests?.length||0} detail="Your recent requests" tone="blue"/><SummaryCard icon={CalendarClock} label="Upcoming events" value={data.upcomingEvents?.length||0} detail="On the school calendar" tone="violet"/></div>
    <div className="portal-columns"><div className="dashboard-panel"><div className="panel-heading"><div><h2>My leave</h2><p>Recent leave request status</p></div><button className="text-link" onClick={()=>onNavigate('leave')}>View leave <ArrowRight size={14}/></button></div><CompactList items={data.leaveRequests} empty="You haven’t submitted a leave request." render={(item)=><><strong>{titleCase(item.leave_type)}</strong><small>{formatDate(item.start_date)} – {formatDate(item.end_date)}</small><StatusBadge value={item.status}/></>}/></div>
      <div className="dashboard-panel"><div className="panel-heading"><div><h2>School notices</h2><p>Latest updates</p></div><BookOpenCheck size={17}/></div><CompactList items={data.announcements} empty="No recent announcements." render={(item)=><><strong>{item.title}</strong><small>{item.category} · {formatDate(item.publish_at)}</small></>}/></div>
    </div></div>;
}

function SummaryCard({icon:Icon,label,value,detail,tone}){return <div className="portal-summary-card"><span className={`stat-icon stat-${tone}`}><Icon size={18}/></span><span className="portal-summary-label">{label}</span><strong>{value}</strong><small>{detail}</small></div>}
function TimetableList({items,empty}){return items?.length?<div className="timetable-list">{items.map((item)=><div className="timetable-item" key={item.id}><div className="timetable-time"><strong>{formatTime(item.start_time)}</strong><span>{formatTime(item.end_time)}</span></div><i className="timetable-rail"/><div><strong>{item.subject_name}</strong><small>{item.teacher_name}{item.room?` · Room ${item.room}`:''}</small></div></div>)}</div>:<div className="compact-empty">{empty}</div>}
function CompactList({items,empty,render}){return items?.length?<div className="compact-list">{items.slice(0,6).map((item,index)=><div className="compact-list-item" key={item.id||index}>{render(item)}</div>)}</div>:<div className="compact-empty">{empty}</div>}
function ChartTip({active,payload,label,currency}){if(!active||!payload?.length)return null;return <div className="chart-tooltip"><span>{label?.length===10?formatDate(label):label}</span>{payload.map((item)=><strong key={item.dataKey} style={{color:item.color}}>{item.name||item.dataKey}: {currency?formatMoney(item.value,currency):Number(item.value||0).toLocaleString()}</strong>)}</div>}
function greeting(){const hour=new Date().getHours();return hour<12?'Morning':hour<18?'Afternoon':'Evening';}
function formatMoney(value,currency='USD'){const number=Number(value||0);try{return new Intl.NumberFormat(undefined,{style:'currency',currency,maximumFractionDigits:0}).format(number)}catch{return `${currency} ${Math.round(number).toLocaleString()}`}}
function formatCompact(value,currency){const n=Number(value||0);return n>=1000?`${currency==='USD'?'$':''}${(n/1000).toFixed(0)}k`:String(n)}
function formatDate(value){if(!value)return'—';const date=new Date(String(value).slice(0,10)+'T12:00:00');return Number.isNaN(date.getTime())?'—':date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});}
function dateDay(value){if(!value)return'—';return new Date(String(value).slice(0,10)+'T12:00:00').toLocaleDateString(undefined,{day:'2-digit'});}
function dateMonth(value){if(!value)return'';return new Date(String(value).slice(0,10)+'T12:00:00').toLocaleDateString(undefined,{month:'short'}).toUpperCase();}
function formatTime(value){if(!value)return'—';const [hour,minute]=String(value).split(':');const date=new Date();date.setHours(Number(hour),Number(minute));return date.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});}
function titleCase(value=''){return String(value).replaceAll('_',' ').replace(/\b\w/g,(c)=>c.toUpperCase());}
