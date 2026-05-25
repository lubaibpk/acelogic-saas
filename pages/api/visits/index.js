import { supabase } from '../../../lib/supabase'
import { withAuth } from '../../../lib/auth'

async function handler(req, res) {
  const { tenantId } = req

  // ── GET: list visits (with analytics) ───────────────────
  if (req.method === 'GET') {
    const { customerId, from, to, limit = 100 } = req.query

    let query = supabase
      .from('visits')
      .select(`
        *,
        customers(id, name, phone, preferred_stylist),
        offers(id, pct, code, type)
      `)
      .eq('tenant_id', tenantId)
      .order('visit_date', { ascending: false })
      .limit(Number(limit))

    if (customerId) query = query.eq('customer_id', customerId)
    if (from)       query = query.gte('visit_date', from)
    if (to)         query = query.lte('visit_date', to)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ visits: data })
  }

  // ── POST: log a visit ────────────────────────────────────
  if (req.method === 'POST') {
    const {
      customer_id, service, original_price,
      discount_pct = 0, offer_id = null,
      stylist, visit_date, notes
    } = req.body

    if (!customer_id || !service) return res.status(400).json({ error: 'customer_id and service required' })

    const orig = Number(original_price) || 0
    const pct  = Number(discount_pct) || 0
    const disc = Math.round((orig * pct) / 100 * 100) / 100
    const final = orig - disc

    const { data: visit, error } = await supabase
      .from('visits')
      .insert({
        tenant_id:      tenantId,
        customer_id,
        service:        service.trim(),
        original_price: orig,
        discount_pct:   pct,
        discount_amt:   disc,
        final_price:    final,
        offer_id:       offer_id || null,
        stylist:        stylist || null,
        visit_date:     visit_date || new Date().toISOString().split('T')[0],
        notes:          notes?.trim() || null,
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })

    // Auto-utilize pending offer
    if (offer_id) {
      await supabase
        .from('offers')
        .update({ status: 'utilized', utilized_at: visit.visit_date, utilized_visit_id: visit.id })
        .eq('id', offer_id)
        .eq('tenant_id', tenantId)
    }

    return res.status(201).json({ visit })
  }

  // ── DELETE: remove visit ─────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id required' })

    const { error } = await supabase
      .from('visits')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)

    if (error) return res.status(400).json({ error: error.message })
    return res.status(200).json({ message: 'Visit deleted' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(handler)
