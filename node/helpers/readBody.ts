export function readBody(ctx: any): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = ''
    const req = ctx.req
    req.on('data', (chunk: any) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}
