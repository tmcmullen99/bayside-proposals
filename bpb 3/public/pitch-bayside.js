// Sticky nav border on scroll
const topnav = document.getElementById('topnav');
window.addEventListener('scroll', () => {
  topnav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// Reveal-on-scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -80px 0px' });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Hero counter animation
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    const target = parseInt(el.dataset.countTo, 10);
    if (isNaN(target)) return;
    const duration = 1400;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(eased * target);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    counterObserver.unobserve(el);
  });
}, { threshold: 0.5 });
document.querySelectorAll('[data-count-to]').forEach(el => counterObserver.observe(el));

// Animate Hot Deals breakdown bars when in view
const cardObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.querySelectorAll('.hd-comp-bar-fill-demo').forEach(b => b.classList.add('animate'));
    cardObserver.unobserve(entry.target);
  });
}, { threshold: 0.4 });
const hd = document.getElementById('hotDealsDemo');
if (hd) cardObserver.observe(hd);

// Elisa timeline tooltips
const tooltip = document.getElementById('timelineTooltip');
const timelineSvg = document.getElementById('timelineSvg');
if (timelineSvg && tooltip) {
  document.querySelectorAll('.session-dot').forEach(dot => {
    dot.addEventListener('mouseenter', () => {
      const detail = dot.dataset.detail;
      const day = dot.dataset.day;
      const events = dot.dataset.events;
      tooltip.innerHTML = `<strong style="color:#b78b3a">Day ${day}</strong> · ${events} events<br><span style="opacity:0.85">${detail}</span>`;
      const wrapRect = timelineSvg.parentElement.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const left = dotRect.left - wrapRect.left + dotRect.width / 2;
      const top = dotRect.top - wrapRect.top;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.classList.add('visible');
    });
    dot.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  });
}

// Pricing calculator — revenue-impact framing (rebuilt 2026-05-17 v3)
const projectsSlider = document.getElementById('projectsSlider');
const projectSizeSlider = document.getElementById('projectSizeSlider');
const liftSlider = document.getElementById('liftSlider');
const BASELINE_CLOSE_RATE = 0.25;
const DESIGNER_COMMISSION_PCT = 0.10;
const PORTAL_FEE_PCT = 0.01;

function fmtKM(n) {
  const abs = Math.abs(n);
  if (abs >= 1000000) {
    const m = n / 1000000;
    const str = (m % 1 === 0) ? m.toFixed(0) : m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + str + 'M';
  }
  if (abs >= 10000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtExact(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function updateCalc() {
  const projects = parseInt(projectsSlider.value, 10);
  const projectSize = parseInt(projectSizeSlider.value, 10);
  const liftPts = parseInt(liftSlider.value, 10);

  const designerCommission = projectSize * DESIGNER_COMMISSION_PCT;
  const portalFee = projectSize * PORTAL_FEE_PCT;

  const liftedRate = BASELINE_CLOSE_RATE + (liftPts / 100);
  const baselineDeals = projects * BASELINE_CLOSE_RATE;
  const liftedDeals = projects * liftedRate;

  const baselineRevenue = baselineDeals * projectSize;
  const liftedRevenue = liftedDeals * projectSize;
  const incrementalRevenue = liftedRevenue - baselineRevenue;
  const totalPortalFees = liftedDeals * portalFee;
  const portalROI = (totalPortalFees > 0 && incrementalRevenue > 0)
    ? (incrementalRevenue / totalPortalFees)
    : 0;

  document.getElementById('projectsLabel').textContent = projects;
  document.getElementById('projectSizeLabel').textContent = fmtExact(projectSize);
  document.getElementById('liftLabel').textContent = '+' + liftPts + ' pts';

  document.getElementById('projectValue').textContent = fmtExact(projectSize);
  document.getElementById('designerCommission').textContent = fmtExact(designerCommission);
  document.getElementById('portalFee').textContent = fmtExact(portalFee);

  document.getElementById('projectsContext').textContent = projects;
  document.getElementById('baselineRevenue').textContent = fmtKM(baselineRevenue);
  document.getElementById('liftedRateLabel').textContent = Math.round(liftedRate * 100) + '%';
  document.getElementById('liftedRevenue').textContent = fmtKM(liftedRevenue);
  document.getElementById('pricingIncRevenue').textContent = fmtKM(incrementalRevenue);
  document.getElementById('totalPortalFees').textContent = fmtExact(totalPortalFees);
  document.getElementById('portalROI').textContent = portalROI > 0 ? portalROI.toFixed(1) + '×' : '—';
}

if (projectsSlider && projectSizeSlider && liftSlider) {
  [projectsSlider, projectSizeSlider, liftSlider].forEach(s => s.addEventListener('input', updateCalc));
  updateCalc();
}

// Conversion lift calculator
const currentRespSlider = document.getElementById('currentRespSlider');
const bpbRespSlider = document.getElementById('bpbRespSlider');
const liftVolumeSlider = document.getElementById('liftVolumeSlider');
const AVG_DEAL_SIZE = 50000;

function fmtHours(h) {
  if (h < 24) return h + (h === 1 ? ' hour' : ' hours');
  const days = Math.round(h / 24 * 10) / 10;
  return days + (days === 1 ? ' day' : ' days');
}

function closeRateAt(hours) {
  return Math.max(0.07, 0.22 * Math.exp(-0.018 * hours) + 0.06);
}

function fmtMoney(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + Math.round(n);
}

function updateLiftCalc() {
  const currentH = parseInt(currentRespSlider.value, 10);
  const bpbH = parseInt(bpbRespSlider.value, 10);
  const volume = parseInt(liftVolumeSlider.value, 10);

  document.getElementById('currentRespLabel').textContent = fmtHours(currentH);
  document.getElementById('bpbRespLabel').textContent = fmtHours(bpbH);
  document.getElementById('liftVolumeLabel').textContent = volume;

  const currR = closeRateAt(currentH);
  const bpbR = closeRateAt(bpbH);
  const lift = currR > 0 ? ((bpbR - currR) / currR) * 100 : 0;
  const incDeals = volume * (bpbR - currR);
  const incRev = incDeals * AVG_DEAL_SIZE;

  document.getElementById('currentCloseRate').textContent = Math.round(currR * 100) + '%';
  document.getElementById('bpbCloseRate').textContent = Math.round(bpbR * 100) + '%';
  document.getElementById('liftPct').textContent = (lift >= 0 ? '+' : '') + Math.round(lift) + '%';
  document.getElementById('incDeals').textContent = (incDeals >= 0 ? '+' : '') + Math.round(incDeals);
  document.getElementById('incRevenue').textContent = (incRev >= 0 ? '+' : '') + fmtMoney(Math.abs(incRev));
}

if (currentRespSlider && bpbRespSlider && liftVolumeSlider) {
  [currentRespSlider, bpbRespSlider, liftVolumeSlider].forEach(s =>
    s.addEventListener('input', updateLiftCalc)
  );
  updateLiftCalc();
}
