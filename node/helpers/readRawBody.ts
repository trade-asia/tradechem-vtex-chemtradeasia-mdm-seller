// Stripe webhook signature verification needs the exact raw bytes as sent —
// readBody.ts decodes to a utf8 string, which is not safe for HMAC verification.
export function readRawBody(ctx: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const req = ctx.req
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}
