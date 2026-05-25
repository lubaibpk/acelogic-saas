import { supabase } from '../../../lib/supabase'
import { withAuth } from '../../../lib/auth'

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { tenantId } = req
  const today = new Date().toISOString().split('T')[0]

  // Run all queries in parallel
  const [
    { data: customers },
    { data: allVisits },
    { data: pendingOffers },
    { data: monthVisits },
    { data: settings },
  ] = await Promise.all([
    supabase.from('customers').select('id, name, phone, birthday, anniversary, preferred_stylist').eq('tenant_id', tenantId).eq('is_active', true),
    supabase.from('visits').select('customer_id, visit_date, service, final_price').eq('tenant_id', tenantId).order('visit_date', { ascending: false }),
    supabase.from('offers').select('id, customer_id, pct, code, expiry, status').eq('tenant_id', tenantId).eq('status', 'pending'),
    supabase.from('visits').select('id, final_price, visit_date').eq('tenant_id', tenantId).gte('visit_date', today.slice(0, 7) + '-01'),
    supabase.from('tenant_settings').select('*').eq('tenant_id', tenantId).single(),
  ])

  const gracePeriod    = settings?.data?.grace_period_days || 7
  const newClientDays  = settings?.data?.new_client_days   || 45

  // ── Per-customer analytics ──────────────────────────────
  const customerAnalytics = (customers || []).map(c => {
    const cv = (allVisits || []).filter(v => v.customer_id === c.id).sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date))
    const lastVisit = cv[0] || null
    const daysSince = lastVisit ? Math.floor((new Date() - new Date(lastVisit.visit_date)) / 86400000) : null

    // Average cycle
    let avgCycle = null
    if (cv.length >= 2) {
      let total = 0
      for (let i = 1; i < cv.length; i++) {
        total += (new Date(cv[i-1].visit_date) - new Date(cv[i].visit_date)) / 86400000
      }
      avgCycle = Math.round(total / (cv.length - 1))
    }

    const threshold = avgCycle !== null ? avgCycle + gracePeriod : newClientDays
    const overdue = daysSince !== null && daysSince > threshold

    return {
      ...c,
      visitCount: cv.length,
      lastVisit,
      daysSince,
      avgCycle,
      threshold,
      overdue,
      hasPendingOffer: (pendingOffers || []).some(o => o.customer_id === c.id),
    }
  })

  const overdueCustomers = customerAnalytics.filter(c => c.overdue)

  // ── Milestones (next 7 days) ────────────────────────────
  const todayDate = new Date(); todayDate.setHours(0,0,0,0)
  const milestones = []
  ;(customers || []).forEach(c => {
    ['birthday', 'anniversary'].forEach(field => {
      if (!c[field]) return
      const d = new Date(c[field])
      const upcoming = new Date(todayDate.getFullYear(), d.getMonth(), d.getDate())
      if (upcoming < todayDate) upcoming.setFullYear(upcoming.getFullYear() + 1)
      const daysAway = Math.floor((upcoming - todayDate) / 86400000)
      if (daysAway <= 7) milestones.push({ customer: c, type: field, daysAway })
    })
  })
  milestones.sort((a, b) => a.daysAway - b.daysAway)

  // ── Revenue ─────────────────────────────────────────────
  const monthRevenue = (monthVisits || []).reduce((s, v) => s + (Number(v.final_price) || 0), 0)

  // Revenue by service (all time top 6)
  const byService = {}
  ;(allVisits || []).forEach(v => { byService[v.service] = (byService[v.service] || 0) + (Number(v.final_price) || 0) })
  const topServices = Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 6)

  return res.status(200).json({
    stats: {
      totalCustomers:  customers?.length || 0,
      overdueCount:    overdueCustomers.length,
      milestonesCount: milestones.length,
      activeOffers:    pendingOffers?.length || 0,
      visitsThisMonth: monthVisits?.length || 0,
      revenueThisMonth: Math.round(monthRevenue * 100) / 100,
    },
    overdueCustomers,
    milestones,
    topServices: topServices.map(([service, revenue]) => ({ service, revenue })),
    settings: settings?.data || {},
  })
}

export default withAuth(handler)
