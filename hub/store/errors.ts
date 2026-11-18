/* oxlint-disable max-classes-per-file -- the ways a store call fails that its caller tells apart */

export class UnreachedError extends Error {
  override name = "UnreachedError";
}

export class OtherStoreError extends UnreachedError {
  override name = "OtherStoreError";
}

export class UnaskedError extends UnreachedError {
  override name = "UnaskedError";
}

export class RefusedError extends Error {
  override name = "RefusedError";
}

export class LostError extends Error {
  override name = "LostError";
}

export class MovedError extends Error {
  override name = "MovedError";
}
