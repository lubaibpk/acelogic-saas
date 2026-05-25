export default function Home() {
  return (
    <div style={{ fontFamily: 'monospace', padding: 40, background: '#0a0a0a', minHeight: '100vh', color: '#e0e0e0' }}>
      <h1 style={{ color: '#B8965A', letterSpacing: '0.1em' }}>✦ ACELogic SaaS API</h1>
      <p style={{ color: '#9B7B6B', marginTop: 8 }}>Multi-tenant backend · ZATCA Phase 1/2 · Sandbox</p>

      <div style={{ marginTop: 40, display: 'grid', gap: 12 }}>
        {[
          ['POST', '/api/auth', 'Login · Register users'],
          ['GET/POST/PUT/DELETE', '/api/customers', 'Customer profiles'],
          ['GET/POST/DELETE', '/api/visits', 'Service visit logs'],
          ['GET/POST/PUT/DELETE', '/api/offers', 'Retention offers & coupons'],
          ['GET/POST/PUT', '/api/invoices', 'ZATCA-compliant invoices + QR'],
          ['GET/POST', '/api/zatca', 'ZATCA onboarding · CSR · CSID · Phase 2'],
          ['GET', '/api/dashboard', 'Analytics · Overdue · Milestones · Revenue'],
        ].map(([method, path, desc]) => (
          <div key={path} style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '10px 16px', background: '#111', borderRadius: 8, border: '1px solid #222' }}>
            <span style={{ color: '#90CAF9', width: 80, fontSize: 11 }}>{method}</span>
            <span style={{ color: '#B8965A', width: 220, fontSize: 13 }}>{path}</span>
            <span style={{ color: '#9B7B6B', fontSize: 12 }}>{desc}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 40, padding: 20, background: '#111', borderRadius: 8, border: '1px solid #333' }}>
        <p style={{ color: '#9B7B6B', fontSize: 12, marginBottom: 8 }}>Authentication: Bearer JWT token in Authorization header</p>
        <p style={{ color: '#9B7B6B', fontSize: 12 }}>Supabase Project: pexumwrirtcwrvuwrrfq · Region: ap-southeast-1 (Singapore)</p>
        <p style={{ color: '#9B7B6B', fontSize: 12, marginTop: 4 }}>ZATCA: Sandbox mode · Phase 1 active · Phase 2 ready</p>
      </div>
    </div>
  )
}
