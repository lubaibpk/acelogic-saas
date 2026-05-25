import { supabase } from '../../../lib/supabase'
import { signToken } from '../../../lib/auth'
import bcrypt from 'bcryptjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action, email, password, tenantId, name, role } = req.body

  // ── LOGIN ──────────────────────────────────────────────────
  if (action === 'login') {
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const { data: user, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .eq('is_active', true)
      .single()

    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    // Fetch tenant info
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, name, name_ar, vat_number, cr_number, plan, is_active')
      .eq('id', user.tenant_id)
      .single()

    if (!tenant || !tenant.is_active) return res.status(403).json({ error: 'Tenant inactive or not found' })

    const token = signToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      email: user.email,
      name: user.name,
    })

    return res.status(200).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant,
    })
  }

  // ── REGISTER (super_admin only via direct API call) ────────
  if (action === 'register') {
    if (!email || !password || !tenantId || !name)
      return res.status(400).json({ error: 'email, password, tenantId, name required' })

    // Check secret register key
    const registerKey = req.headers['x-register-key']
    if (registerKey !== process.env.REGISTER_SECRET)
      return res.status(403).json({ error: 'Invalid register key' })

    const password_hash = await bcrypt.hash(password, 12)

    const { data: user, error } = await supabase
      .from('app_users')
      .insert({
        tenant_id: tenantId,
        name,
        email: email.toLowerCase().trim(),
        password_hash,
        role: role || 'staff',
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })

    return res.status(201).json({
      message: 'User created',
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    })
  }

  return res.status(400).json({ error: 'Invalid action' })
}
