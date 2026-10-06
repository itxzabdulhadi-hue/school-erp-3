import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, GraduationCap, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Field, useToast } from '../components/UI';

export default function Login({ school, onLogin }) {
  const toast = useToast();
  const [values, setValues] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const brand = school || {};
  async function submit(event) {
    event.preventDefault(); setError(''); setSubmitting(true);
    try {
      const result = await api('/auth/login', { method: 'POST', body: values });
      toast(`Welcome back, ${result.user.full_name.split(' ')[0]}.`);
      onLogin(result.user);
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }
  return <main className="login-screen" style={{ '--school-primary': brand.primaryColor || '#3157d5', '--school-secondary': brand.secondaryColor || '#14294f', '--school-accent': brand.accentColor || '#26a69a' }}>
    <div className="login-left">
      <div className="login-top-brand">
        <div className="brand-mark">{brand.logoUrl ? <img src={brand.logoUrl} alt=""/> : <GraduationCap size={23}/>}</div>
        <span>{brand.name || 'School ERP'}</span>
      </div>
      <div className="login-hero">
        <div className="hero-pill"><span/> SCHOOL WORKSPACE</div>
        <h1>Every school day,<br/><span>made simpler.</span></h1>
        <p>A connected workspace for the people who make learning happen. Sign in to pick up where you left off.</p>
        <div className="login-illustration" aria-hidden="true">
          <div className="illustration-orbit orbit-one"/><div className="illustration-orbit orbit-two"/>
          <div className="illustration-card card-top"><div className="tiny-avatar">{brand.name?.slice(0,1)||'S'}</div><div><span>Today’s attendance</span><strong>All caught up</strong></div><span className="check-dot">✓</span></div>
          <div className="illustration-core"><div className="core-book"><BookShape/></div><div className="core-sparkle">✦</div></div>
          <div className="illustration-card card-bottom"><div className="mini-bars"><i/><i/><i/><i/><i/><i/></div><div><span>School, in sync</span><strong>One calm place to start</strong></div></div>
          <span className="float-dot dot-a"/><span className="float-dot dot-b"/><span className="float-star">✧</span>
        </div>
      </div>
      <div className="login-left-foot"><span>{brand.motto || 'A little more room for what matters.'}</span><span>BUILT FOR YOUR SCHOOL</span></div>
    </div>
    <div className="login-right">
      <div className="login-mobile-brand"><div className="brand-mark">{brand.logoUrl ? <img src={brand.logoUrl} alt=""/> : <GraduationCap size={22}/>}</div><span>{brand.name || 'School ERP'}</span></div>
      <div className="login-card">
        <div className="login-icon"><LockKeyhole size={21}/></div>
        <div className="login-eyebrow">SECURE SCHOOL ACCESS</div>
        <h2>Welcome back</h2>
        <p className="login-subtitle">Sign in with your school account to continue.</p>
        <form onSubmit={submit} className="login-form">
          <Field label="Email address" name="email" value={values.email} onChange={(e)=>setValues(current=>({...current,email:e.target.value}))} type="email" placeholder="name@school.edu" required autoComplete="username"/>
          <label className="field password-field"><span className="field-label">Password</span><div className="password-control"><input name="password" type={showPassword?'text':'password'} value={values.password} onChange={(e)=>setValues(current=>({...current,password:e.target.value}))} placeholder="Enter your password" required autoComplete="current-password"/><button type="button" aria-label={showPassword?'Hide password':'Show password'} onClick={()=>setShowPassword(value=>!value)}>{showPassword?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
          {error && <div className="login-error" role="alert">{error}</div>}
          <Button type="submit" className="login-submit" loading={submitting}>Sign in <ArrowRight size={17}/></Button>
        </form>
        <div className="login-privacy"><ShieldCheck size={15}/><span>Your account is protected with secure, encrypted sessions.</span></div>
      </div>
      <div className="login-right-foot"><span>Need help signing in? <a href={`mailto:${brand.email || 'support@devzard.com'}`}>Contact your school office</a></span><span>© {new Date().getFullYear()} {brand.name || 'School ERP'}</span></div>
    </div>
  </main>;
}

function BookShape(){return <svg viewBox="0 0 84 84" fill="none"><path d="M20 19c10-5 20-3 22 1v46c-3-5-13-7-22-3V19Z" fill="white"/><path d="M64 19c-10-5-20-3-22 1v46c3-5 13-7 22-3V19Z" fill="#dfe8ff"/><path d="M20 19c10-5 20-3 22 1v46c-3-5-13-7-22-3V19Z" stroke="#627fd1" strokeWidth="2"/><path d="M64 19c-10-5-20-3-22 1v46c3-5 13-7 22-3V19Z" stroke="#627fd1" strokeWidth="2"/><path d="M27 28h9M27 34h9M55 28h4M55 34h4" stroke="#9aaedc" strokeWidth="2" strokeLinecap="round"/></svg>}
