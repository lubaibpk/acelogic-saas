import { supabase } from '../../../lib/supabase'
import { withAuth } from '../../../lib/auth'

async function handler(req, res) {
  const { tenantId } = req

  // Auto-expire offers on every request
  await supabase
    .from('offers')
    .update({ status: 'expired' })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lt('expiry', new Date().toISOString().split('T')[0])

  // ── GET ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { status, customerId } = req.query

    let query = supabase
      .from('offers')
      .select(`*, customers(id, name, phone)`)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })

    if (status)     query = query.eq('status', status)
    if (customerId) query = query.eq('customer_id', customerId)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ offers: data })
  }

  // ── POST: create offer ───────────────────────────────────
  if (req.method === 'POST') {
    const { customer_id, type, pct, code, expiry, message, message_ar } = req.body
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' })

    // Supersede existing pending offers for this customer
    await supabase
      .from('offers')
      .update({ status: 'superseded' })
      .eq('tenant_id', tenantId)
      .eq('customer_id', customer_id)
      .eq('status', 'pending')

    const { data, error } = await supabase
      .from('offers')
      .insert({
        tenant_id: tenantId,
        customer_id,
        type:       type || 'retention',
        pct:        Number(pct) || 10,
        code:       code?.trim() || null,
        expiry:     expiry || null,
        message:    message?.trim() || null,
        message_ar: message_ar?.trim() || null,
        status:     'pending',
        sent_at:    new Date().toISOString().split('T')[0],
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })
    return res.status(201).json({ offer: data })
  }

  // ── PUT: update offer status ─────────────────────────────
  if (req.method === 'PUT') {
    const { id, status, utilized_visit_id } = req.body
    if (!id || !status) return res.status(400).json({ error: 'id and status required' })

    const update = { status }
    if (status === 'utilized') {
      update.utilized_at = new Date().toISOString().split('T')[0]
      if (utilized_visit_id) update.utilized_visit_id = utilized_visit_id
    }

    const { data, error } = await supabase
      .from('offers')
      .update(update)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })
    return res.status(200).json({ offer: data })
  }

  // ── DELETE ───────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query
    const { error } = await supabase
      .from('offers')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)

    if (error) return res.status(400).json({ error: error.message })
    return res.status(200).json({ message: 'Offer deleted' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(handler)
