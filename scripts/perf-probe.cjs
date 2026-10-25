// The perf scripts' way into the client's PerfProbe (src/Core/PerfProbe.js in
// the roBrowserLegacy fork), as page code for `rotest eval`.
//
// Since roBrowserLegacy #78 the probe runs when the configuration has
// `perfProbe: true` (rotest sets it with ROTEST_PERF=1) and has no global of
// its own; the test-only AgentHook hands it out as roAgent.perf. Builds from
// before #78 publish window.roPerf instead, with the same stats(), reset(),
// slowFrames() and marks, so both are read the same way.
//
// Two differences to know when comparing numbers across that line: reset()
// now also clears marks.maps, and fps counts only the time spent drawing, so
// a map load inside a window no longer lowers it.
'use strict';

// An expression for the probe, or null/undefined while it is not running.
const PERF = '(window.roAgent && window.roAgent.perf && window.roAgent.perf.enabled ? window.roAgent.perf : window.roPerf)';

// Page code that runs `body` with `perf` bound to the probe (possibly null).
const withPerf = body => `((perf) => (${body}))(${PERF})`;

module.exports = { PERF, withPerf };
