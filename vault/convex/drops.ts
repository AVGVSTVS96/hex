import {
  anyApi as api,
  type GenericDatabaseReader,
  internalMutationGeneric as internalMutation,
  internalQueryGeneric as internalQuery,
  mutationGeneric as mutation,
  queryGeneric as query,
} from "convex/server"
import { v } from "convex/values"

const lifetime = 10 * 60 * 1000

async function slugOf(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return btoa(String.fromCharCode(...new Uint8Array(digest, 0, 16)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function find(db: GenericDatabaseReader<any>, slug: string) {
  return db.query("drops").withIndex("slug", (q) => q.eq("slug", slug)).unique()
}

export const open = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    const slug = await slugOf(secret)
    if (await find(ctx.db, slug)) throw new Error("drop already exists")
    const id = await ctx.db.insert("drops", { slug })
    await ctx.scheduler.runAfter(lifetime, api.drops.expire, { id })
    return `${process.env.CONVEX_SITE_URL}/d/${slug}`
  },
})

export const watch = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    const drop = await find(ctx.db, await slugOf(secret))
    return drop ? (drop.sealed ? "sealed" : "open") : "gone"
  },
})

export const take = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    const drop = await find(ctx.db, await slugOf(secret))
    if (!drop) return null
    await ctx.db.delete(drop._id)
    return drop.sealed ?? null
  },
})

export const close = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    const drop = await find(ctx.db, await slugOf(secret))
    if (drop) await ctx.db.delete(drop._id)
  },
})

export const state = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const drop = await find(ctx.db, slug)
    return drop ? (drop.sealed ? "used" : "open") : "gone"
  },
})

export const seal = internalMutation({
  args: { slug: v.string(), sealed: v.string() },
  handler: async (ctx, { slug, sealed }) => {
    const drop = await find(ctx.db, slug)
    if (!drop || drop.sealed) return false
    await ctx.db.patch(drop._id, { sealed })
    return true
  },
})

export const expire = internalMutation({
  args: { id: v.id("drops") },
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id)
  },
})
