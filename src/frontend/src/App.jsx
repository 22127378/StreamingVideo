import { useCallback, useEffect, useState } from 'react';
import { getMe, upgradeToPremium } from './api.js';
import { initAuth, isLoggedIn, logout, refreshSession, sessionEmail, setDevSession } from './auth.js';
import AuthModal from './components/AuthModal.jsx';
import HomePage from './pages/HomePage.jsx';
import UploadPage from './pages/UploadPage.jsx';
import WatchPage from './pages/WatchPage.jsx';
import { href, useRoute } from './router.js';

export default function App() {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [user, setUser] = useState(null); // { sub, email, tier, admin }
  const [showAuth, setShowAuth] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const loadUser = useCallback(async () => {
    if (!(await isLoggedIn())) {
      setUser(null);
      return null;
    }
    try {
      const { data } = await getMe();
      const me = { ...data, email: data.email || (await sessionEmail()) };
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    initAuth()
      .then(loadUser)
      .catch((err) => setAuthError(err.message))
      .finally(() => setReady(true));
  }, [loadUser]);

  const login = () => setShowAuth(true);

  const afterSignIn = async () => {
    setShowAuth(false);
    await loadUser();
  };

  const signOut = () => {
    logout();
    setUser(null);
  };

  // Mô phỏng thanh toán: thêm vào group premium, làm mới token để nhận gói mới.
  // user đổi thì trang xem tự xin lại quyền phát (cookie mở cả bản 1080p).
  const upgrade = async () => {
    if (!user) {
      login();
      return;
    }
    setUpgrading(true);
    try {
      const { data } = await upgradeToPremium();
      if (data.token) setDevSession({ token: data.token, email: user?.email });
      if (data.refreshRequired) await refreshSession();
      await loadUser();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.home}>
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <path d="M12 9l12 7-12 7z" fill="#0b0d12" />
            </svg>
          </span>
          <span>StreamForge</span>
        </a>

        <nav className="nav" aria-label="Chính">
          <a href={href.home} className={route.page === 'home' ? 'active' : ''}>
            Trang chủ
          </a>
          <a href={href.upload} className={route.page === 'upload' ? 'active' : ''}>
            Đăng video
          </a>
        </nav>

        <div className="account">
          {user ? (
            <>
              <span className="user-email" title={user.email}>
                {user.email}
              </span>
              {user.admin && <span className="tier-pill admin">Admin</span>}
              <span className={`tier-pill ${user.tier}`}>{user.tier === 'premium' ? 'Premium' : 'Free'}</span>
              {user.tier !== 'premium' && !user.admin && (
                <button className="primary small" onClick={upgrade} disabled={upgrading}>
                  {upgrading ? 'Đang nâng cấp...' : 'Nâng cấp Premium'}
                </button>
              )}
              <button className="secondary small" onClick={signOut}>
                Đăng xuất
              </button>
            </>
          ) : (
            ready && (
              <button className="primary small" onClick={login}>
                Đăng nhập
              </button>
            )
          )}
        </div>
      </header>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSignedIn={afterSignIn} />}
      {authError && <p className="notice error">Lỗi đăng nhập: {authError}</p>}

      {ready && route.page === 'home' && <HomePage />}
      {ready && route.page === 'watch' && (
        <WatchPage id={route.id} user={user} onLogin={login} onUpgrade={upgrade} upgrading={upgrading} />
      )}
      {ready && route.page === 'upload' && <UploadPage user={user} onLogin={login} />}
    </div>
  );
}
