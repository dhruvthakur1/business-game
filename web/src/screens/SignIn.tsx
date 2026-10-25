import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Logo } from '../components/Icon';
import { Card } from '../components/ui';
import { useGame } from '../state/game';

export function SignIn() {
  const { signIn, signInDemo, status } = useGame();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    api<{ demoLogin?: boolean }>('/health').then((h) => setDemo(!!h.demoLogin)).catch(() => setDemo(false));
  }, []);
  useEffect(() => {
    if (status === 'ready') navigate('/app');
  }, [status, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate('/app');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err.code === 'offline' ? 'The game server is not running.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 16px' }}>
      <Link to="/" className="brand" style={{ marginBottom: 32 }}><Logo size={34} /><span className="brand-name" style={{ fontSize: 21 }}>Mercantile</span></Link>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <h1 className="h-section" style={{ fontSize: 24 }}>Sign in</h1>
        <form className="stack" style={{ gap: 14 }} onSubmit={(e) => void submit(e)}>
          <label className="field">
            Email
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Password
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <span className="loss" role="alert" style={{ fontSize: 13 }}>{error}</span>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <span className="small muted">New here? <Link to="/start">Found your company</Link></span>
        {demo && (
          <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => void signInDemo().then(() => navigate('/app'))}>
            Use the demo company (development)
          </button>
        )}
      </Card>
    </div>
  );
}
