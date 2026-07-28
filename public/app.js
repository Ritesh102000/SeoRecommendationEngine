const form = document.querySelector('#audit-form');
const input = document.querySelector('#url');
const button = document.querySelector('#submit');
const errorBox = document.querySelector('#error');
const results = document.querySelector('#results');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  results.hidden = true;
  button.disabled = true;
  button.innerHTML = 'Scanning…';

  try {
    const competitors = document.querySelector('#competitors').value
      .split(/\n|,/).map((item) => item.trim()).filter(Boolean);
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: input.value,
        useAI: document.querySelector('#use-ai').checked,
        autoFind: document.querySelector('#auto-find').checked,
        competitors,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The audit failed.');
    render(data);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Audit my page <span>→</span>';
  }
});

function render(data) {
  const score = document.querySelector('#score');
  score.querySelector('strong').textContent = data.score;
  score.className = `score ${data.score >= 80 ? 'good' : data.score >= 55 ? 'fair' : 'poor'}`;
  document.querySelector('#result-title').textContent = data.title || 'Untitled page';
  const link = document.querySelector('#result-url');
  link.textContent = data.url;
  link.href = data.url;

  const summary = data.summary;
  document.querySelector('#stats').innerHTML = [
    ['Words', summary.wordCount],
    ['Headings', summary.headings],
    ['Images', summary.images],
    ['Internal links', summary.internalLinks],
  ].map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');

  renderInsights(data);
  document.querySelector('#issue-count').textContent = `${data.findings.length} issues`;
  document.querySelector('#findings').innerHTML = data.findings.length
    ? data.findings.map((item) => `
      <article class="finding">
        <span class="severity ${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span>
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.detail)}</p>
          <div class="fix"><b>Fix:</b> ${escapeHtml(item.fix)}</div>
        </div>
      </article>`).join('')
    : '<div class="all-good">No issues found. This page passed every check.</div>';

  document.querySelector('#passed-summary').textContent = `${data.passed.length} checks passed`;
  document.querySelector('#passed-list').innerHTML = data.passed
    .map((item) => `<span>✓ ${escapeHtml(item.label)}</span>`).join('');
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInsights(data) {
  const ai = data.ai && !data.ai.error ? data.ai : null;
  const keywords = ai?.keywords?.length ? ai.keywords : data.keywords;
  document.querySelector('#keyword-source').textContent = ai ? 'AI enhanced' : 'Page analysis';
  const summary = document.querySelector('#ai-summary');
  summary.textContent = ai?.summary || data.ai?.error || '';
  summary.hidden = !summary.textContent;
  document.querySelector('#keywords').innerHTML = keywords.map((item) => `
    <article class="keyword">
      <strong>${escapeHtml(item.term)}</strong>
      <span>${escapeHtml(item.intent || item.status || '')}</span>
      ${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ''}
    </article>`).join('');

  const competitorWrap = document.querySelector('#competitor-results');
  const competitors = ai?.competitors || data.manualCompetitors.map((url) => ({ name: url, url, reason: 'Added manually' }));
  competitorWrap.hidden = !competitors.length;
  document.querySelector('#competitor-list').innerHTML = competitors.map((item) => `
    <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
      <strong>${escapeHtml(item.name || item.url)}</strong>
      <span>${escapeHtml(item.reason || '')}</span>
    </a>`).join('');
}
