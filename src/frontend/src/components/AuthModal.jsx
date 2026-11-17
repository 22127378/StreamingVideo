import { useEffect, useRef, useState } from 'react';
import { devLogin } from '../api.js';
import {
  authErrorMessage,
  authMode,
  confirmNewPassword,
  confirmSignUp,
  forgotPassword,
  resendCode,
  setDevSession,
  signIn,
  signUp,
} from '../auth.js';

const TITLES = {
  signin: 'Đăng nhập',
  signup: 'Tạo tài khoản',
  confirm: 'Xác minh email',
  forgot: 'Quên mật khẩu',
  reset: 'Đặt mật khẩu mới',
  dev: 'Đăng nhập (chế độ dev)',
};

const SUBTITLES = {
  signin: 'Xem video, upload và quản lý thư viện của bạn.',
  signup: 'Miễn phí. Nâng cấp Premium bất cứ lúc nào để xem toàn bộ video.',
  confirm: 'Nhập mã 6 số vừa được gửi tới email của bạn.',
  forgot: 'Nhập email, chúng tôi sẽ gửi mã để đặt lại mật khẩu.',
  reset: 'Nhập mã trong email và mật khẩu mới.',
  dev: 'Không có Cognito khi chạy local: nhập email bất kỳ và chọn gói.',
};

function PasswordInput({ value, onChange, autoComplete, label = 'Mật khẩu' }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="password">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          minLength={8}
          required
        />
        <button type="button" className="reveal" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
          {visible ? 'Ẩn' : 'Hiện'}
        </button>
      </div>
    </label>
  );
}

export default function AuthModal({ onClose, onSignedIn }) {
  const [view, setView] = useState(authMode() === 'dev' ? 'dev' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [tier, setTier] = useState('free');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector('input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, view]);

  const go = (next, message = '') => {
    setView(next);
    setError('');
    setInfo(message);
    setCode('');
  };

  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      if (err?.code === 'UserNotConfirmedException') {
        go('confirm', 'Tài khoản chưa xác minh. Nhập mã đã gửi tới email của bạn.');
        resendCode(email).catch(() => {});
      } else {
        setError(authErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (view === 'signin') {
      run(async () => {
        await signIn(email, password);
        onSignedIn();
      });
    } else if (view === 'signup') {
      if (password !== confirm) {
        setError('Hai mật khẩu không khớp.');
        return;
      }
      run(async () => {
        await signUp(email, password);
        go('confirm', `Đã gửi mã xác minh tới ${email}.`);
      });
    } else if (view === 'confirm') {
      run(async () => {
        await confirmSignUp(email, code);
        if (password) {
          await signIn(email, password);
          onSignedIn();
        } else {
          go('signin', 'Email đã xác minh. Đăng nhập để tiếp tục.');
        }
      });
    } else if (view === 'forgot') {
      run(async () => {
        await forgotPassword(email);
        go('reset', `Đã gửi mã tới ${email}.`);
      });
    } else if (view === 'reset') {
      run(async () => {
        await confirmNewPassword(email, code, password);
        await signIn(email, password);
        onSignedIn();
      });
    } else if (view === 'dev') {
      run(async () => {
        const { data } = await devLogin({ email, tier });
        setDevSession({ token: data.token, email });
        onSignedIn();
      });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auth-shell" role="dialog" aria-modal="true" aria-labelledby="auth-title" ref={dialogRef}>
        <aside className="auth-hero" aria-hidden="true">
          <div className="hero-tiles">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className={`tile t${i % 5}`} />
            ))}
          </div>
          <div className="hero-copy">
            <p className="hero-kicker">StreamForge</p>
            <h3>Video của bạn, phát mượt ở mọi màn hình.</h3>
            <ul>
              <li>Upload tới 2 GB, tự chuyển sang 1080p, 720p, 480p, 360p</li>
              <li>Phát qua CDN gần bạn, tự đổi chất lượng theo mạng</li>
              <li>Gói Premium mở khoá toàn bộ thư viện</li>
            </ul>
          </div>
        </aside>

        <section className="auth-card">
        <button className="close" onClick={onClose} aria-label="Đóng">
          ×
        </button>

        <div className="auth-brand">
          <svg viewBox="0 0 32 32" width="36" height="36" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M12 9l12 7-12 7z" fill="#0b0d12" />
          </svg>
          <span>StreamForge</span>
        </div>

        {(view === 'signin' || view === 'signup') && (
          <div className="auth-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'signin'} className={view === 'signin' ? 'active' : ''} onClick={() => go('signin')}>
              Đăng nhập
            </button>
            <button role="tab" aria-selected={view === 'signup'} className={view === 'signup' ? 'active' : ''} onClick={() => go('signup')}>
              Đăng ký
            </button>
          </div>
        )}

        <h2 id="auth-title">{TITLES[view]}</h2>
        <p className="auth-sub">{SUBTITLES[view]}</p>

        <form onSubmit={submit} className="auth-form">
          {view !== 'confirm' && view !== 'reset' && (
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="ban@example.com"
                required
              />
            </label>
          )}

          {(view === 'confirm' || view === 'reset') && (
            <label className="field">
              <span>Mã xác minh</span>
              <input
                className="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                required
              />
            </label>
          )}

          {view === 'signin' && <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />}
          {(view === 'signup' || view === 'reset') && (
            <>
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                label={view === 'reset' ? 'Mật khẩu mới' : 'Mật khẩu'}
              />
              {view === 'signup' && (
                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" label="Nhập lại mật khẩu" />
              )}
              <p className="hint">Ít nhất 8 ký tự.</p>
            </>
          )}

          {view === 'dev' && (
            <label className="field">
              <span>Gói</span>
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="free">Free</option>
                <option value="premium">Premium</option>
              </select>
            </label>
          )}

          {view === 'signin' && (
            <button type="button" className="link forgot" onClick={() => go('forgot')}>
              Quên mật khẩu?
            </button>
          )}

          {info && <p className="auth-info">{info}</p>}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button className="primary block" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {
              {
                signin: 'Đăng nhập',
                signup: 'Tạo tài khoản',
                confirm: 'Xác minh',
                forgot: 'Gửi mã',
                reset: 'Đặt mật khẩu',
                dev: 'Vào',
              }[view]
            }
          </button>
        </form>

        <div className="auth-foot">
          {view === 'confirm' && (
            <button className="link" disabled={busy} onClick={() => run(async () => { await resendCode(email); setInfo('Đã gửi lại mã.'); })}>
              Gửi lại mã
            </button>
          )}
          {(view === 'forgot' || view === 'reset' || view === 'confirm') && (
            <button className="link" onClick={() => go('signin')}>
              Quay lại đăng nhập
            </button>
          )}
        </div>
        </section>
      </div>
    </div>
  );
}
