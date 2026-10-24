// The numbers Fig 1 shows, kept apart from the drawing so the motion and the readout
// can't disagree. They match the server:
// - a timetable is built for 9 service days: yesterday (trains still running after
//   midnight), today and the next 7 (policy windowDays: 7);
// - live trip updates are polled every 30 s for the NYC subway;
// - live data corrects only trips running now, so only today's card gets it;
// - with the feed cut, an answer falls back to the timetable and says scheduled_only.

export const DAYS = 9;
export const TODAY = 1;
export const POLL_SECONDS = 30;
/** A train every 6 minutes on the timetable; the live feed says they're running 2 late. */
export const HEADWAY = 6;
export const LATE = 2;

export const dayName = (day) => ["yesterday", "today", "tomorrow"][day] ?? `in ${day - 1} days`;

/** The next train after `minute` (minutes past the hour) on `day`, read the way the server
 * reads it: timetable first, corrected by live data when there is some for that trip. */
export function answer({ day, live, minute }) {
  const realtime = live && day === TODAY;
  const shift = realtime ? LATE : 0;
  let arrives = Math.ceil((minute - shift) / HEADWAY) * HEADWAY + shift;
  if (arrives <= minute) arrives += HEADWAY;
  const status = day !== TODAY ? "timetable" : realtime ? "realtime" : "scheduled_only";
  return { day, wait: arrives - minute, status, realtime };
}

export function readout({ day, wait, status }) {
  const minutes = Math.max(1, Math.round(wait));
  return `${dayName(day)} · ${minutes} min · ${status}`;
}
