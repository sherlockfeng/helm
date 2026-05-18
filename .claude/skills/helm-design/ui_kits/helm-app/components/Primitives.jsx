/* global React, Icons */
const { useState, useEffect, useRef } = React;

function Button({ variant = 'default', size, icon: Icon, children, onClick, disabled, ...rest }) {
  const cls = ['btn', variant !== 'default' && variant, size === 'sm' && 'sm']
    .filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled} {...rest}>
      {Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}

function IconButton({ icon: Icon, label, onClick, variant = 'ghost' }) {
  return (
    <button className={`btn btn-icon ${variant}`} onClick={onClick} aria-label={label} title={label}>
      <Icon size={14} />
    </button>
  );
}

function Badge({ tone = 'default', dot, children }) {
  const cls = 'badge' + (tone !== 'default' ? ' ' + tone : '');
  const dotColor = { success: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)', accent: 'var(--accent)' }[tone];
  return (
    <span className={cls}>
      {dot ? <span className="dot" style={{ background: dotColor }} /> : null}
      {children}
    </span>
  );
}

function Card({ variant, interactive, selected, onClick, children, style }) {
  const cls = ['card', variant, interactive && 'interactive', selected && 'selected']
    .filter(Boolean).join(' ');
  return <div className={cls} onClick={onClick} style={style}>{children}</div>;
}

function Input({ leadIcon: LeadIcon, ...rest }) {
  if (!LeadIcon) return <input className="field" {...rest} />;
  return (
    <div style={{ position: 'relative' }}>
      <LeadIcon size={14} className="lead" />
      <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
        <LeadIcon size={14} />
      </span>
      <input className="field" style={{ paddingLeft: 28 }} {...rest} />
    </div>
  );
}

function Tabs({ items, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          className={`tab${value === it.value ? ' active' : ''}`}
          onClick={() => onChange(it.value)}
        >
          {it.label}
          {it.count != null ? <span className="pill">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function StatTile({ label, value, delta, deltaTone = 'muted' }) {
  return (
    <div className="stat-tile">
      <div className="lbl">{label}</div>
      <div className="num">{value}</div>
      {delta != null ? <div className={`delta ${deltaTone}`}>{delta}</div> : null}
    </div>
  );
}

function EmptyState({ title, body, primaryAction, secondaryAction }) {
  return (
    <div className="empty">
      <Icons.Glyph size={64} />
      <div className="title">{title}</div>
      <div className="body">{body}</div>
      {(primaryAction || secondaryAction) ? (
        <div className="row" style={{ marginTop: 4 }}>
          {secondaryAction ? <Button variant="default" onClick={secondaryAction.onClick}>{secondaryAction.label}</Button> : null}
          {primaryAction ? <Button variant="primary" onClick={primaryAction.onClick}>{primaryAction.label}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

function Skeleton({ width = '100%', height = 12, radius = 4, style }) {
  return (
    <div
      className="skel"
      style={{
        width, height, borderRadius: radius,
        background: 'linear-gradient(90deg, var(--hover) 0%, var(--bg) 50%, var(--hover) 100%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.4s linear infinite',
        ...style,
      }}
    />
  );
}

/* Toast layer */
let _addToast;
function ToastLayer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    _addToast = (toast) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, ...toast }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), toast.duration || 3200);
    };
  }, []);
  return (
    <div className="toast-layer">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.tone === 'success' ? <Icons.Check size={16} className="ic success" /> :
           t.tone === 'warn'    ? <Icons.AlertTriangle size={16} className="ic warn" /> :
           t.tone === 'danger'  ? <Icons.X size={16} className="ic danger" /> :
                                  <Icons.Check size={16} className="ic" />}
          <div className="col">
            <div className="title">{t.title}</div>
            {t.body ? <div className="body">{t.body}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
function toast(opts) { if (_addToast) _addToast(opts); }

/* Modal with focus trap (best-effort) */
function Modal({ open, onClose, title, children, actions }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    setTimeout(() => ref.current && ref.current.focus(), 10);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()} ref={ref} tabIndex={-1}>
        {title ? <h2>{title}</h2> : null}
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* Style for shimmer keyframes (one-shot insert) */
if (typeof document !== 'undefined' && !document.getElementById('shimmer-style')) {
  const s = document.createElement('style');
  s.id = 'shimmer-style';
  s.textContent = '@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }';
  document.head.appendChild(s);
}

Object.assign(window, {
  Button, IconButton, Badge, Card, Input, Tabs, StatTile, EmptyState, Skeleton,
  ToastLayer, toast, Modal,
});
