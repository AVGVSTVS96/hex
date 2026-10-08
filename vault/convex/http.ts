import { anyApi as api, httpActionGeneric as httpAction, httpRouter } from "convex/server"
import { page } from "./page"

const limit = 64 * 1024
const http = httpRouter()

const slugOf = (request: Request) => new URL(request.url).pathname.slice("/d/".length)

http.route({
  pathPrefix: "/d/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const state = await ctx.runQuery(api.drops.state, { slug: slugOf(request) })
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    return new Response(page(state, nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      },
    })
  }),
})

http.route({
  pathPrefix: "/d/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const sealed = await request.text()
    if (sealed.length > limit || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(sealed)) return new Response(null, { status: 400 })
    const ok = await ctx.runMutation(api.drops.seal, { slug: slugOf(request), sealed })
    return new Response(null, { status: ok ? 204 : 410 })
  }),
})

export default http
