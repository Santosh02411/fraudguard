import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth, api } from '../context/AuthContext';
import { Shield, ShieldCheck } from 'lucide-react';

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA challenge step — set once POST /login responds with
  // mfaRequired: true, instead of tokens directly.
  const [mfaToken, setMfaToken] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  const { login, verifyMfaLogin, register } = useAuth();
  const navigate = useNavigate();

  const describeError = (err, fallback) => {
    const data = err.response?.data;
    if (data?.details?.length) {
      // Zod validation errors (e.g. password strength) — show every
      // rule that failed, not just a generic "Validation failed".
      return data.details.map(d => d.message).join(' ');
    }
    return data?.error || fallback;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const result = await login(form.username, form.password);
        if (result.mfaRequired) {
          setMfaToken(result.mfaToken);
        } else {
          navigate('/dashboard');
        }
      } else if (mode === 'register') {
        await register(form.username, form.email, form.password);
        navigate('/dashboard');
      } else if (mode === 'forgot') {
        const { data } = await api.post('/auth/forgot-password', { email: form.email });
        setMessage(data.message);
      }
    } catch (err) {
      setError(describeError(err, 'Something went wrong'));
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyMfaLogin(mfaToken, mfaCode);
      navigate('/dashboard');
    } catch (err) {
      setError(describeError(err, 'Invalid code'));
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full bg-[#0d1117] border border-white/20 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-purple-500 transition-colors";
  const labelClass = "block text-sm text-gray-300 mb-1";

  if (mfaToken) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 text-purple-400 mb-2">
              <ShieldCheck size={40} />
            </div>
            <h1 className="text-3xl font-bold text-white">Two-Factor Verification</h1>
            <p className="text-gray-400 mt-1">Enter the 6-digit code from your authenticator app</p>
          </div>

          <div className="bg-[#161b22] border border-white/10 rounded-2xl p-8">
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <div>
                <label className={labelClass}>Authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value.trim())}
                  className={`${inputClass} text-center text-xl tracking-[0.3em]`}
                  placeholder="123456"
                  maxLength={11}
                  autoFocus
                  required
                />
                <p className="text-xs text-gray-500 mt-1">Lost your device? You can also enter one of your backup codes.</p>
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
              >
                {loading ? 'Verifying...' : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => { setMfaToken(null); setMfaCode(''); setError(''); }}
                className="w-full text-gray-400 hover:text-white text-sm py-1"
              >
                Back to login
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 text-purple-400 mb-2">
            <Shield size={40} />
          </div>
          <h1 className="text-3xl font-bold text-white">FraudGuard</h1>
          <p className="text-gray-400 mt-1">AI-powered fraud detection system</p>
        </div>

        <div className="bg-[#161b22] border border-white/10 rounded-2xl p-8">
          {mode !== 'forgot' && (
            <div className="flex gap-2 mb-6 bg-[#0d1117] rounded-lg p-1">
              {['login', 'register'].map(m => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setError(''); setMessage(''); }}
                  className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
                    mode === m ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {mode === 'forgot' && (
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Reset your password</h2>
              <p className="text-gray-400 text-sm mt-1">Enter your account email and we'll send you a reset link.</p>
            </div>
          )}

          {message ? (
            <div className="bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg px-4 py-3 text-sm">
              {message}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode !== 'forgot' && (
                <div>
                  <label className={labelClass}>Username</label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={e => setForm({ ...form, username: e.target.value })}
                    className={inputClass}
                    placeholder="Enter username"
                    required
                  />
                </div>
              )}

              {(mode === 'register' || mode === 'forgot') && (
                <div>
                  <label className={labelClass}>Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={e => setForm({ ...form, email: e.target.value })}
                    className={inputClass}
                    placeholder="Enter email"
                    required
                  />
                </div>
              )}

              {mode !== 'forgot' && (
                <div>
                  <div className="flex items-center justify-between">
                    <label className={labelClass}>Password</label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => { setMode('forgot'); setError(''); setMessage(''); }}
                        className="text-xs text-purple-400 hover:text-purple-300 mb-1"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    className={inputClass}
                    placeholder="Enter password"
                    required
                  />
                  {mode === 'register' && (
                    <p className="text-xs text-gray-500 mt-1">
                      At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
                    </p>
                  )}
                </div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-3 rounded-lg font-medium transition-colors"
              >
                {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Send Reset Link'}
              </button>

              {mode === 'forgot' && (
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); setMessage(''); }}
                  className="w-full text-gray-400 hover:text-white text-sm py-1"
                >
                  Back to login
                </button>
              )}
            </form>
          )}

          {mode === 'forgot' && message && (
            <button
              onClick={() => { setMode('login'); setMessage(''); }}
              className="w-full text-gray-400 hover:text-white text-sm py-1 mt-4"
            >
              Back to login
            </button>
          )}

          {mode === 'login' && (
            <div className="mt-4 p-3 bg-white/5 rounded-lg text-xs text-gray-400">
              <strong className="text-gray-300">Default admin:</strong> username: <code className="text-purple-300">admin</code> / password: <code className="text-purple-300">admin123</code>
            </div>
          )}
        </div>

        <p className="text-center text-gray-500 text-xs mt-4">
          Verifying your email? <Link to="/verify-email" className="text-purple-400 hover:text-purple-300">Enter your verification link here</Link>
        </p>
      </div>
    </div>
  );
}
