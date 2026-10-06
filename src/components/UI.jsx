import React, { createContext, useCallback, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, CircleCheck, Info, LoaderCircle, Plus, Search, X } from 'lucide-react';

const ToastContext = createContext(() => {});

export function ToastProvider({ children, toasts, setToasts }) {
  const push = useCallback((message, tone = 'success') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, [setToasts]);
  return <ToastContext.Provider value={push}>
    {children}
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}>
        {toast.tone === 'error' ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
        <span>{toast.message}</span>
        <button className="icon-button toast-close" aria-label="Dismiss" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X size={15}/></button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() { return useContext(ToastContext); }

export function Button({ children, onClick, type = 'button', variant = 'primary', size = 'md', icon: Icon, loading = false, disabled = false, className = '', ...props }) {
  return <button type={type} className={`button button-${variant} button-${size} ${className}`} onClick={onClick} disabled={disabled || loading} {...props}>
    {loading ? <LoaderCircle className="spin" size={16} /> : Icon ? <Icon size={16} strokeWidth={2} /> : null}
    {children && <span>{children}</span>}
  </button>;
}

export function IconButton({ icon: Icon, label, variant = 'ghost', className = '', ...props }) {
  return <button className={`icon-button icon-${variant} ${className}`} aria-label={label} title={label} {...props}><Icon size={17} strokeWidth={1.9}/></button>;
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'md' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section className={`modal modal-${width}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header className="modal-header">
        <div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <IconButton icon={X} label="Close dialog" onClick={onClose}/>
      </header>
      <div className="modal-content">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </section>
  </div>, document.body);
}

export function Field({ label, name, value, onChange, placeholder, type = 'text', required, hint, error, options, disabled, rows, min, max, step, className = '', autoComplete, id }) {
  const Control = options ? 'select' : rows ? 'textarea' : 'input';
  return <label className={`field ${className}`}>
    <span className="field-label">{label}{required && <em>*</em>}</span>
    {options ? <Control id={id} name={name} value={value ?? ''} onChange={onChange} required={required} disabled={disabled} autoComplete={autoComplete}>
      <option value="">{placeholder || 'Select an option'}</option>
      {options.map((option) => typeof option === 'string'
        ? <option key={option} value={option}>{option}</option>
        : <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </Control> : rows ? <Control id={id} name={name} rows={rows} value={value ?? ''} onChange={onChange} placeholder={placeholder} required={required} disabled={disabled} autoComplete={autoComplete} /> : <Control id={id} name={name} value={value ?? ''} onChange={onChange} type={type} placeholder={placeholder} required={required} disabled={disabled} min={min} max={max} step={step} autoComplete={autoComplete} />}
    {error && <span className="field-error">{error}</span>}
    {!error && hint && <span className="field-hint">{hint}</span>}
  </label>;
}

export function StatusBadge({ value, label }) {
  const key = String(value || 'unknown').toLowerCase().replaceAll(' ', '_');
  return <span className={`status-badge status-${key}`}><i/>{label || String(value || 'Unknown').replaceAll('_',' ')}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }) {
  return <div className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>;
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className = '' }) {
  return <div className={`search-input ${className}`}><Search size={16}/><input value={value} onChange={onChange} placeholder={placeholder} aria-label={placeholder}/>{value && <button onClick={() => onChange({ target: { value: '' } })} aria-label="Clear search"><X size={14}/></button>}</div>;
}

export function EmptyState({ icon: Icon = Info, title, description, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={22}/></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function LoadingState({ label = 'Loading your school data…' }) {
  return <div className="loading-state"><LoaderCircle className="spin" size={24}/><span>{label}</span></div>;
}

export function Skeleton({ className = '' }) { return <div className={`skeleton ${className}`}/>; }

export function FormActions({ onCancel, submitting, submitLabel = 'Save changes' }) {
  return <div className="form-actions"><Button variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button><Button type="submit" loading={submitting}>{submitLabel}</Button></div>;
}

export function Notice({ tone = 'info', title, children, icon: Icon = CircleAlert }) {
  return <div className={`notice notice-${tone}`}><Icon size={18}/><div>{title && <strong>{title}</strong>}<span>{children}</span></div></div>;
}
