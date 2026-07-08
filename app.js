/* EclipseTracker Logic
   Offline determination of upcoming eclipses. 
   Contains an embedded list of major global solar/lunar eclipses.
*/

const ECLIPSE_DATA = [
  { date: '2026-08-12T17:47:00Z', type: 'Total Solar Eclipse', region: 'Arctic, E. Greenland, Iceland, Spain', magnitude: '1.039' },
  { date: '2026-08-28T04:14:00Z', type: 'Partial Lunar Eclipse', region: 'Americas, Europe, Africa', magnitude: '0.934' },
  { date: '2027-02-06T16:00:00Z', type: 'Annular Solar Eclipse', region: 'S. America, Antarctica, W. Africa', magnitude: '0.928' },
  { date: '2027-02-20T23:14:00Z', type: 'Penumbral Lunar Eclipse', region: 'Americas, Europe, Africa, Asia', magnitude: '-0.052' },
  { date: '2027-08-02T10:07:00Z', type: 'Total Solar Eclipse', region: 'N. Africa, Middle East, Spain', magnitude: '1.079' },
  { date: '2028-01-26T15:08:00Z', type: 'Annular Solar Eclipse', region: 'S. America, W. Europe, N. Africa', magnitude: '0.921' },
  { date: '2028-07-22T02:56:00Z', type: 'Total Solar Eclipse', region: 'Australasia, SE Asia', magnitude: '1.056' },
  { date: '2029-06-12T04:06:00Z', type: 'Partial Solar Eclipse', region: 'Arctic, Scandinavia, N. America', magnitude: '0.457' },
  { date: '2030-06-01T06:29:00Z', type: 'Annular Solar Eclipse', region: 'N. Africa, Europe, Asia', magnitude: '0.944' },
  { date: '2030-11-25T06:51:00Z', type: 'Total Solar Eclipse', region: 'South Africa, Indian Ocean, Australia', magnitude: '1.047' },
  { date: '2031-05-21T07:16:00Z', type: 'Annular Solar Eclipse', region: 'Africa, India, Indonesia', magnitude: '0.959' },
  { date: '2031-11-14T21:07:00Z', type: 'Hybrid Solar Eclipse', region: 'Pacific Ocean, Panama', magnitude: '1.011' },
  { date: '2032-05-09T13:26:00Z', type: 'Annular Solar Eclipse', region: 'S. America, Atlantic', magnitude: '0.996' },
  { date: '2033-03-30T18:02:00Z', type: 'Total Solar Eclipse', region: 'Russia, Alaska', magnitude: '1.046' },
  { date: '2034-03-20T10:18:00Z', type: 'Total Solar Eclipse', region: 'Africa, Middle East, China', magnitude: '1.046' },
  { date: '2035-09-02T01:56:00Z', type: 'Total Solar Eclipse', region: 'China, Japan, Pacific', magnitude: '1.032' },
  { date: '2037-07-13T02:40:00Z', type: 'Total Solar Eclipse', region: 'Australia, New Zealand', magnitude: '1.031' },
  { date: '2038-01-05T13:47:00Z', type: 'Annular Solar Eclipse', region: 'Caribbean, Africa', magnitude: '0.973' },
  { date: '2038-07-02T13:32:00Z', type: 'Annular Solar Eclipse', region: 'South America, Africa', magnitude: '0.991' },
  { date: '2038-12-26T01:00:00Z', type: 'Total Solar Eclipse', region: 'Australia, New Zealand', magnitude: '1.027' },
  { date: '2039-12-15T16:23:00Z', type: 'Total Solar Eclipse', region: 'Antarctica', magnitude: '1.036' },
  { date: '2041-04-30T11:52:00Z', type: 'Total Solar Eclipse', region: 'Africa', magnitude: '1.019' },
  { date: '2042-04-20T02:17:00Z', type: 'Total Solar Eclipse', region: 'Indonesia, Philippines, Pacific', magnitude: '1.061' },
  { date: '2043-04-09T18:57:00Z', type: 'Total Solar Eclipse', region: 'Russia, North America', magnitude: '1.010' },
  { date: '2044-08-23T01:17:00Z', type: 'Total Solar Eclipse', region: 'Greenland, North America', magnitude: '1.036' },
  { date: '2045-08-12T17:42:00Z', type: 'Total Solar Eclipse', region: 'USA, South America', magnitude: '1.077' },
  { date: '2046-08-02T10:21:00Z', type: 'Total Solar Eclipse', region: 'Brazil, Africa', magnitude: '1.053' },
  { date: '2052-03-30T18:31:00Z', type: 'Total Solar Eclipse', region: 'Pacific Ocean, North America', magnitude: '1.047' }
];

let nextEclipse = null;

function findNextEclipse() {
  const now = new Date().getTime();
  
  for (const eclipse of ECLIPSE_DATA) {
    const eclipseTime = new Date(eclipse.date).getTime();
    if (eclipseTime > now) {
      return eclipse;
    }
  }
  return ECLIPSE_DATA[ECLIPSE_DATA.length - 1]; // Fallback to last known if all passed
}

function updateUI() {
  if (!nextEclipse) {
    nextEclipse = findNextEclipse();
  }

  const now = new Date().getTime();
  const eclipseTime = new Date(nextEclipse.date).getTime();
  const diff = eclipseTime - now;

  if (diff < 0) {
    // Eclipse just passed, recalculate
    nextEclipse = findNextEclipse();
    requestAnimationFrame(updateUI);
    return;
  }

  // Calculate time components
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  // Format with leading zeros
  const d = String(days).padStart(2, '0');
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');

  // Update DOM
  document.getElementById('countdown-timer').textContent = `${d}:${h}:${m}:${s}`;
  
  // These only need to be set once per eclipse, but setting them here is fine for simplicity
  document.getElementById('eclipse-type').textContent = nextEclipse.type;
  
  // Format Date gracefully based on user's locale
  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  
  document.getElementById('eclipse-date').textContent = formatter.format(new Date(nextEclipse.date));
  document.getElementById('eclipse-region').textContent = nextEclipse.region;
  document.getElementById('eclipse-type-detail').textContent = nextEclipse.type;
  document.getElementById('eclipse-magnitude').textContent = nextEclipse.magnitude;

  requestAnimationFrame(updateUI);
}

// Start simulation
document.addEventListener('DOMContentLoaded', () => {
  updateUI();
});
