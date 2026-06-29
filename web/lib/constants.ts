// One invisible lookback default — drives both the Gmail fetch window and the
// digest window. Deliberately NOT a user setting: kin minimizes explicit knobs,
// so this is a sensible engineering default for the initial view, not a dial.
export const LOOKBACK_HOURS = 24 * 7 // 7 days
