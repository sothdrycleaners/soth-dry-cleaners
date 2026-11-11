import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import { config } from '../config';

const PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

const getSupabaseStorageClient = (): SupabaseClient => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for profile picture storage');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

const sanitizeFileName = (name: string) =>
  name
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();

const getStoredObjectPath = (value: string, bucket: string): string | null => {
  const supabaseUrl = process.env.SUPABASE_URL;
  let objectPath = value.trim();

  if (/^https?:\/\//i.test(objectPath)) {
    try {
      const storedUrl = new URL(objectPath);
      if (!supabaseUrl || storedUrl.origin !== new URL(supabaseUrl).origin) return null;
      const prefixes = [
        '/storage/v1/object/public/' + bucket + '/',
        '/storage/v1/object/sign/' + bucket + '/',
      ];
      const prefix = prefixes.find((candidate) => storedUrl.pathname.startsWith(candidate));
      if (!prefix) return null;
      objectPath = decodeURIComponent(storedUrl.pathname.slice(prefix.length));
    } catch {
      return null;
    }
  }

  objectPath = objectPath.replace(/^\/+/, '');
  if (!objectPath || objectPath.split('/').some((part) => part === '..' || part === '.')) return null;
  return objectPath;
};

export const createProfilePictureAccessUrl = async (
  storedValue: string | null | undefined,
  tenantId: number,
): Promise<string | null> => {
  if (!storedValue) return null;

  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'profile-pictures';
  const objectPath = getStoredObjectPath(storedValue, bucket);

  // Preserve external OAuth images. Supabase object URLs are always re-signed.
  if (!objectPath) return /^https?:\/\//i.test(storedValue) ? storedValue : null;

  const tenantPrefix = 'tenants/' + tenantId + '/';
  if (!objectPath.startsWith(tenantPrefix)) return null;

  const { data, error } = await getSupabaseStorageClient()
    .storage
    .from(bucket)
    .createSignedUrl(objectPath, PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw new Error('Failed to create a private profile picture URL' + (error ? ': ' + error.message : ''));
  }
  return data.signedUrl;
};

export const uploadProfileImageToSupabase = async (
  file: Express.Multer.File,
  userId: number,
  tenantId: number = config.tenancy.deploymentTenantId,
) => {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'profile-pictures';
  const ext = path.extname(file.originalname) || '.jpg';
  const safeBase = sanitizeFileName(path.basename(file.originalname, ext)) || 'profile';
  const objectPath = 'tenants/' + tenantId + '/users/' + userId + '/' + Date.now() + '-' + safeBase + ext.toLowerCase();
  const supabase = getSupabaseStorageClient();

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype || 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadError) throw new Error('Supabase upload failed: ' + uploadError.message);

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error('Profile image uploaded but its private URL could not be created' + (error ? ': ' + error.message : ''));
  }

  return { objectPath, signedUrl: data.signedUrl, bucket };
};
