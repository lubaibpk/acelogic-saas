import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars')
}

// Service role client — bypasses RLS, used only on the server
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// Helper: set tenant context for RLS (when needed)
export async function withTenant(tenantId, userRole, fn) {
  await supabase.rpc('set_config', {
    setting_name: 'app.tenant_id',
    new_value: tenantId
  })
  await supabase.rpc('set_config', {
    setting_name: 'app.user_role',
    new_value: userRole
  })
  return fn()
}
