import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  drops: defineTable({
    slug: v.string(),
    sealed: v.optional(v.string()),
  }).index("slug", ["slug"]),
})
