// Migration schema "upload" và user streamforge_upload. Chạy bằng Job migration (tài khoản master).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@streamforge/shared/migrate';

runMigrations({
  schema: 'upload',
  user: 'streamforge_upload',
  dir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
}).catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
