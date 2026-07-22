// Decodes the logged-in VTEX admin user's JWT (unverified — VTEX's platform
// already authenticated the request before this handler runs) to read their
// email, so checkout never has to ask for what VTEX already knows.
//
// Confirmed live against a real token: there's no separate "email" claim —
// `sub` IS the email address (e.g. "adnan.shahzad@nestosh.com"); `userId` is
// a UUID, not the email or a fallback for it.
export function getVtexAdminUser(ctx: any): { userId: string; email: string } {
  try {
    const token = ctx.vtex?.adminUserAuthToken
    if (!token) return { userId: '', email: '' }
    const parts = token.split('.')
    if (parts.length < 2) return { userId: '', email: '' }
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64 + '==', 'base64').toString())
    return {
      userId: String(payload.userId ?? ''),
      email: String(payload.sub ?? ''),
    }
  } catch {
    return { userId: '', email: '' }
  }
}
