/* oxlint-disable max-classes-per-file -- the ways a store call fails that its caller tells apart */

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// This hex's store can take nothing from it now: the call didn't reach it, its answer never came back, or the store said no to every call (a wrong key, no such object, one still empty, or older than this hex). Nothing landed, or it may have; the same call may land later.
export class UnreachedError extends Error {
  override name = "UnreachedError";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store ran this one call and said no: nothing of it landed, and the same call never will.
export class RefusedError extends Error {
  override name = "RefusedError";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The object refused this process's tenure: another hub claimed hex since.
export class LostError extends Error {
  override name = "LostError";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The folder's records moved to a Durable Object after this process opened its hex.db: its store is the one the folder's store.json names now.
export class MovedError extends Error {
  override name = "MovedError";
}
