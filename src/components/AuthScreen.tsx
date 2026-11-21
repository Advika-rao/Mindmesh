import React, { useState } from 'react';
import { BrainCircuit, Mail, Lock, User as UserIcon, ArrowRight, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

type AuthMode = 'login' | 'register' | 'reset';

export const AuthScreen: React.FC = () => {
  const {
    firebaseUser,
    emailVerified,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    requestPasswordReset,
    resendVerificationEmail,
    refreshAuthState,
    logout,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // If user registered with Email/Password and hasn't verified their email yet
  if (firebaseUser && !emailVerified) {
    return (
      <div className="min-h-screen bg-[#080d1a] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#10182b] border border-slate-800 rounded-xl p-8 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
              <Mail className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold text-slate-50">Verify your email</h1>
              <p className="text-xs text-slate-400">{firebaseUser.email}</p>
            </div>
          </div>

          <p className="text-sm text-slate-300 leading-relaxed">
            MindMesh enforces verified accounts to protect your private knowledge repository. Open the verification link sent to your inbox, then click below to enter your workspace.
          </p>

          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {info && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{info}</span>
            </div>
          )}

          <div className="space-y-3">
            <button
              type="button"
              disabled={submitting}
              onClick={async () => {
                setSubmitting(true);
                setError(null);
                try {
                  await refreshAuthState();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Unable to refresh status.');
                } finally {
                  setSubmitting(false);
                }
              }}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${submitting ? 'animate-spin' : ''}`} />
              I verified my email — Continue
            </button>

            <div className="flex items-center justify-between pt-2 text-xs">
              <button
                type="button"
                onClick={async () => {
                  setError(null);
                  setInfo(null);
                  try {
                    await resendVerificationEmail();
                    setInfo('Verification email sent again.');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to resend email.');
                  }
                }}
                className="text-indigo-400 hover:text-indigo-300 font-medium"
              >
                Resend email
              </button>
              <button
                type="button"
                onClick={() => void logout()}
                className="text-slate-400 hover:text-slate-200"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleGoogleLogin = async () => {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'reset') {
        await requestPasswordReset(email);
        setInfo('Password reset link sent. Check your email inbox.');
      } else if (mode === 'register') {
        if (!name.trim()) {
          setError('Please enter your full name.');
          setSubmitting(false);
          return;
        }
        if (password.length < 6) {
          setError('Password must be at least 6 characters.');
          setSubmitting(false);
          return;
        }
        await registerWithEmail(name, email, password);
        setInfo('Account created! Please check your inbox to verify your email address.');
      } else {
        if (!password) {
          setError('Please enter your password.');
          setSubmitting(false);
          return;
        }
        await signInWithEmail(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080d1a] text-slate-100 grid lg:grid-cols-12">
      {/* Left Narrative Column */}
      <div className="lg:col-span-7 p-8 sm:p-12 lg:p-16 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-[#0b1120]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center">
            <BrainCircuit className="w-5 h-5 text-indigo-400" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-slate-50">
            MindMesh
          </span>
        </div>

        <div className="my-12 lg:my-0 max-w-xl space-y-6">
          <p className="text-xs font-medium tracking-wide text-indigo-400">
            Personal Knowledge Management & Intelligent Learning
          </p>
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-slate-50 leading-[1.12] [text-wrap:balance]">
            Turn isolated study notes into a living knowledge network.
          </h1>
          <p className="text-base text-slate-400 leading-relaxed">
            MindMesh unifies your notes into a single private Firestore repository powering six integrated learning modules: Brain Graph, AI Study Assistant, Automatic Mind Maps, Adaptive Quizzes, Memory Revival, and Connection Explanations.
          </p>

          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4 pt-4 border-t border-slate-800/80 text-sm">
            <div>
              <p className="font-medium text-slate-200">Semantic Knowledge Graph</p>
              <p className="text-xs text-slate-400 mt-1">
                Automatically links related notes via embeddings, tags, and shared subjects.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-200">Grounded AI Study Tools</p>
              <p className="text-xs text-slate-400 mt-1">
                Every chat answer, quiz question, and mind map cites your actual notes.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-200">Memory Revival Engine</p>
              <p className="text-xs text-slate-400 mt-1">
                Resurfaces relevant older notes right when you study connected concepts.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-200">Private Isolated Workspace</p>
              <p className="text-xs text-slate-400 mt-1">
                Secured with Firebase Authentication and strict per-user Firestore rules.
              </p>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500">
          MindMesh · Object-Oriented Full-Stack Knowledge Ecosystem
        </p>
      </div>

      {/* Right Authentication Form Column */}
      <div className="lg:col-span-5 p-8 sm:p-12 flex items-center justify-center">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-1.5">
            <h2 className="font-display text-2xl font-bold text-slate-50">
              {mode === 'login'
                ? 'Sign in to MindMesh'
                : mode === 'register'
                  ? 'Create your workspace'
                  : 'Reset your password'}
            </h2>
            <p className="text-sm text-slate-400">
              {mode === 'login'
                ? 'Continue where you left off across all six learning modules.'
                : mode === 'register'
                  ? 'Set up your private AI-powered personal knowledge repository.'
                  : 'Enter your email and we will send a password reset link.'}
            </p>
          </div>

          {/* Primary Google Sign-In */}
          <button
            type="button"
            disabled={submitting}
            onClick={handleGoogleLogin}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-lg bg-white text-slate-900 hover:bg-slate-100 font-medium text-sm transition-colors disabled:opacity-60"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
              />
            </svg>
            Continue with Google
          </button>

          <div className="relative flex items-center py-1">
            <div className="flex-1 border-t border-slate-800" />
            <span className="px-3 text-xs text-slate-500">or use email</span>
            <div className="flex-1 border-t border-slate-800" />
          </div>

          {error && (
            <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2.5 leading-relaxed">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {info && (
            <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2.5 leading-relaxed">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{info}</span>
            </div>
          )}

          <form onSubmit={handleEmailSubmit} className="space-y-4">
            {mode === 'register' && (
              <div className="space-y-1.5">
                <label htmlFor="auth-name" className="block text-xs font-medium text-slate-300">
                  Full Name
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Rivera"
                    required
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#10182b] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@university.edu"
                  required
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#10182b] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
                />
              </div>
            </div>

            {mode !== 'reset' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300">
                    Password
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('reset');
                        setError(null);
                        setInfo(null);
                      }}
                      className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#10182b] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-60"
            >
              {submitting
                ? 'Please wait...'
                : mode === 'login'
                  ? 'Sign In'
                  : mode === 'register'
                    ? 'Create Account'
                    : 'Send Reset Link'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="text-center text-xs text-slate-400 pt-2">
            {mode === 'login' ? (
              <>
                New to MindMesh?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setMode('register');
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
