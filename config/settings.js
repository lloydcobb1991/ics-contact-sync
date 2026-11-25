// Thresholds and safety rails. Values here match the build spec.
export const settings = {
  // Export older than this (hours) => skip the run and alert. The export is uploaded weekly,
  // so 8 days allows one missed Monday's grace. Drop to 26 if exports ever become daily.
  maxSnapshotAgeHours: 8 * 24,

  // New snapshot with fewer than this share of the previous snapshot's records => treat as a bad export.
  minRecordRatio: 0.5,

  // Circuit breaker: more than this many auto changes in one run, or more than this share
  // of any one audience, sends every auto change to Approval instead.
  circuitBreaker: { maxAutoChanges: 50, maxAudienceShare: 0.10 },

  // Mailchimp write concurrency and retries.
  mailchimp: { concurrency: 4, retries: 2, pageSize: 1000 },
};
