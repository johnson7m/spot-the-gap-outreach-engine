import { createSupabaseClient } from '../integrations/supabase/client.js';
import { createMemoryOperationalStore } from './memoryOperationalStore.js';
import { createSupabaseOperationalStore } from './supabaseOperationalStore.js';

export function createOperationalStore({ config = {}, log, supabaseClient } = {}) {
  const supabaseConfig = config.supabase ?? {};
  const client = supabaseClient ?? createSupabaseClient(supabaseConfig);

  if (!client) {
    log?.warn?.(
      'Supabase is not configured; using in-memory operational store. This is not durable.'
    );
    return createMemoryOperationalStore();
  }

  return createSupabaseOperationalStore({ client, log });
}
