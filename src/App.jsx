import React, { useCallback, useEffect, useState } from 'react';
import { CloudCog, Database, GraduationCap, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import { api, ApiError } from './lib/api';
import { ToastProvider, Button, Notice } from './components/UI';
import SetupWizard from './pages/SetupWizard';
import Login from './pages/Login';
import { Shell } from './components/Shell';

export default function App() {
  const [toasts, setToasts] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [user, setUser] = useState(null);
  const [school, setSchool] = useState(null);
  const [checking, setChecking] = useState(true);
  const [fatal, setFatal] = useState('');
  const [accessError, setAccessError] = useState('');

  const inspect = useCallback(async () => {
    setChecking(true); setFatal(''); setAccessError('');
    try {
      const install = await api('/setup/status');
      setSnapshot(install); setSchool(install.school || null);
      if (install.initialized) {
        try {
          const session = await api('/auth/me');
          setUser(session.user);
        } catch (error) {
          setUser(null);
          if (error instanceof ApiError && error.status !== 401) setAccessError(error.message);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      setFatal(error.message || 'Unable to start the School ERP.');
    } finally { setChecking(false); }
  }, []);

  useEffect(() => { inspect(); }, [inspect]);

  useEffect(() => {
    if (school?.faviconUrl) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.href = school.faviconUrl;
    }
    if (school?.name) document.title = `${school.name} · School ERP`;
  }, [school]);

  async function handleSetupComplete() {
    await inspect();
  }

  function handleLogin(nextUser) {
    setUser(nextUser);
    window.history.replaceState({}, '', '/');
  }

  async function handleLogout() {
    try { await api('/auth/logout', { method:'POST' }); }
    catch { /* The session cookie will expire if the network is unavailable. */ }
    setUser(null); window.history.replaceState({}, '', '/login');
  }

  const toastValue = <ToastProvider toasts={toasts} setToasts={setToasts}>{checking ? <LoadingScreen/> : fatal ? <StartupError message={fatal} onRetry={inspect}/> : snapshot && !snapshot.initialized ? <SetupWizard key={`${snapshot.step}-${snapshot.database?.connected}`} snapshot={snapshot} onComplete={handleSetupComplete}/> : accessError ? <StartupError message={accessError} onRetry={inspect}/> : user ? <Shell user={user} school={school} onLogout={handleLogout} onSchoolUpdate={(next)=>setSchool((current)=>({...current,...next}))}/> : <Login school={school} onLogin={handleLogin}/>}</ToastProvider>;
  return toastValue;
}

function LoadingScreen() {
  return <div className="boot-screen"><div className="boot-brand"><div><GraduationCap size={23}/></div><strong>School ERP</strong></div><LoaderCircle className="spin" size={25}/><span>Connecting to your school workspace…</span></div>;
}

function StartupError({ message, onRetry }) {
  return <div className="startup-error-screen"><div className="startup-error-card"><div className="startup-error-icon"><WifiOff size={23}/></div><span className="eyebrow">WORKSPACE CONNECTION</span><h1>We can’t reach your school data.</h1><p>{message}</p><Notice title="Your records are safe">This server could not complete a database request. Check that PostgreSQL is running and that the server’s secure database configuration is available.</Notice><Button onClick={onRetry} icon={RefreshCw}>Try again</Button><small><CloudCog size={14}/> No data has been changed.</small></div></div>;
}
