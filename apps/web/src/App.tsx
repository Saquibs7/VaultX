import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FilePlus2,
  Files,
  Fingerprint,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Search,
  ShieldCheck,
  Upload,
  UserRound,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

type User = {
  id: string;
  institutionId: string;
  name: string;
  email: string;
  role: string;
};

type Session = { token: string; user: User };

type Credential = {
  id: string;
  issuerId: string;
  institutionId: string;
  holderReference: string;
  documentDigest: string;
  documentStorageReference: string;
  issuerKeyId: string;
  credentialVersion: number;
  issuedAt: string;
  deadlineAt: string;
  lifecycleStatus: string;
  anchorState?: string;
  anchorBatchId?: string;
  anchorRoot?: string;
  anchorTransactionHash?: string;
  anchorBlockNumber?: string;
  revocationState?: string;
  revocationTransactionHash?: string;
  createdAt: string;
};

type Verification = {
  status: string;
  credentialId?: string;
  issuerId?: string;
  issuedAt?: string;
  lifecycleStatus?: string;
  documentDigest?: string;
  anchorStatus?: string;
  anchorBatchId?: string;
  anchorRoot?: string;
  anchorTransactionHash?: string;
  anchorBlockNumber?: string;
  revocationState?: string;
  expectedDigest?: string;
  receivedDigest?: string;
};

type Health = { ok: boolean; persistence?: string; demoBootstrapEnabled?: boolean };
type View = 'overview' | 'issue' | 'credentials' | 'verify';

const SESSION_KEY = 'vdoc.session';

