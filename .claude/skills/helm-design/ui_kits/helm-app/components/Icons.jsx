/* global React */
// Inline lucide icons (matched to the canonical iconography mapping).
// 24x24 viewBox, 1.75 stroke. Size via the `size` prop.

const I = ({ d, paths, size = 16, className, strokeWidth = 1.75 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {paths || <path d={d} />}
  </svg>
);

const Icons = {
  MessagesSquare: (p) => <I {...p} paths={<>
    <path d="M14 9a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z" />
    <path d="M18 9h1a2 2 0 0 1 2 2v10l-4-4h-5a2 2 0 0 1-2-2v-1" />
  </>} />,
  Link2: (p) => <I {...p} paths={<>
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </>} />,
  ShieldCheck: (p) => <I {...p} paths={<>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </>} />,
  BookOpen: (p) => <I {...p} paths={<>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </>} />,
  Cloud: (p) => <I {...p} paths={<>
    <path d="M17.5 19a4.5 4.5 0 1 0 0-9H6.5a4.5 4.5 0 1 0 0 9z" />
  </>} />,
  Plug: (p) => <I {...p} paths={<>
    <path d="M9 2v6" /><path d="M15 2v6" /><path d="M12 17v5" />
    <path d="M5 8h14l-1 6a4 4 0 0 1-4 3h-4a4 4 0 0 1-4-3z" />
  </>} />,
  Workflow: (p) => <I {...p} paths={<>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </>} />,
  Settings: (p) => <I {...p} paths={<>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.18.43.21.91.07 1.36z" />
  </>} />,
  Check: (p) => <I {...p} d="M20 6 9 17l-5-5" />,
  X: (p) => <I {...p} paths={<><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>} />,
  Plus: (p) => <I {...p} paths={<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>} />,
  Search: (p) => <I {...p} paths={<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>} />,
  Sparkles: (p) => <I {...p} paths={<>
    <path d="M12 3 13.5 8 18 9.5 13.5 11 12 16 10.5 11 6 9.5 10.5 8z" />
    <path d="M19 14l.75 2L22 17l-2.25 1L19 20l-.75-2L16 17l2.25-1z" />
    <path d="M5 4l.6 1.6L7 6l-1.4.4L5 8l-.6-1.6L3 6l1.4-.4z" />
  </>} />,
  Play: (p) => <I {...p} d="M5 3l14 9-14 9V3z" />,
  Trash2: (p) => <I {...p} paths={<>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </>} />,
  Copy: (p) => <I {...p} paths={<>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>} />,
  ArrowLeftRight: (p) => <I {...p} paths={<>
    <polyline points="17 11 21 7 17 3" />
    <line x1="21" y1="7" x2="9" y2="7" />
    <polyline points="7 13 3 17 7 21" />
    <line x1="3" y1="17" x2="15" y2="17" />
  </>} />,
  MoreHorizontal: (p) => <I {...p} paths={<>
    <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
  </>} />,
  ChevronDown: (p) => <I {...p} d="M6 9l6 6 6-6" />,
  ChevronRight: (p) => <I {...p} d="M9 6l6 6-6 6" />,
  AlertTriangle: (p) => <I {...p} paths={<>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </>} />,
  Clock: (p) => <I {...p} paths={<>
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </>} />,
  ArrowUpRight: (p) => <I {...p} paths={<>
    <line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />
  </>} />,
  FileText: (p) => <I {...p} paths={<>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
  </>} />,
  Glyph: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="20" cy="20" r="6" />
      <circle cx="20" cy="20" r="11.5" />
      <line x1="20" y1="14" x2="20" y2="8.5" />
      <line x1="20" y1="26" x2="20" y2="31.5" />
      <line x1="14" y1="20" x2="8.5" y2="20" />
      <line x1="26" y1="20" x2="31.5" y2="20" />
      <line x1="15.76" y1="15.76" x2="11.87" y2="11.87" />
      <line x1="24.24" y1="24.24" x2="28.13" y2="28.13" />
      <line x1="24.24" y1="15.76" x2="28.13" y2="11.87" />
      <line x1="15.76" y1="24.24" x2="11.87" y2="28.13" />
      <circle cx="20" cy="20" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
};

window.Icons = Icons;
