/**
 * ZATCA e-Invoicing Engine
 * Supports Phase 1 (QR + XML generation) and Phase 2 (clearance/reporting)
 * Sandbox environment for ACELogic
 */

// ── ZATCA API endpoints ────────────────────────────────────────
const ZATCA_SANDBOX = {
  compliance: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  reporting:  'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/reporting/single',
  clearance:  'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/clearance/single',
}
const ZATCA_PROD = {
  compliance: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
  reporting:  'https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/reporting/single',
  clearance:  'https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/clearance/single',
}

export function getZatcaUrls(env = 'sandbox') {
  return env === 'production' ? ZATCA_PROD : ZATCA_SANDBOX
}

// ── Phase 1: TLV QR Encoder ───────────────────────────────────
/**
 * Generates ZATCA-compliant base64 TLV QR string
 * Tags: 1=seller, 2=vat, 3=timestamp, 4=total, 5=vat_amount
 */
export function generateQR(sellerName, vatNumber, invoiceDate, totalAmount, vatAmount) {
  const encode = (tag, value) => {
    const valueBytes = Buffer.from(value, 'utf8')
    const tagBuf = Buffer.alloc(1); tagBuf.writeUInt8(tag)
    const lenBuf = Buffer.alloc(1); lenBuf.writeUInt8(valueBytes.length)
    return Buffer.concat([tagBuf, lenBuf, valueBytes])
  }

  const dateStr = invoiceDate instanceof Date
    ? invoiceDate.toISOString()
    : new Date(invoiceDate).toISOString()

  const tlv = Buffer.concat([
    encode(1, sellerName),
    encode(2, vatNumber),
    encode(3, dateStr),
    encode(4, Number(totalAmount).toFixed(2)),
    encode(5, Number(vatAmount).toFixed(2)),
  ])

  return tlv.toString('base64')
}

// ── Phase 1 & 2: UBL 2.1 XML Builder ─────────────────────────
export function buildInvoiceXML(invoice, tenant, items) {
  const isB2B = invoice.invoice_type === 'B2B'
  const invoiceTypeCode = isB2B ? '388' : '388'   // 388 = tax invoice
  const invoiceSubtype = isB2B ? '0100000' : '0200000'

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">

  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
      <ext:ExtensionContent>
        <!-- Signature placeholder - populated after signing -->
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>

  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${invoice.invoice_number}</cbc:ID>
  <cbc:UUID>${invoice.zatca_uuid}</cbc:UUID>
  <cbc:IssueDate>${new Date(invoice.issued_at).toISOString().split('T')[0]}</cbc:IssueDate>
  <cbc:IssueTime>${new Date(invoice.issued_at).toISOString().split('T')[1].split('.')[0]}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceSubtype}">${invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>

  <!-- Seller (Supplier) -->
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${tenant.cr_number}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${tenant.street || 'Awwal Street'}</cbc:StreetName>
        <cbc:BuildingNumber>${tenant.building_no || '3884'}</cbc:BuildingNumber>
        <cbc:PlotIdentification>${tenant.additional_no || '8827'}</cbc:PlotIdentification>
        <cbc:CityName>${tenant.city || 'Al-Khobar'}</cbc:CityName>
        <cbc:PostalZone>${tenant.postal_code || '34623'}</cbc:PostalZone>
        <cbc:CountrySubentity>${tenant.district || 'Ath Thuqbha'}</cbc:CountrySubentity>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${tenant.vat_number}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${tenant.name}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <!-- Buyer -->
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${isB2B && invoice.buyer_vat ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${invoice.buyer_vat}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${invoice.buyer_name || invoice.customer_name || 'Customer'}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <!-- Payment -->
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
  </cac:PaymentMeans>

  <!-- Tax Total -->
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${Number(invoice.vat_amount).toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${Number(invoice.taxable_amount).toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${Number(invoice.vat_amount).toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${Number(invoice.vat_rate).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>

  <!-- Legal Monetary Total -->
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${Number(invoice.subtotal).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${Number(invoice.taxable_amount).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${Number(invoice.total).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${Number(invoice.discount_amt || 0).toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="SAR">${Number(invoice.total).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  <!-- Invoice Lines -->
  ${items.map((item, i) => `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${Number(item.quantity || 1).toFixed(3)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${Number(item.line_total).toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${Number(item.vat_amount).toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${(Number(item.line_total) + Number(item.vat_amount)).toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${item.description}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${Number(item.vat_rate || 15).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${Number(item.unit_price).toFixed(2)}</cbc:PriceAmount>
      ${item.discount_pct > 0 ? `
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
        <cbc:MultiplierFactorNumeric>${Number(item.discount_pct).toFixed(2)}</cbc:MultiplierFactorNumeric>
        <cbc:Amount currencyID="SAR">${Number(item.discount_amt).toFixed(2)}</cbc:Amount>
      </cac:AllowanceCharge>` : ''}
    </cac:Price>
  </cac:InvoiceLine>`).join('')}

</Invoice>`

  return xml
}

// ── Simple SHA256 hash ─────────────────────────────────────────
export async function hashXML(xmlString) {
  const encoder = new TextEncoder()
  const data = encoder.encode(xmlString)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(hashBuffer).toString('base64')
}

// ── Submit to ZATCA Fatoora (Phase 2) ─────────────────────────
export async function submitToZatca({ xmlContent, invoiceHash, uuid, csid, secret, env = 'sandbox', type = 'reporting' }) {
  const urls = getZatcaUrls(env)
  const url = type === 'clearance' ? urls.clearance : urls.reporting

  const credentials = Buffer.from(`${csid}:${secret}`).toString('base64')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept-version': type === 'clearance' ? 'V2' : 'V2',
      'Accept-Language': 'en',
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      invoiceHash,
      uuid,
      invoice: Buffer.from(xmlContent).toString('base64'),
    })
  })

  const body = await response.json()
  return {
    status: response.status,
    body,
    zatcaStatus: body.reportingStatus || body.clearanceStatus || 'ERROR',
    warnings: body.validationResults?.warnings || [],
    errors: body.validationResults?.errors || [],
  }
}

// ── CSID Onboarding (Phase 2) ─────────────────────────────────
export async function requestComplianceCSID({ csr, otp, env = 'sandbox' }) {
  const urls = getZatcaUrls(env)
  const response = await fetch(`${urls.compliance}/compliance`, {
    method: 'POST',
    headers: {
      'accept-version': 'V1',
      'Accept-Language': 'en',
      'OTP': otp,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ csr })
  })
  return response.json()
}

export async function requestProductionCSID({ csid, secret, env = 'sandbox' }) {
  const urls = getZatcaUrls(env)
  const credentials = Buffer.from(`${csid}:${secret}`).toString('base64')
  const response = await fetch(`${urls.compliance}/production/csids`, {
    method: 'POST',
    headers: {
      'accept-version': 'V1',
      'Accept-Language': 'en',
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ compliance_request_id: csid })
  })
  return response.json()
}
