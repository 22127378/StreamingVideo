// Tên hiển thị công khai (chủ kênh, người bình luận). Không lộ email: chỉ lấy phần trước "@".
// - dev: email nằm trong token.
// - cognito: access token chỉ có username (là sub vì user pool đăng nhập bằng email), nên hỏi
//   Cognito (AdminGetUser) một lần rồi nhớ trong bộ nhớ.
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { awsClientConfig } from '@streamforge/shared/aws';
import { authConfig } from '@streamforge/shared/auth';

const MAX_CACHE = 10_000;

export const nameFromEmail = (email) => {
  const local = String(email || '').split('@')[0].trim();
  return local.slice(0, 40) || null;
};

const fallbackName = (sub) => `user-${String(sub).replace(/^dev-/, '').slice(0, 6)}`;

export function createNameResolver({ client, lookup } = {}) {
  const cache = new Map();

  const cognitoLookup =
    lookup ||
    (authConfig.mode === 'cognito'
      ? async (username) => {
          client ??= new CognitoIdentityProviderClient({ ...awsClientConfig, region: authConfig.region });
          const out = await client.send(new AdminGetUserCommand({ UserPoolId: authConfig.userPoolId, Username: username }));
          return out.UserAttributes?.find((a) => a.Name === 'email')?.Value;
        }
      : null);

  /** @param {{ sub: string, username?: string, email?: string }} user */
  return async function displayName(user) {
    if (user.email) return nameFromEmail(user.email) || fallbackName(user.sub);
    if (cache.has(user.sub)) return cache.get(user.sub);
    let name = null;
    if (cognitoLookup) {
      try {
        name = nameFromEmail(await cognitoLookup(user.username || user.sub));
      } catch (err) {
        console.warn(`[live] display name lookup failed: ${err.message}`);
        return fallbackName(user.sub); // không nhớ, lần sau thử lại
      }
    }
    name ||= fallbackName(user.sub);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(user.sub, name);
    return name;
  };
}
