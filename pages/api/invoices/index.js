import { supabase } from '../../../lib/supabase'
import { withAuth } from '../../../lib/auth'
import { generateQR, buildInvoiceXML, hashXML, submitToZatca } from '../../../lib/zatca'

async function handler(req, res) {
  const { tenantId } = req

  // ── GET: list invoices ───────────────────────────────────
  if (req.method === 'GET') {
    const { customerId, status, from, to, limit = 50 } = req.query

    let query = supabase
      .from('invoices')
      .select(`
        *,
        customers(id, name, phone),
        invoice_items(*),
        zatca_submissions(id, zatca_status, submitted_at, errors, warnings)
      `)
      .eq('tenant_id', tenantId)
      .order('issued_at', { ascending: false })
      .limit(Number(limit))

    if (customerId) query = query.eq('customer_id', customerId)
    if (status)     query = query.eq('invoice_status', status)
    if (from)       query = query.gte('issued_at', from)
    if (to)         query = query.lte('issued_at', to)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ invoices: data })
  }

  // ── POST: create invoice ─────────────────────────────────
  if (req.method === 'POST') {
    const {
      customer_id, visit_id,
      invoice_type = 'B2C',
      buyer_name, buyer_name_ar, buyer_vat, buyer_cr, buyer_address,
      items = [],   // [{ description, unit_price, quantity, discount_pct, vat_rate }]
      notes,
      submit_to_zatca = false,
    } = req.body

    if (!items.length) return res.status(400).json({ error: 'At least one invoice item required' })

    // ── Fetch tenant ──────────────────────────────────────
    const { data: tenant } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single()

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

    // ── Get next invoice number ───────────────────────────
    const { data: numResult, error: numErr } = await supabase
      .rpc('next_invoice_number', { p_tenant_id: tenantId })

    if (numErr) return res.status(500).json({ error: 'Failed to get invoice number' })
    const invoiceNumber = numResult

    // ── Calculate totals ──────────────────────────────────
    let subtotal     = 0
    let totalDisc    = 0
    let totalVat     = 0
    const computedItems = items.map(item => {
      const qty       = Number(item.quantity) || 1
      const price     = Number(item.unit_price) || 0
      const discPct   = Number(item.discount_pct) || 0
      const vatRate   = Number(item.vat_rate) || 15
      const discAmt   = Math.round((price * qty * discPct / 100) * 100) / 100
      const lineNet   = Math.round((price * qty - discAmt) * 100) / 100
      const vatAmt    = Math.round((lineNet * vatRate / 100) * 100) / 100

      subtotal  += lineNet
      totalDisc += discAmt
      totalVat  += vatAmt

      return {
        description:   item.description,
        description_ar: item.description_ar || null,
        unit_price:    price,
        quantity:      qty,
        discount_pct:  discPct,
        discount_amt:  discAmt,
        vat_rate:      vatRate,
        vat_amount:    vatAmt,
        line_total:    lineNet,
      }
    })

    subtotal      = Math.round(subtotal * 100) / 100
    totalVat      = Math.round(totalVat * 100) / 100
    const total   = Math.round((subtotal + totalVat) * 100) / 100
    const taxable = subtotal

    // ── Build ZATCA UUID ──────────────────────────────────
    const { v4: uuidv4 } = await import('uuid')
    const zatcaUuid = uuidv4()

    // ── Generate Phase 1 QR ───────────────────────────────
    const qrBase64 = generateQR(
      tenant.name,
      tenant.vat_number,
      new Date().toISOString(),
      total,
      totalVat
    )

    // ── Insert invoice ────────────────────────────────────
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .insert({
        tenant_id:      tenantId,
        customer_id:    customer_id || null,
        visit_id:       visit_id || null,
        invoice_number: invoiceNumber,
        invoice_type,
        buyer_name:     buyer_name || null,
        buyer_name_ar:  buyer_name_ar || null,
        buyer_vat:      buyer_vat || null,
        buyer_cr:       buyer_cr || null,
        buyer_address:  buyer_address || null,
        subtotal,
        discount_amt:   totalDisc,
        taxable_amount: taxable,
        vat_rate:       15,
        vat_amount:     totalVat,
        total,
        zatca_uuid:     zatcaUuid,
        zatca_qr:       qrBase64,
        zatca_status:   'not_submitted',
        notes:          notes?.trim() || null,
        issued_at:      new Date().toISOString(),
      })
      .select()
      .single()

    if (invErr) return res.status(400).json({ error: invErr.message })

    // ── Insert invoice items ──────────────────────────────
    const itemsToInsert = computedItems.map(it => ({
      ...it,
      invoice_id: invoice.id,
      tenant_id:  tenantId,
    }))

    await supabase.from('invoice_items').insert(itemsToInsert)

    // ── Build XML ─────────────────────────────────────────
    const xmlContent = buildInvoiceXML(
      { ...invoice, customer_name: buyer_name },
      tenant,
      computedItems
    )
    const xmlHash = await hashXML(xmlContent)

    // Save XML + hash to invoice
    await supabase
      .from('invoices')
      .update({ xml_content: xmlContent, zatca_hash: xmlHash })
      .eq('id', invoice.id)

    // ── Optional: Submit to ZATCA Phase 2 ─────────────────
    let zatcaResult = null
    if (submit_to_zatca) {
      const { data: cert } = await supabase
        .from('zatca_certificates')
        .select('csid, pcsid, environment')
        .eq('tenant_id', tenantId)
        .single()

      if (cert && cert.pcsid) {
        zatcaResult = await submitToZatca({
          xmlContent,
          invoiceHash: xmlHash,
          uuid: zatcaUuid,
          csid: cert.pcsid,
          secret: process.env.ZATCA_SECRET,
          env: cert.environment || 'sandbox',
          type: invoice_type === 'B2B' ? 'clearance' : 'reporting',
        })

        // Log submission
        await supabase.from('zatca_submissions').insert({
          tenant_id:       tenantId,
          invoice_id:      invoice.id,
          environment:     cert.environment || 'sandbox',
          submission_type: invoice_type === 'B2B' ? 'clearance' : 'reporting',
          request_hash:    xmlHash,
          response_status: zatcaResult.status,
          response_body:   zatcaResult.body,
          zatca_status:    zatcaResult.zatcaStatus,
          warnings:        zatcaResult.warnings,
          errors:          zatcaResult.errors,
        })

        // Update invoice zatca_status
        const newStatus = zatcaResult.status === 200 ? 'cleared' : 'rejected'
        await supabase
          .from('invoices')
          .update({
            zatca_status: newStatus,
            zatca_clearance_stamp: zatcaResult.body?.clearedInvoice || null,
          })
          .eq('id', invoice.id)

        invoice.zatca_status = newStatus
      }
    }

    return res.status(201).json({
      invoice: { ...invoice, xml_content: xmlContent, zatca_qr: qrBase64 },
      zatca: zatcaResult,
    })
  }

  // ── PUT: void invoice ────────────────────────────────────
  if (req.method === 'PUT') {
    const { id, action } = req.body
    if (action === 'void') {
      const { data, error } = await supabase
        .from('invoices')
        .update({ invoice_status: 'voided', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single()

      if (error) return res.status(400).json({ error: error.message })
      return res.status(200).json({ invoice: data })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(handler)
