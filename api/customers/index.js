import { supabase } from '../../../lib/supabase'
import { withAuth } from '../../../lib/auth'

async function handler(req, res) {
  const { tenantId } = req

  // ── GET: list customers ──────────────────────────────────
  if (req.method === 'GET') {
    const { search, stylist, limit = 200, offset = 0 } = req.query

    let query = supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`)
    }
    if (stylist) {
      query = query.eq('preferred_stylist', stylist)
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ customers: data })
  }

  // ── POST: create customer ────────────────────────────────
  if (req.method === 'POST') {
    const { name, phone, email, birthday, anniversary, hair_type, preferred_stylist, notes } = req.body

    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' })

    const { data, error } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenantId,
        name: name.trim(),
        phone: phone.trim(),
        email: email?.trim() || null,
        birthday: birthday || null,
        anniversary: anniversary || null,
        hair_type: hair_type || null,
        preferred_stylist: preferred_stylist || null,
        notes: notes?.trim() || null,
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })
    return res.status(201).json({ customer: data })
  }

  // ── PUT: update customer ─────────────────────────────────
  if (req.method === 'PUT') {
    const { id, ...updates } = req.body
    if (!id) return res.status(400).json({ error: 'id required' })

    // Only allow safe fields
    const allowed = ['name','phone','email','birthday','anniversary','hair_type','preferred_stylist','notes','is_active']
    const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))
    clean.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('customers')
      .update(clean)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })
    return res.status(200).json({ customer: data })
  }

  // ── DELETE: soft delete ──────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const { error } = await supabase
      .from('customers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId)

    if (error) return res.status(400).json({ error: error.message })
    return res.status(200).json({ message: 'Customer deleted' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(handler)
