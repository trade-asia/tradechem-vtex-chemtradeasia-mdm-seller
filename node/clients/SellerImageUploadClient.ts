import { ExternalClient, IOContext, InstanceOptions } from '@vtex/api'

// Uploads an image's bytes to VTEX's own Catalog Images app, via the exact
// private GraphQL mutation the Seller Portal's native "Add images" screen
// itself uses — captured live 2026-10-23 from its browser Network tab
// (operation "saveImage", sender vtex.admin-catalog@2.x, provider
// vtex.catalog-images@0.x). Returns a URL already hosted on
// {account}.vtexassets.com, which is what the Seller Portal product API's
// own `images` field requires.
//
// Built as a proper ExternalClient — not the raw axios.post() this started
// as inline in sellerProductsHandler.ts — specifically so it gets this
// app's default retry/timeout handling (node/index.ts's Service
// clients.options.default: {retries: 2, timeout: 10000}). Confirmed live
// 2026-10-23 that the raw-axios version intermittently failed with
// "Client network socket disconnected before secure TLS connection was
// established" — a bare TLS-handshake drop before any HTTP response, the
// exact class of transient network error a managed VTEX IO client retries
// past on its own, instead of surfacing to the user as a hard failure.
export class SellerImageUploadClient extends ExternalClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(`https://${context.account}.myvtex.com`, context, {
      ...options,
      headers: {
        Accept: '*/*',
        'Proxy-Authorization': context.authToken,
        VtexIdclientAutCookie: context.authToken,
      },
      timeout: 20000,
    })
  }

  private userHeaders(userToken?: string) {
    return userToken ? { VtexIdclientAutCookie: userToken, 'Proxy-Authorization': userToken } : {}
  }

  // Sent without the full GraphQL query text (standard Automatic Persisted
  // Queries) — safe because this is a long-published, platform-wide query
  // used by every VTEX account's admin UI, not something account-specific
  // that could be missing from VTEX's cache.
  private static readonly SAVE_IMAGE_PERSISTED_HASH = 'b5ba21c6bc3fc0182305c88284ade93b9db77a770e5c3ff6ed743b9b7463ae81'

  private static buildMultipartBody(
    boundary: string,
    fields: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }>
  ): Buffer {
    const parts: Buffer[] = []
    for (const f of fields) {
      let header = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
      if (f.filename) header += `; filename="${f.filename}"`
      header += '\r\n'
      if (f.contentType) header += `Content-Type: ${f.contentType}\r\n`
      header += '\r\n'
      parts.push(Buffer.from(header, 'utf8'))
      parts.push(f.data ?? Buffer.from(f.value ?? '', 'utf8'))
      parts.push(Buffer.from('\r\n', 'utf8'))
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
    return Buffer.concat(parts)
  }

  public async uploadImage(
    filename: string,
    data: Buffer,
    contentType: string,
    userToken?: string
  ): Promise<{ id: string; url: string }> {
    const boundary = `----vtexmdm${Date.now()}${Math.random().toString(36).slice(2, 8)}`
    const operations = JSON.stringify({
      operationName: 'saveImage',
      variables: { filename, file: null },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: SellerImageUploadClient.SAVE_IMAGE_PERSISTED_HASH,
          sender: 'vtex.admin-catalog@2.x',
          provider: 'vtex.catalog-images@0.x',
        },
      },
    })
    const map = JSON.stringify({ '0': ['variables.file'] })
    const body = SellerImageUploadClient.buildMultipartBody(boundary, [
      { name: 'operations', value: operations },
      { name: 'map', value: map },
      { name: '0', filename, contentType, data },
    ])

    const res: any = await this.http.post(
      '/_v/private/graphql/v1?workspace=master&maxAge=long&appsEtag=remove&domain=admin&locale=en-US',
      body,
      {
        headers: {
          ...this.userHeaders(userToken),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
      }
    )
    if (res?.errors?.length) {
      throw new Error(res.errors.map((e: any) => e.message).join('; '))
    }
    const result = res?.data?.saveImage
    if (!result?.fullUrl || !result?.id) {
      throw new Error("VTEX's image upload didn't return a usable URL")
    }
    return { id: result.id, url: result.fullUrl }
  }
}
