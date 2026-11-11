// Scheduled US macro events. Dates copied from the official calendars:
//   Jobs report: https://www.bls.gov/schedule/news_release/empsit.htm
//   CPI:         https://www.bls.gov/schedule/news_release/cpi.htm
//   FOMC:        https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// 2027 FOMC dates are tentative until the Fed confirms them. Add more rows as agencies publish them.

const JOBS = ['2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07',
  '2027-06-04', '2027-07-02', '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03'];
const CPI = ['2026-11-10', '2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10', '2027-04-13', '2027-05-12',
  '2027-06-10', '2027-07-14', '2027-08-11', '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10'];
// Rate decision is announced on the second day of each meeting (2:00 PM ET).
const FOMC = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];

export const MACRO_EVENTS = [
  ...JOBS.map((date) => ({ date, time: '8:30 AM ET', kind: 'macro', title: 'Jobs report (nonfarm payrolls & unemployment)',
    why: 'Strong hiring can push rates up; weak hiring raises recession worries. Often moves the whole market.' })),
  ...CPI.map((date) => ({ date, time: '8:30 AM ET', kind: 'macro', title: 'CPI inflation report',
    why: 'Hotter inflation makes Fed rate cuts less likely, which usually weighs on growth stocks.' })),
  ...FOMC.map((date) => ({ date, time: '2:00 PM ET', kind: 'fed', title: 'Fed (FOMC) interest-rate decision',
    why: 'Sets short-term interest rates. The statement and press conference can swing stocks and bonds.' })),
];

export function upcomingMacro(from = new Date(), days = 120) {
  const start = from.toISOString().slice(0, 10);
  const end = new Date(from.getTime() + days * 86400000).toISOString().slice(0, 10);
  return MACRO_EVENTS.filter((e) => e.date >= start && e.date <= end);
}