async function request<T>(url: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!(init.body instanceof FormData) && init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

function formatDate(value?: string) {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value;
}

function lifecycleTone(status: string) {
  if (status === 'ANCHORED') return 'anchored';
  if (status === 'REVOKED' || status === 'REJECTED') return 'revoked';
  return 'pending';
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [view, setView] = useState<View>('overview');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [publicVerify, setPublicVerify] = useState(false);

  useEffect(() => {
    void request<Health>('/health').then(setHealth).catch(() => setHealth({ ok: false }));
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (!stored) return;
    try {
      const saved = JSON.parse(stored) as Session;
      void request<User>('/api/v1/auth/me', {}, saved.token)
        .then((user) => setSession({ token: saved.token, user }))
        .catch(() => sessionStorage.removeItem(SESSION_KEY));
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setCredentials([]);
      return;
    }
    void refreshCredentials(session.token);
  }, [session]);

  const hasPendingBlockchainUpdates = credentials.some((credential) =>
    credential.lifecycleStatus === 'PENDING_ANCHOR'
    || credential.revocationState === 'QUEUED'
    || credential.revocationState === 'CLAIMED',
  );

  useEffect(() => {
    if (!session || !hasPendingBlockchainUpdates) return;
    const timer = window.setInterval(() => {
      void request<{ items: Credential[] }>('/api/v1/credentials', {}, session.token)
        .then((result) => setCredentials(result.items))
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [session, hasPendingBlockchainUpdates]);

  async function refreshCredentials(token = session?.token) {
    if (!token) return;
    try {
      const result = await request<{ items: Credential[] }>('/api/v1/credentials', {}, token);
      setCredentials(result.items);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load credentials' });
    }
  }

  async function signIn(email: string, password: string) {
    const result = await request<{ token: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    const next = { token: result.token, user: result.user };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    setPublicVerify(false);
    setNotice({ kind: 'success', text: `Signed in to ${result.user.name}'s workspace` });
  }

  async function signOut() {
    if (session) {
      await request('/api/v1/auth/logout', { method: 'POST' }, session.token).catch(() => undefined);
    }
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setSelectedId(null);
    setNotice(null);
  }

  const counts = useMemo(() => ({
    total: credentials.length,
    pending: credentials.filter((credential) => credential.lifecycleStatus === 'PENDING_ANCHOR').length,
    anchored: credentials.filter((credential) => credential.lifecycleStatus === 'ANCHORED').length,
    revoked: credentials.filter((credential) => credential.lifecycleStatus === 'REVOKED').length,
  }), [credentials]);

  async function issueCredential(form: FormData) {
    if (!session) return;
    setBusy(true);
    try {
      form.set('issuerId', session.user.id);
      const credential = await request<Credential>('/api/v1/credentials', {
        method: 'POST',
        body: form,
      }, session.token);
      await refreshCredentials(session.token);
      setView('credentials');
      setSelectedId(credential.id);
      setNotice({ kind: 'success', text: 'Credential issued and queued for anchoring' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Credential could not be issued' });
    } finally {
      setBusy(false);
    }
  }

  async function revokeCredential(credentialId: string) {
    if (!session) return;
    setBusy(true);
    try {
      await request(`/api/v1/credentials/${credentialId}/revoke`, { method: 'POST' }, session.token);
      await refreshCredentials(session.token);
      setNotice({ kind: 'success', text: 'Credential revoked' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Credential could not be revoked' });
    } finally {
      setBusy(false);
    }
  }

  if (publicVerify) {
    return <VerifyOnly onBack={() => setPublicVerify(false)} />;
  }

  if (!session) {
    return (
      <SignInScreen
        bootstrapEnabled={health?.demoBootstrapEnabled === true}
        health={health}
        onSignIn={signIn}
        onPublicVerify={() => setPublicVerify(true)}
      />
    );
  }

  const selectedCredential = credentials.find((credential) => credential.id === selectedId) ?? null;

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <a className="brand" href="#workspace" aria-label="Verified Document Vault home">
          <span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.2} /></span>
          <span className="brand-copy"><strong>VERIFIED</strong><small>DOCUMENT VAULT</small></span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavItem active={view === 'overview'} icon={<LayoutDashboard size={17} />} label="Overview" onClick={() => setView('overview')} />
          <NavItem active={view === 'issue'} icon={<FilePlus2 size={17} />} label="Issue credential" onClick={() => setView('issue')} />
          <NavItem active={view === 'credentials'} icon={<Files size={17} />} label="Credential register" onClick={() => setView('credentials')} count={counts.total} />
          <NavItem active={view === 'verify'} icon={<FileCheck2 size={17} />} label="Verify document" onClick={() => setView('verify')} />
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-integrity">
          <span className="signal-dot" />
          <div><strong>Verification service</strong><small>{health?.ok ? 'Available' : 'Connection unavailable'}</small></div>
        </div>
        <div className="sidebar-user">
          <span className="avatar"><UserRound size={17} /></span>
          <div className="sidebar-user-copy"><strong>{session.user.name}</strong><small>{session.user.role.toLowerCase()}</small></div>
          <button className="icon-button subtle" onClick={() => void signOut()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Institution workspace</span><ArrowUpRight size={13} /><strong>{session.user.institutionId}</strong></div>
          <div className="topbar-meta"><span className="chain-chip"><span className="chain-dot" />Local verification</span><span className="topbar-divider" /><span className="topbar-date">{new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date())}</span></div>
        </header>

        {health?.persistence === 'volatile' && (
          <div className="environment-note"><AlertTriangle size={15} /><span>Local demo storage is volatile. API records are cleared when the server restarts.</span></div>
        )}
        {notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />}

        {view === 'overview' && (
          <Overview
            user={session.user}
            counts={counts}
            credentials={credentials}
            onNavigate={setView}
            onSelect={(credential) => { setSelectedId(credential.id); setView('credentials'); }}
          />
        )}
        {view === 'issue' && <IssueView busy={busy} onSubmit={issueCredential} />}
        {view === 'credentials' && (
          <CredentialRegister
            credentials={credentials}
            selected={selectedCredential}
            busy={busy}
            onSelect={(credential) => setSelectedId(credential.id)}
            onRevoke={revokeCredential}
            onRefresh={() => void refreshCredentials()}
          />
        )}
        {view === 'verify' && <VerifyView credentials={credentials} />}

        <footer className="page-footer"><span>VERIFIED DOCUMENT VAULT</span><span>DOCUMENT INTEGRITY · ISSUER TRUST · ON-CHAIN EVIDENCE</span></footer>
      </main>
    </div>
  );
}

function NavItem({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}
    </button>
  );
}

function SignInScreen({
  bootstrapEnabled,
  health,
  onSignIn,
  onPublicVerify,
}: {
  bootstrapEnabled: boolean;
  health: Health | null;
  onSignIn: (email: string, password: string) => Promise<void>;
  onPublicVerify: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [institution, setInstitution] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'setup') {
        const createdInstitution = await request<{ id: string }>('/api/v1/institutions', {
          method: 'POST', body: JSON.stringify({ name: institution }),
        });
        await request('/api/v1/institutions/' + createdInstitution.id + '/issuers', {
          method: 'POST', body: JSON.stringify({ name, email, password, role: 'ISSUER' }),
        });
      }
      await onSignIn(email, password);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-side">
        <div className="auth-brand"><span className="brand-mark"><ShieldCheck size={19} /></span><span className="brand-copy"><strong>VERIFIED</strong><small>DOCUMENT VAULT</small></span></div>
        <div className="auth-visual">
          <div className="auth-kicker"><span className="signal-dot" /> TRUST, MADE VERIFIABLE</div>
          <h1>Credential records,<br /><em>with evidence.</em></h1>
          <p>Issue signed documents, preserve their integrity, and verify the original file against the issuer record.</p>
          <div className="auth-proof"><div className="proof-line"><span>01</span><b>Issuer signature</b><span className="proof-check"><Check size={13} /></span></div><div className="proof-line"><span>02</span><b>Document digest</b><span className="proof-check"><Check size={13} /></span></div><div className="proof-line"><span>03</span><b>Anchor evidence</b><span className="proof-pending">PENDING</span></div></div>
        </div>
        <div className="auth-side-footer"><span>SECURE ISSUANCE WORKSPACE</span><span>V 0.1 · LOCAL</span></div>
      </div>
      <div className="auth-main">
        <div className="auth-status"><span className={`signal-dot ${health?.ok ? '' : 'offline'}`} />{health?.ok ? 'API SERVICE AVAILABLE' : 'API SERVICE OFFLINE'}</div>
        <div className="auth-card">
          <div className="auth-heading"><span className="eyebrow">INSTITUTION ACCESS</span><h2>{mode === 'login' ? 'Welcome back' : 'Create issuer access'}</h2><p>{mode === 'login' ? 'Sign in to manage institution credentials.' : 'Create a local institution and its first issuer account.'}</p></div>
          {error && <div className="inline-error"><AlertTriangle size={15} />{error}</div>}
          <form onSubmit={(event) => void submit(event)} className="form-stack">
            {mode === 'setup' && <><Field label="Institution name" value={institution} onChange={setInstitution} placeholder="e.g. Northbridge University" required minLength={2} /><Field label="Issuer name" value={name} onChange={setName} placeholder="Registrar Office" required minLength={2} /></>}
            <Field label="Work email" type="email" value={email} onChange={setEmail} placeholder="name@institution.edu" required />
            <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 12 characters" required minLength={mode === 'setup' ? 12 : 8} />
            <button className="button primary full" type="submit" disabled={busy || !health?.ok}>{busy ? <LoaderCircle size={17} className="spin" /> : <LockKeyhole size={16} />}{mode === 'login' ? 'Sign in' : 'Create workspace'}</button>
          </form>
          {bootstrapEnabled && <button className="text-button switch-mode" onClick={() => { setMode(mode === 'login' ? 'setup' : 'login'); setError(''); }}>{mode === 'login' ? 'Set up a new institution' : 'Already have an issuer account? Sign in'}</button>}
          <button className="text-button public-verify-link" onClick={onPublicVerify}><Fingerprint size={15} /> Verify a document without signing in <ArrowUpRight size={13} /></button>
          {health?.persistence === 'volatile' && <p className="auth-disclaimer"><AlertTriangle size={14} /> Local demo records are held in memory and reset when the API restarts.</p>}
        </div>
        <div className="auth-legal">DOCUMENT CONTENT STAYS OFF-CHAIN <span>·</span> VERIFICATION USES THE ORIGINAL FILE</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder, required, minLength }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; required?: boolean; minLength?: number }) {
  return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} minLength={minLength} autoComplete={type === 'password' ? 'current-password' : undefined} /></label>;
}

function Notice({ notice, onDismiss }: { notice: { kind: 'success' | 'error'; text: string }; onDismiss: () => void }) {
  return <div className={`notice ${notice.kind}`} role="status">{notice.kind === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span>{notice.text}</span><button className="icon-button" onClick={onDismiss} aria-label="Dismiss notification"><XCircle size={16} /></button></div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Overview({ user, counts, credentials, onNavigate, onSelect }: { user: User; counts: { total: number; pending: number; anchored: number; revoked: number }; credentials: Credential[]; onNavigate: (view: View) => void; onSelect: (credential: Credential) => void }) {
  const recent = [...credentials].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return (
    <section className="page-content">
      <PageHeading eyebrow="OVERVIEW / INSTITUTION" title="Credential register" description={`Issuance and verification activity for ${user.name}.`} action={<button className="button primary" onClick={() => onNavigate('issue')}><FilePlus2 size={16} />Issue credential</button>} />
      <div className="stat-grid">
        <StatCard label="Total credentials" value={counts.total} icon={<Files size={17} />} tone="ink" />
        <StatCard label="Awaiting anchor" value={counts.pending} icon={<Clock3 size={17} />} tone="amber" />
        <StatCard label="Anchored" value={counts.anchored} icon={<BadgeCheck size={17} />} tone="green" />
        <StatCard label="Revoked" value={counts.revoked} icon={<XCircle size={17} />} tone="rose" />
      </div>
      <div className="overview-grid">
        <section className="panel register-panel">
          <div className="panel-heading"><div><div className="eyebrow">LATEST RECORDS</div><h2>Recent credentials</h2></div><button className="text-button" onClick={() => onNavigate('credentials')}>View register <ArrowUpRight size={14} /></button></div>
          {recent.length ? <CredentialTable credentials={recent} onSelect={onSelect} /> : <EmptyState title="No credentials issued" text="Issued credentials will appear here with their verification and anchoring status." action={<button className="button secondary" onClick={() => onNavigate('issue')}><FilePlus2 size={15} />Issue first credential</button>} />}
        </section>
        <aside className="side-stack">
          <section className="panel integrity-panel"><div className="integrity-seal"><ShieldCheck size={25} /></div><div className="eyebrow">INTEGRITY PIPELINE</div><h2>Signed at issuance</h2><p>Files are hashed and encrypted before storage. The issuer signature is verified against its institution key.</p><div className="integrity-foot"><span><CheckCircle2 size={14} /> FILE DIGEST</span><span><CheckCircle2 size={14} /> ISSUER KEY</span></div></section>
          <section className="panel chain-panel"><div className="chain-heading"><span className="chain-dot" /><div><div className="eyebrow">ANCHOR NETWORK</div><strong>Local Hardhat</strong></div></div><p>Credentials remain pending until a confirmed batch root is registered on-chain.</p><span className="network-pill"><span /> CHAIN 31337</span></section>
        </aside>
      </div>
      <div className="operational-note"><Fingerprint size={16} /><span><strong>Verification checks the original bytes.</strong> A valid signature does not override revoked lifecycle status or missing anchor confirmation.</span></div>
    </section>
  );
}

function StatCard({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: string }) {
  return <div className={`stat-card ${tone}`}><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value.toLocaleString()}</strong><div className="stat-foot">CURRENT WORKSPACE</div></div>;
}

function IssueView({ busy, onSubmit }: { busy: boolean; onSubmit: (form: FormData) => Promise<void> }) {
  const [holder, setHolder] = useState('');
  const [version, setVersion] = useState('1');
  const [file, setFile] = useState<File | null>(null);
  return (
    <section className="page-content">
      <PageHeading eyebrow="CREDENTIALS / NEW ISSUE" title="Issue a credential" description="Create a signed credential from the exact document file. The issuer identity is taken from your session." />
      <div className="issue-layout">
        <form className="panel issue-form" onSubmit={(event) => { event.preventDefault(); if (file) { const form = new FormData(); form.set('holderReference', holder); form.set('credentialVersion', version); form.set('credentialFile', file); void onSubmit(form); } }}>
          <div className="form-section-title"><span className="section-index">01</span><div><h2>Credential details</h2><p>Institution-scoped holder reference and version.</p></div></div>
          <Field label="Holder reference" value={holder} onChange={setHolder} placeholder="e.g. student-2025-0184" required minLength={1} />
          <Field label="Credential version" type="number" value={version} onChange={setVersion} required minLength={1} />
          <div className="form-section-title file-section-title"><span className="section-index">02</span><div><h2>Original document</h2><p>The original bytes are hashed, encrypted, and stored off-chain.</p></div></div>
          <label className={`dropzone ${file ? 'has-file' : ''}`}>
            <input type="file" accept="application/pdf,application/json,text/plain,image/png,.pdf,.json,.txt,.png" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
            <span className="upload-icon">{file ? <FileCheck2 size={21} /> : <Upload size={21} />}</span>
            <span className="dropzone-title">{file ? file.name : 'Choose a document'}</span>
            <span className="dropzone-help">PDF, JSON, TXT, PNG · up to 10 MB</span>
            {file && <span className="file-size">{(file.size / 1024).toFixed(1)} KB</span>}
          </label>
          <div className="form-actions"><span><LockKeyhole size={14} /> Issuer signature applied by API</span><button className="button primary" disabled={busy || !file}>{busy ? <LoaderCircle size={16} className="spin" /> : <FilePlus2 size={16} />}Issue credential</button></div>
        </form>
        <aside className="panel issue-aside"><div className="eyebrow">ISSUANCE SEQUENCE</div><SequenceStep number="01" title="Hash" text="SHA-256 is calculated from the uploaded file bytes." done /><SequenceStep number="02" title="Sign" text="The active issuer key signs a canonical credential payload." done /><SequenceStep number="03" title="Encrypt" text="The original file is encrypted before storage." done /><SequenceStep number="04" title="Anchor" text="A batch root is registered separately; new credentials begin pending." /><div className="offchain-note"><Fingerprint size={16} /><span>Document content and personal data are not written to the blockchain.</span></div></aside>
      </div>
    </section>
  );
}

function SequenceStep({ number, title, text, done }: { number: string; title: string; text: string; done?: boolean }) {
  return <div className="sequence-step"><span className={`sequence-number ${done ? 'done' : ''}`}>{done ? <Check size={13} /> : number}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

function CredentialRegister({ credentials, selected, busy, onSelect, onRevoke, onRefresh }: { credentials: Credential[]; selected: Credential | null; busy: boolean; onSelect: (credential: Credential) => void; onRevoke: (id: string) => Promise<void>; onRefresh: () => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('ALL');
  const filtered = useMemo(() => credentials.filter((credential) => {
    const matchesSearch = `${credential.holderReference} ${credential.id} ${credential.documentDigest}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (filter === 'ALL' || credential.lifecycleStatus === filter);
  }), [credentials, search, filter]);
  return (
    <section className="page-content">
      <PageHeading eyebrow="CREDENTIALS / REGISTER" title="Credential register" description="Search signed credential records and review their lifecycle status." action={<button className="button secondary" onClick={onRefresh}><ArrowDownToLine size={15} />Refresh</button>} />
      <div className="register-toolbar"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search holder, ID, or digest" /></label><div className="filter-group">{['ALL', 'PENDING_ANCHOR', 'ANCHORED', 'REVOKED'].map((status) => <button key={status} className={`filter-chip ${filter === status ? 'selected' : ''}`} onClick={() => setFilter(status)}>{status === 'PENDING_ANCHOR' ? 'Pending' : status === 'ALL' ? 'All records' : status.charAt(0) + status.slice(1).toLowerCase()}</button>)}</div><span className="result-count">{filtered.length} RECORDS</span></div>
      <div className="register-detail-layout"><section className="panel register-panel"><CredentialTable credentials={filtered} onSelect={onSelect} selectedId={selected?.id} /></section>{selected && <CredentialDetail credential={selected} busy={busy} onRevoke={() => void onRevoke(selected.id)} />}</div>
      {!filtered.length && <div className="panel empty-register"><EmptyState title="No matching credentials" text="Try another search or lifecycle filter." /></div>}
    </section>
  );
}

function CredentialTable({ credentials, onSelect, selectedId }: { credentials: Credential[]; onSelect: (credential: Credential) => void; selectedId?: string }) {
  if (!credentials.length) return <div className="table-empty">No credential records yet.</div>;
  return (
    <div className="table-wrap"><table className="credential-table"><thead><tr><th>HOLDER REFERENCE</th><th>CREDENTIAL ID</th><th>ISSUED</th><th>STATUS</th><th /></tr></thead><tbody>{credentials.map((credential) => <tr key={credential.id} className={selectedId === credential.id ? 'selected-row' : ''} onClick={() => onSelect(credential)}><td><strong>{credential.holderReference}</strong><small>Version {credential.credentialVersion}</small></td><td><code>{shortId(credential.id)}</code></td><td>{formatDate(credential.issuedAt)}</td><td><StatusBadge status={credential.lifecycleStatus} /></td><td><ArrowUpRight size={15} className="row-arrow" /></td></tr>)}</tbody></table></div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${lifecycleTone(status)}`}><span />{status.replaceAll('_', ' ')}</span>;
}

function CredentialDetail({ credential, busy, onRevoke }: { credential: Credential; busy: boolean; onRevoke: () => void }) {
  const [showDigest, setShowDigest] = useState(false);
  return <aside className="panel detail-panel"><div className="detail-heading"><div><div className="eyebrow">CREDENTIAL DETAIL</div><h2>{credential.holderReference}</h2></div><StatusBadge status={credential.lifecycleStatus} /></div><dl className="detail-list"><DetailItem label="Credential ID" value={credential.id} mono /><DetailItem label="Issuer ID" value={credential.issuerId} mono /><DetailItem label="Issuer key" value={shortId(credential.issuerKeyId)} mono /><DetailItem label="Version" value={String(credential.credentialVersion)} /><DetailItem label="Issued" value={formatDate(credential.issuedAt)} /><DetailItem label="Anchor state" value={credential.anchorState ?? 'QUEUED'} /><DetailItem label="Anchor deadline" value={formatDate(credential.deadlineAt)} />{credential.anchorBatchId && <DetailItem label="Batch ID" value={credential.anchorBatchId} mono />}{credential.anchorTransactionHash && <DetailItem label="Anchor transaction" value={shortId(credential.anchorTransactionHash)} mono />}{credential.anchorBlockNumber && <DetailItem label="Anchor block" value={credential.anchorBlockNumber} />}{credential.revocationState && <DetailItem label="Revocation state" value={credential.revocationState} />}{credential.revocationTransactionHash && <DetailItem label="Revocation transaction" value={shortId(credential.revocationTransactionHash)} mono />}</dl>{credential.anchorRoot && <div className="digest-box"><div className="digest-title"><ShieldCheck size={14} /> ON-CHAIN BATCH ROOT</div><code>{credential.anchorRoot}</code></div>}<div className="digest-box"><div className="digest-title"><Fingerprint size={14} /> DOCUMENT SHA-256 <button className="text-button" onClick={() => setShowDigest(!showDigest)}>{showDigest ? 'Hide' : 'Show'}</button></div><code>{showDigest ? credential.documentDigest : `${credential.documentDigest.slice(0, 12)}…${credential.documentDigest.slice(-10)}`}</code></div><div className="detail-footnote"><Clock3 size={14} /><span>Issuer signature, Merkle inclusion, and on-chain revocation are checked independently.</span></div>{credential.lifecycleStatus !== 'REVOKED' && <button className="button danger-outline full" disabled={busy} onClick={() => { if (window.confirm('Revoke this credential? If it has been anchored, revocation will be submitted on-chain.')) onRevoke(); }}><XCircle size={15} />Revoke credential</button>}</aside>;
}

function DetailItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{value}</dd></div>;
}

function VerifyView({ credentials }: { credentials: Credential[] }) {
  return <section className="page-content"><PageHeading eyebrow="VERIFICATION / DOCUMENT" title="Verify a document" description="Compare the uploaded original file with the signed credential record." /><VerifyPanel credentials={credentials} /></section>;
}

function VerifyOnly({ onBack }: { onBack: () => void }) {
  return <div className="verify-only-shell"><header className="verify-only-header"><a className="brand" href="#verify"><span className="brand-mark"><ShieldCheck size={19} /></span><span className="brand-copy"><strong>VERIFIED</strong><small>DOCUMENT VAULT</small></span></a><button className="text-button" onClick={onBack}>Issuer sign in <ArrowUpRight size={14} /></button></header><main className="verify-only-main"><PageHeading eyebrow="PUBLIC VERIFICATION" title="Verify a credential" description="Upload the original file to check its digest and issuer signature. Verification does not imply blockchain confirmation." /><VerifyPanel /></main></div>;
}

function VerifyPanel({ credentials = [] }: { credentials?: Credential[] }) {
  const [credentialId, setCredentialId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const form = new FormData();
      form.set('credentialId', credentialId.trim());
      form.set('credentialFile', file);
      setResult(await request<Verification>('/api/v1/verify', { method: 'POST', body: form }));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Verification request failed');
    } finally {
      setBusy(false);
    }
  }
  return <div className="verify-layout"><form className="panel verify-form" onSubmit={(event) => void submit(event)}><div className="form-section-title"><span className="section-index">01</span><div><h2>Credential reference</h2><p>Enter the credential ID from the issuer record.</p></div></div><label className="field"><span>Credential ID</span><input value={credentialId} onChange={(event) => setCredentialId(event.target.value)} list="credential-ids" placeholder="cred_…" required /></label><datalist id="credential-ids">{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.holderReference}</option>)}</datalist><div className="form-section-title file-section-title"><span className="section-index">02</span><div><h2>Original document file</h2><p>Verification hashes the exact uploaded bytes.</p></div></div><label className={`dropzone verify-dropzone ${file ? 'has-file' : ''}`}><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /><span className="upload-icon">{file ? <FileCheck2 size={21} /> : <Upload size={21} />}</span><span className="dropzone-title">{file ? file.name : 'Choose original file'}</span><span className="dropzone-help">Use the exact file originally issued.</span></label>{error && <div className="inline-error"><AlertTriangle size={15} />{error}</div>}<button className="button primary" type="submit" disabled={busy || !file}>{busy ? <LoaderCircle size={16} className="spin" /> : <Fingerprint size={16} />}Verify document</button></form><div className="verify-result-wrap">{result ? <VerificationResult result={result} /> : <div className="panel verify-empty"><div className="verify-empty-mark"><Fingerprint size={25} /></div><div className="eyebrow">VERIFICATION RESULT</div><h2>Awaiting document</h2><p>The service checks the document digest and issuer signature, then returns current lifecycle status.</p><div className="result-checklist"><span><CheckCircle2 size={14} /> Document digest</span><span><CheckCircle2 size={14} /> Issuer signature</span><span><CheckCircle2 size={14} /> Lifecycle status</span></div></div>}</div></div>;
}

function VerificationResult({ result }: { result: Verification }) {
  const valid = result.status === 'VALID';
  const invalid = result.status.startsWith('INVALID');
  return <section className={`panel verification-result ${valid ? 'valid' : invalid ? 'invalid' : 'unknown'}`}><div className="result-icon">{valid ? <CheckCircle2 size={23} /> : invalid ? <XCircle size={23} /> : <AlertTriangle size={23} />}</div><div className="eyebrow">VERIFICATION RESULT</div><h2>{valid ? 'Document verified' : invalid ? 'Document mismatch' : result.status.replaceAll('_', ' ')}</h2><p>{valid ? 'The uploaded bytes match the signed credential digest and issuer signature.' : result.status === 'REVOCATION_PENDING' ? 'The issuer has revoked this credential; the on-chain revocation transaction is still pending.' : result.status === 'ANCHOR_UNAVAILABLE' ? 'The signature is valid, but the registry could not be reached to confirm inclusion.' : invalid ? 'The uploaded file does not match the issued document or its signature check failed.' : 'No matching credential record could be verified.'}</p><div className="result-meta"><DetailItem label="Credential" value={result.credentialId ?? 'Not found'} mono />{result.lifecycleStatus && <DetailItem label="Lifecycle" value={result.lifecycleStatus} />}<DetailItem label="On-chain evidence" value={result.anchorStatus ?? 'Not confirmed'} />{result.anchorTransactionHash && <DetailItem label="Anchor transaction" value={shortId(result.anchorTransactionHash)} mono />}{result.anchorBlockNumber && <DetailItem label="Anchor block" value={result.anchorBlockNumber} />}{result.revocationState && <DetailItem label="Revocation state" value={result.revocationState} />}</div>{valid && result.anchorStatus !== 'CONFIRMED' && <div className="verification-caveat"><AlertTriangle size={14} />Signature valid; blockchain inclusion is not confirmed.</div>}</section>;
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark"><Files size={20} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

export default App;
