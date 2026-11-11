import dotenv from 'dotenv';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const main = async () => {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  const email = process.env.SOTH_SYSTEM_ADMIN_EMAIL;
  const fullName = process.env.SOTH_SYSTEM_ADMIN_FULL_NAME;
  const phone = process.env.SOTH_SYSTEM_ADMIN_PHONE;
  const password = process.env.SOTH_SYSTEM_ADMIN_PASSWORD;
  const allowedEmails = (process.env.SYSTEM_ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required.');
  if (!email || !fullName || !phone || !password) {
    throw new Error(
      'Set SOTH_SYSTEM_ADMIN_EMAIL, SOTH_SYSTEM_ADMIN_FULL_NAME, SOTH_SYSTEM_ADMIN_PHONE, and SOTH_SYSTEM_ADMIN_PASSWORD.'
    );
  }
  if (!allowedEmails.includes(normalizeEmail(email))) {
    throw new Error('SOTH_SYSTEM_ADMIN_EMAIL must also be present in SYSTEM_ADMIN_EMAILS.');
  }
  const normalizedPassword = password.trim();
  const passwordErrors: string[] = [];
  if (normalizedPassword.length < 8) passwordErrors.push('at least 8 characters');
  if (!/[A-Z]/.test(normalizedPassword)) passwordErrors.push('one uppercase letter');
  if (!/[a-z]/.test(normalizedPassword)) passwordErrors.push('one lowercase letter');
  if (!/\d/.test(normalizedPassword)) passwordErrors.push('one number');
  if (!/[@$!%*?&#]/.test(normalizedPassword)) passwordErrors.push('one supported special character (@$!%*?&#)');
  if (!/^[A-Za-z\d@$!%*?&#]+$/.test(normalizedPassword)) {
    passwordErrors.push('only letters, numbers, and the supported special characters (@$!%*?&#)');
  }
  if (passwordErrors.length) {
    throw new Error('System-admin password does not meet account requirements: ' + passwordErrors.join('; ') + '.');
  }

  const url = new URL(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: /(^|\.)supabase\.com$/i.test(url.hostname) || /\.pooler\.supabase\.com$/i.test(url.hostname)
      ? { rejectUnauthorized: false }
      : undefined,
    max: 1,
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenant = await client.query(
      `SELECT id, tenant_name, tenant_slug, is_active
       FROM public.tenants
       WHERE id = 1
       FOR SHARE`
    );
    const tenantOne = tenant.rows[0];
    if (
      !tenantOne ||
      tenantOne.tenant_slug !== 'soth-dry-cleaners' ||
      tenantOne.is_active !== true
    ) {
      throw new Error('Refusing to seed: database tenant 1 is not the active Soth Dry Cleaners tenant.');
    }

    const existing = await client.query(
      `SELECT id FROM public.users
       WHERE tenant_id = 1 AND LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    );
    if (existing.rowCount) {
      throw new Error('Refusing to overwrite an existing user account for this email in tenant 1.');
    }

    const passwordHash = await bcrypt.hash(normalizedPassword, 12);
    const inserted = await client.query(
      `INSERT INTO public.users
         (email, password, full_name, phone, role, status, auth_provider,
          is_active, tenant_id, must_change_password)
       VALUES ($1, $2, $3, $4, 'ADMIN', 'ACTIVE', 'LOCAL', TRUE, 1, FALSE)
       RETURNING id, email, full_name, role, status, tenant_id`,
      [normalizeEmail(email), passwordHash, fullName.trim(), phone.trim()]
    );

    await client.query('COMMIT');
    console.log('Soth developer system-admin account created:', {
      id: inserted.rows[0].id,
      email: inserted.rows[0].email,
      role: inserted.rows[0].role,
      status: inserted.rows[0].status,
      tenant_id: inserted.rows[0].tenant_id,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('System-admin seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
