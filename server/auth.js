import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

let admin = null;

export function supabaseAdmin() {
  if (!admin) {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      throw new Error('Supabase auth is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
    }
    admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return admin;
}

export function isAuthConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

export async function verifySupabaseToken(bearerToken) {
  if (!bearerToken) return null;
  const token = String(bearerToken).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin().auth.getUser(token);
  if (error || !data.user) return null;
  const u = data.user;
  return {
    id: u.id,
    email: u.email,
    emailConfirmed: Boolean(u.email_confirmed_at),
    createdAt: u.created_at,
  };
}