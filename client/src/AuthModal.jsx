import { useState } from 'react';
import { supabase } from './supabase.js';

function fieldError(e) {
  try {
    return JSON.parse(e.message)[0];
  } catch {
    return null;
  }
}

export default function AuthModal({ onClose, onAuthed }) {
  const [view, setView] = useState('form'); // 'form' | 'forgot'
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function submit() {
    setError(null);
    setNotice(null);

    if (mode === 'signup' && !name.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (mode === 'signup') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError('Enter a valid email address.');
        return;
      }
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      if (mode === 'signup') {
        const meta = name.trim()
          ? { data: { full_name: name.trim() } }
          : {};
        const { data, error: e } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: window.location.origin,
            ...meta,
          },
        });
        if (e) throw e;
        if (!data.session) {
          setMode('login');
          setNotice(
            'Account created! Check your inbox for a confirmation link, then sign in below.'
          );
        } else {
          onClose();
          onAuthed?.();
        }
      } else {
        const { error: e } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (e) {
          const f = fieldError(e);
          if (f && (f.code === 'email_not_confirmed' || /confirm/i.test(f.message || ''))) {
            setNotice('This email is not confirmed yet. Check your inbox for the confirmation link.');
          } else {
            setError(f?.message || e.message || 'Sign-in failed.');
          }
        } else {
          onClose();
          onAuthed?.();
        }
      }
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot() {
    setError(null);
    setNotice(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (e) throw e;
      setNotice('Password reset link sent! Check your inbox.');
      setBusy(false);
    } catch (e) {
      setError(e.message || 'Could not send reset email.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal--auth"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h3>
            {view === 'forgot'
              ? 'Reset password'
              : mode === 'login'
              ? 'Log in'
              : 'Create account'}
          </h3>
          <button className="modal__close" onClick={onClose} type="button" aria-label="Close">
            ×
          </button>
        </div>

        {view === 'forgot' ? (
          <>
            <p className="auth__note">
              Enter the email you signed up with and we&apos;ll send you a link to reset your
              password.
            </p>

            <label className="modal__label">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                spellCheck="false"
              />
            </label>

            {error && <div className="modal__error">{error}</div>}
            {notice && <div className="modal__success">{notice}</div>}

            <div className="modal__actions">
              <button className="modal__save" onClick={submitForgot} disabled={busy} type="button">
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
            </div>
            <div className="auth__alt">
              <button type="button" onClick={() => { setView('form'); setError(null); setNotice(null); }}>
                ← Back to log in
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="auth__tabs" role="tablist">
              <button
                type="button"
                data-active={mode === 'login'}
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setNotice(null);
                }}
              >
                Log in
              </button>
              <button
                type="button"
                data-active={mode === 'signup'}
                onClick={() => {
                  setMode('signup');
                  setError(null);
                  setNotice(null);
                }}
              >
                Sign up
              </button>
            </div>

            {mode === 'signup' && (
              <label className="modal__label">
                Name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  spellCheck="false"
                />
              </label>
            )}

            <label className="modal__label">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                spellCheck="false"
              />
            </label>

            <label className="modal__label">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
            </label>

            {mode === 'signup' && (
              <label className="modal__label">
                Confirm password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                />
              </label>
            )}

            {error && <div className="modal__error">{error}</div>}
            {notice && <div className="modal__success">{notice}</div>}

            {mode === 'login' && (
              <div className="auth__forgot">
                <button
                  type="button"
                  onClick={() => { setView('forgot'); setError(null); setNotice(null); }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <div className="modal__actions">
              <button className="modal__save" onClick={submit} disabled={busy} type="button">
                {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}