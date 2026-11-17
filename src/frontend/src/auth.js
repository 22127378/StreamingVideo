// Đăng nhập ngay trong trang (không chuyển sang trang của Cognito).
// - cognito: amazon-cognito-identity-js, giao thức SRP: mật khẩu không gửi lên mạng dưới dạng gốc.
//   Thư viện tự lưu phiên trong localStorage và tự làm mới access token bằng refresh token.
// - dev: chạy local không có Cognito, đăng nhập bằng email + chọn gói (POST /api/auth/dev-login).
// API cho biết chế độ và thông tin user pool qua GET /api/auth/config.
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';

const DEV_SESSION_KEY = 'sf-dev-session';

let authConfig = null;
let pool = null;

export async function initAuth() {
  const res = await fetch('/api/auth/config');
  authConfig = (await res.json()).data;
  if (authConfig.mode === 'cognito') {
    pool = new CognitoUserPool({ UserPoolId: authConfig.userPoolId, ClientId: authConfig.clientId });
  }
  return authConfig;
}

export const authMode = () => authConfig?.mode;

function cognitoUser(email) {
  return new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool });
}

/** Phiên Cognito hiện tại (tự refresh), hoặc null */
function currentSession() {
  const user = pool?.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err, session) => resolve(err || !session?.isValid() ? null : session));
  });
}

// ---------- Chế độ dev
function devSession() {
  try {
    const s = JSON.parse(localStorage.getItem(DEV_SESSION_KEY));
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function setDevSession({ token, email }) {
  const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  try {
    localStorage.setItem(DEV_SESSION_KEY, JSON.stringify({ token, email, expiresAt: payload.exp * 1000 }));
  } catch {
    /* bỏ qua */
  }
}

// ---------- Dùng chung
export async function getAccessToken() {
  if (authMode() === 'dev') return devSession()?.token ?? null;
  const session = await currentSession();
  return session ? session.getAccessToken().getJwtToken() : null;
}

export async function sessionEmail() {
  if (authMode() === 'dev') return devSession()?.email;
  const session = await currentSession();
  return session?.getIdToken().decodePayload().email;
}

export async function isLoggedIn() {
  return Boolean(await getAccessToken());
}

/** Làm mới token ngay, ví dụ sau khi được thêm vào group premium */
export async function refreshSession() {
  const user = pool?.getCurrentUser();
  const session = await currentSession();
  if (!user || !session) return;
  await new Promise((resolve, reject) =>
    user.refreshSession(session.getRefreshToken(), (err) => (err ? reject(err) : resolve()))
  );
}

export function logout() {
  try {
    localStorage.removeItem(DEV_SESSION_KEY);
  } catch {
    /* bỏ qua */
  }
  pool?.getCurrentUser()?.signOut();
}

// ---------- Các bước đăng nhập / đăng ký (chế độ cognito)

// Thông báo lỗi Cognito -> tiếng Việt
export function authErrorMessage(err) {
  switch (err?.code || err?.name) {
    case 'NotAuthorizedException':
      return 'Email hoặc mật khẩu không đúng.';
    case 'UserNotConfirmedException':
      return 'Tài khoản chưa xác minh email. Nhập mã đã gửi tới email của bạn.';
    case 'UsernameExistsException':
      return 'Email này đã có tài khoản. Hãy đăng nhập.';
    case 'CodeMismatchException':
      return 'Mã xác minh không đúng.';
    case 'ExpiredCodeException':
      return 'Mã xác minh đã hết hạn. Gửi lại mã mới.';
    case 'InvalidPasswordException':
      return 'Mật khẩu cần ít nhất 8 ký tự.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Thử quá nhiều lần. Chờ vài phút rồi thử lại.';
    case 'UserNotFoundException':
      return 'Không tìm thấy tài khoản với email này.';
    default:
      return err?.message || 'Có lỗi xảy ra, thử lại sau.';
  }
}

export function signIn(email, password) {
  return new Promise((resolve, reject) => {
    cognitoUser(email).authenticateUser(
      new AuthenticationDetails({ Username: email.trim().toLowerCase(), Password: password }),
      {
        onSuccess: resolve,
        onFailure: reject,
        newPasswordRequired: () =>
          reject(Object.assign(new Error('Tài khoản cần đặt mật khẩu mới. Dùng "Quên mật khẩu" để đặt lại.'), {
            code: 'NewPasswordRequired',
          })),
      }
    );
  });
}

export function signUp(email, password) {
  return new Promise((resolve, reject) => {
    pool.signUp(
      email.trim().toLowerCase(),
      password,
      [new CognitoUserAttribute({ Name: 'email', Value: email.trim().toLowerCase() })],
      null,
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

export function confirmSignUp(email, code) {
  return new Promise((resolve, reject) =>
    cognitoUser(email).confirmRegistration(code.trim(), true, (err) => (err ? reject(err) : resolve()))
  );
}

export function resendCode(email) {
  return new Promise((resolve, reject) =>
    cognitoUser(email).resendConfirmationCode((err) => (err ? reject(err) : resolve()))
  );
}

export function forgotPassword(email) {
  return new Promise((resolve, reject) =>
    cognitoUser(email).forgotPassword({ onSuccess: resolve, onFailure: reject, inputVerificationCode: resolve })
  );
}

export function confirmNewPassword(email, code, newPassword) {
  return new Promise((resolve, reject) =>
    cognitoUser(email).confirmPassword(code.trim(), newPassword, { onSuccess: resolve, onFailure: reject })
  );
}
