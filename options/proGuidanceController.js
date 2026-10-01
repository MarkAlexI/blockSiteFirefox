import {
  PRO_GUIDANCE_STORAGE_KEY,
  normalizeProGuidanceState,
  resolveProGuidance
} from './userGuidance.js';

// The background context is the only writer. Its shared transition queue orders
// guidance commits/dismissals with Pro changes, across all open Options pages.
export function createProGuidanceController({ storage, getAccess, runExclusive, now = () => Date.now() }) {
  const hasPaidAccess = async () => {
    const access = await getAccess();
    return access.isPro || access.isLegacyUser;
  };
  const readState = async () => {
    const result = await storage.get([PRO_GUIDANCE_STORAGE_KEY]);
    return normalizeProGuidanceState(result[PRO_GUIDANCE_STORAGE_KEY]);
  };
  const matches = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  return {
    // A preview never consumes a day. Do not queue a potentially slow read in
    // front of dismiss: the later acknowledgement revalidates this snapshot.
    async preview() {
      if (!await hasPaidAccess()) return { hasPaidAccess: false, tipKey: null };
      const snapshot = await readState();
      const resolved = resolveProGuidance(snapshot, now());
      return { hasPaidAccess: true, snapshot, tipKey: resolved.tipKey,
        lastShownDay: resolved.state?.lastShownDay ?? null };
    },

    // Options acknowledges only after a current, visible render (or the visible
    // visit that completes the cycle). Never write the state supplied by a page.
    shown(request) {
      return runExclusive(async () => {
        if (!await hasPaidAccess()) return { hasPaidAccess: false, tipKey: null };
        const current = await readState();
        const resolved = resolveProGuidance(current, now());
        if (!matches(current, request.snapshot) || resolved.tipKey !== request.tipKey ||
            (resolved.state?.lastShownDay ?? null) !== request.lastShownDay) {
          return { hasPaidAccess: true, stale: true };
        }
        if (resolved.changed && resolved.state) {
          await storage.set({ [PRO_GUIDANCE_STORAGE_KEY]: resolved.state });
        }
        return { hasPaidAccess: true, tipKey: resolved.tipKey };
      });
    },

    dismiss() {
      return runExclusive(async () => {
        let current = await readState();
        if (!current) {
          if (!await hasPaidAccess()) return {};
          current = resolveProGuidance(null, now()).state;
        }
        // Preserve the last actually shown day/index; dismiss is not a visit
        // that advances the cycle. Repeated dismissals do not write again.
        if (current && !current.dismissed) {
          await storage.set({ [PRO_GUIDANCE_STORAGE_KEY]: { ...current, dismissed: true } });
        }
        return {};
      });
    }
  };
}
