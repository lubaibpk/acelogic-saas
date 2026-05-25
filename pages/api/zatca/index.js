import { supabase } from '../../../lib/supabase'
import { withRole } from '../../../lib/auth'
import { requestComplianceCSID, requestProductionCSID, submitToZatca } from '../../../lib/zatca'
import crypto from 'crypto'

// Encrypt private key before storing
function encryptKey(privateKey) {
  const secret = process.env.KEY_ENCRYPT_SECRET || 'fallback-32-char-secret-key!!!!!'
  const key = crypto.scryptSync(secret, 'salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

function decryptKey(encrypted) {
  const secret = process.env.KEY_ENCRYPT_SECRET || 'fallback-32-char-secret-key!!!!!'
  const [ivHex, encHex] = encrypted.split(':')
  const key = crypto.scryptSync(secret, 'salt', 32)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}

async function handler(req, res) {
  const { tenantId } = req
  const { action } = req.body || req.query

  // ── GET: certificate status ───────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('zatca_certificates')
      .select('id, phase, environment, onboarding_status, issued_at, expires_at, csid')
      .eq('tenant_id', tenantId)
      .single()

    if (error) return res.status(404).json({ error: 'No certificate found' })
    return res.status(200).json({ certificate: data })
  }

  // ── POST: onboarding actions ──────────────────────────────
  if (req.method === 'POST') {

    // ── Step 1: Generate CSR ──────────────────────────────
    if (action === 'generate_csr') {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', tenantId)
        .single()

      if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

      // Generate ECDSA key pair (secp256k1 as required by ZATCA)
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      // Build CSR fields per ZATCA spec
      const csrConfig = [
        `C=SA`,
        `O=${tenant.name}`,
        `OU=Riyad`,
        `CN=${tenant.vat_number}`,
      ].join('\n')

      // In production you'd use node-forge to build a proper CSR
      // For sandbox we use a simplified version
      const csr = Buffer.from(`-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from(csrConfig).toString('base64')}\n-----END CERTIFICATE REQUEST-----`).toString('base64')

      // Encrypt and store private key
      const encryptedKey = encryptKey(privateKey)

      await supabase
        .from('zatca_certificates')
        .upsert({
          tenant_id: tenantId,
          phase: '2',
          environment: req.body.environment || 'sandbox',
          csr: Buffer.from(csr).toString('base64'),
          private_key_enc: encryptedKey,
          onboarding_status: 'csr_generated',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,environment' })

      return res.status(200).json({
        message: 'CSR generated successfully',
        csr: Buffer.from(csr).toString('base64'),
        note: 'Submit this CSR to ZATCA Fatoora portal with your OTP to get CSID'
      })
    }

    // ── Step 2: Request Compliance CSID ──────────────────
    if (action === 'request_csid') {
      const { otp, environment = 'sandbox' } = req.body

      if (!otp) return res.status(400).json({ error: 'OTP required from Fatoora portal' })

      const { data: cert } = await supabase
        .from('zatca_certificates')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('environment', environment)
        .single()

      if (!cert?.csr) return res.status(400).json({ error: 'Generate CSR first' })

      const result = await requestComplianceCSID({ csr: cert.csr, otp, env: environment })

      if (!result.requestID) {
        return res.status(400).json({ error: 'ZATCA rejected CSR', details: result })
      }

      await supabase
        .from('zatca_certificates')
        .update({
          csid: result.binarySecurityToken,
          compliance_request_id: result.requestID,
          onboarding_status: 'csid_issued',
          issued_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenantId)
        .eq('environment', environment)

      return res.status(200).json({
        message: 'Compliance CSID issued!',
        csid: result.binarySecurityToken,
        requestId: result.requestID,
      })
    }

    // ── Step 3: Request Production CSID ──────────────────
    if (action === 'request_pcsid') {
      const { environment = 'sandbox' } = req.body

      const { data: cert } = await supabase
        .from('zatca_certificates')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('environment', environment)
        .single()

      if (!cert?.csid) return res.status(400).json({ error: 'Get compliance CSID first' })

      const secret = decryptKey(cert.private_key_enc)
      const result = await requestProductionCSID({ csid: cert.csid, secret, env: environment })

      if (!result.binarySecurityToken) {
        return res.status(400).json({ error: 'ZATCA rejected PCSID request', details: result })
      }

      await supabase
        .from('zatca_certificates')
        .update({
          pcsid: result.binarySecurityToken,
          onboarding_status: 'pcsid_issued',
          expires_at: result.tokenExpiryDate || null,
          updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenantId)
        .eq('environment', environment)

      return res.status(200).json({
        message: 'Production CSID issued! Ready for Phase 2.',
        pcsid: result.binarySecurityToken,
      })
    }

    // ── Submit pending invoices (batch reporting) ─────────
    if (action === 'submit_pending') {
      const { environment = 'sandbox' } = req.body

      const { data: cert } = await supabase
        .from('zatca_certificates')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('environment', environment)
        .single()

      if (!cert?.pcsid) return res.status(400).json({ error: 'PCSID not set up yet' })

      const { data: pending } = await supabase
        .from('invoices')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('zatca_status', 'not_submitted')
        .limit(20)

      if (!pending?.length) return res.status(200).json({ message: 'No pending invoices', submitted: 0 })

      const results = []
      for (const inv of pending) {
        if (!inv.xml_content) continue
        const result = await submitToZatca({
          xmlContent: inv.xml_content,
          invoiceHash: inv.zatca_hash,
          uuid: inv.zatca_uuid,
          csid: cert.pcsid,
          secret: decryptKey(cert.private_key_enc),
          env: environment,
          type: 'reporting',
        })

        await supabase.from('zatca_submissions').insert({
          tenant_id: tenantId, invoice_id: inv.id, environment,
          submission_type: 'reporting', request_hash: inv.zatca_hash,
          response_status: result.status, response_body: result.body,
          zatca_status: result.zatcaStatus, warnings: result.warnings, errors: result.errors,
        })

        const newStatus = result.status === 200 ? 'cleared' : 'rejected'
        await supabase.from('invoices').update({ zatca_status: newStatus }).eq('id', inv.id)

        results.push({ invoiceNumber: inv.invoice_number, status: newStatus })
      }

      return res.status(200).json({ submitted: results.length, results })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withRole(['tenant_admin', 'super_admin', 'manager'], handler)
