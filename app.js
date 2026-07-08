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
  { date: '2029-07-11T15:37:00Z', type: 'Partial Solar Eclipse', region: 'S. America, Antarctica', magnitude: '0.543' },
  { date: '2029-12-05T15:03:00Z', type: 'Partial Solar Eclipse', region: 'S. America, Antarctica', magnitude: '0.891' },
  { date: '2030-06-01T06:29:00Z', type: 'Annular Solar Eclipse', region: 'N. Africa, Europe, Asia', magnitude: '0.944' }
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
