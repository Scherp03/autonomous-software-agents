// ─── Plan Library Registry ────────────────────────────────────────────────────
// Shared mutable array populated by plans.js and iterated by IntentionDeliberation.
// Both modules import the same array reference, so push() in plans.js is visible here.

/** @type {(typeof import('./intentions.js').PlanBase)[]} */
export const planLibrary = [];
