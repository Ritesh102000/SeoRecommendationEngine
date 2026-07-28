const form = document.querySelector('#audit-form');
const input = document.querySelector('#url');
const button = document.querySelector('#submit');
const errorBox = document.querySelector('#error');
const results = document.querySelector('#results');
const providerSelect = document.querySelector('#provider');
const providerKey = document.querySelector('#provider-key');
const providerRecovery = document.querySelector('#provider-recovery');
let lastRequest = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const competitors = document.querySelector('#competitors').value
    .split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  const selectedProvider = providerSelect.value;
  const key = providerKey.value.trim();
  if (document.querySelector('#use-ai').checked && selectedProvider !== 'managed' && !key) {
    errorBox.textContent = `Enter your ${selectedProvider === 'claude' ? 'Claude' : selectedProvider === 'groq' ? 'Groq' : 'OpenAI'} API key.`;
    errorBox.hidden = false;
    document.querySelector('#provider-options').open = true;
    providerKey.focus();
    return;
  }
  lastRequest = {
    url: input.value,
    useAI: document.querySelector('#use-ai').checked,
    autoFind: document.querySelector('#auto-find').checked,
    competitors,
    provider: selectedProvider,
  };
  await runAudit({ ...lastRequest, providerKey: key || undefined });
  providerKey.value = '';
});

providerSelect.addEventListener('change', renderProviderFields);
document.querySelector('#choose-provider').addEventListener('click', () => {
  const options = document.querySelector('#provider-options');
  options.open = true;
  options.scrollIntoView({ behavior: 'smooth', block: 'center' });
  providerSelect.focus();
});
renderProviderFields();

async function runAudit(payload) {
  errorBox.hidden = true;
  button.disabled = true;
  button.innerHTML = 'Scanning…';

  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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
}

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
  document.querySelector('#keyword-source').textContent = ai
    ? `${ai.provider === 'groq' ? 'Groq' : ai.provider === 'claude' ? 'Claude' : 'OpenAI'} enhanced`
    : 'Page analysis';
  const summary = document.querySelector('#ai-summary');
  summary.textContent = ai?.summary || data.ai?.error || '';
  summary.hidden = !summary.textContent;
  providerRecovery.hidden = !data.ai?.needsProviderKey;
  if (data.ai?.needsProviderKey) renderProviderAction(data.ai);
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

function renderProviderAction(ai) {
  const title = document.querySelector('#provider-recovery-title');
  const message = document.querySelector('#provider-recovery-message');
  const actions = {
    choose_provider: ['Built-in OpenAI is unavailable', 'Choose OpenAI, Groq, or Claude and provide your own API key.'],
    replace_key: ['Check your API key', 'The provider rejected this key. Copy a valid key from its official console and try again.'],
    permissions: ['Provider permission required', 'Check that the key can use the selected model and web search, then retry.'],
    billing: ['Check provider billing', 'Restore API credits or raise the provider limit, then retry.'],
    wait: ['Provider is rate limited', `Wait ${ai.retryAfter || 10} seconds before trying again.`],
    retry: ['Temporary provider failure', 'Wait a moment, check your connection, and try again.'],
  };
  const [heading, instruction] = actions[ai.action] || actions.retry;
  title.textContent = heading;
  message.textContent = instruction;
}

function renderProviderFields() {
  const provider = providerSelect.value;
  const wrap = document.querySelector('#provider-key-wrap');
  const link = document.querySelector('#get-key-link');
  const config = {
    openai: ['https://platform.openai.com/api-keys', 'Get an OpenAI API key ↗', 'sk-…'],
    groq: ['https://console.groq.com/keys', 'Get a Groq API key ↗', 'gsk_…'],
    claude: ['https://platform.claude.com/settings/keys', 'Get a Claude API key ↗', 'sk-ant-…'],
  };
  wrap.hidden = provider === 'managed';
  if (provider !== 'managed') {
    const [href, label, placeholder] = config[provider];
    link.href = href;
    link.textContent = label;
    providerKey.placeholder = placeholder;
  }
}
