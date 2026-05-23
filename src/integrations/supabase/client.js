import { createClient } from '@supabase/supabase-js';

export function createSupabaseClient(config = {}) {
  if (!config.enabled) {
    return null;
  }

  if (!config.url || !config.serviceRoleKey) {
    throw new Error(
      'Supabase is enabled, but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.'
    );
  }

  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
