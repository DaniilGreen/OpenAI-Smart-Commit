// OpenAI Smart Commit - VS Code extension
const vscode = require('vscode');
const cp = require('child_process');
const https = require('https');

function sh(cmd, cwd) { try { return cp.execSync(cmd, { cwd, encoding: 'utf8' }).trim(); } catch { return ''; } }
function trunc(s, m) { if (!s) return ''; return s.length <= m ? s : s.slice(0, m) + `\n...<truncated ${s.length - m} chars>`; }
function postJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : require('http');
    const req = mod.request({ method: 'POST', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }
        else { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function generate(repo, selectedKey) {
  const cwd = repo.rootUri.fsPath;
  const branch = sh('git rev-parse --abbrev-ref HEAD', cwd);

  const cfg = vscode.workspace.getConfiguration('openaiSmartCommit');
  const apiKey = cfg.get('apiKey') || process.env.OPENAI_API_KEY;
  const model = cfg.get('model');
  const endpoint = cfg.get('endpoint');
  const temperature = cfg.get('temperature');
  const maxTokens = cfg.get('maxTokens');
  const timeDefault = cfg.get('timeDefault');
  const includeMode = cfg.get('includeUntracked');
  let prompt = cfg.get('prompt') || '';
  const commentDetail = cfg.get('commentDetail');
  if (commentDetail === 'brief') { prompt += '\nUse brief Russian comment (8–12 words).'; }
  else if (commentDetail === 'detailed') { prompt += '\nUse detailed Russian comment (18–30 words) with what/why/impact and key files.'; }
  const issuePicker = cfg.get('issuePicker');
  const jiraBase = cfg.get('jira.baseUrl');

  const jiraTokenSetting = cfg.get('jira.apiToken');
  const jiraJql = cfg.get('jira.jql');
  const jiraMax = cfg.get('jira.maxIssues');

  const stagedList = sh('git diff --cached --name-only', cwd);
  const workingList = sh('git diff --name-only', cwd);
  const addUntracked = includeMode === 'always' || (includeMode === 'auto' && !stagedList && !workingList);
  const untrackedList = addUntracked ? sh('git ls-files --others --exclude-standard', cwd) : '';
  const filesSet = new Set([ ...stagedList.split('\n'), ...workingList.split('\n'), ...untrackedList.split('\n') ].filter(Boolean));
  const files = Array.from(filesSet).slice(0, 200);

  const diffWorking = sh('git diff --unified=0', cwd);
  const diffStaged = sh('git diff --cached --unified=0', cwd);
  let diffUntracked = '';
  if (addUntracked && untrackedList) {
    const arr = untrackedList.split('\n').filter(Boolean).slice(0, 50);
    for (const p of arr) { try { diffUntracked += sh(`git diff --no-index --unified=0 /dev/null -- "${p}"`, cwd) + '\n'; } catch { } }
  }
  const diff = trunc([diffWorking, diffStaged, diffUntracked].filter(Boolean).join('\n'), 20000);

  if (!apiKey) vscode.window.showWarningMessage('OpenAI Smart Commit: set openaiSmartCommit.apiKey or OPENAI_API_KEY.');
  prompt = prompt.replace(/#time\s+30m/g, `#time ${timeDefault}`);

  // Holistic two-pass mode: analyze JSON then compose
  try {
    const holistic = vscode.workspace.getConfiguration('openaiSmartCommit').get('holisticMode');
    if (holistic) {
      const jiraSummary = selectedKey ? (await getJiraSummarySafe(jiraBase, jiraTokenSetting, selectedKey)) : '';
      const sys1 = 'You are a senior release engineer. Analyze the change set and return ONLY compact JSON with fields: {"type":"feat|fix|refactor|infra|ci|docs|test|chore","scope":"string or empty","subject_en":"6-10 words, imperative, no period","comment_ru":"1-4 lines Russian, each 12-24 words, explain what/why/effect; no tags, no file names"}. No prose, no code fences.';
      const user1 = `branch=${branch}\nissue=${selectedKey||''}\njira_summary=${jiraSummary||''}\nfiles=[${files.join(', ')}]\ndiff:\n${diff}`;
      const body1 = { model, temperature, max_tokens: maxTokens, messages: [ { role: 'system', content: sys1 }, { role: 'user', content: user1 } ] };
      const res1 = await postJson(endpoint, { Authorization: `Bearer ${apiKey}` }, body1);
      let txt = (res1?.choices?.[0]?.message?.content || '').trim();
      txt = txt.replace(/^```[a-zA-Z0-9]*\n?/g, '').replace(/```$/g, '').trim();
      const data = JSON.parse(txt);
      const typeH = (data.type || 'chore').toLowerCase();
      const scopeH = data.scope ? `(${data.scope})` : '';
      let headerH = `${typeH}${scopeH}: ${data.subject_en || 'update project files'}`;
      if (selectedKey) headerH = `${selectedKey} ${headerH}`;
      const cdLoc = vscode.workspace.getConfiguration('openaiSmartCommit').get('commentDetail');
      const minWordsLoc = (cdLoc === 'detailed') ? (vscode.workspace.getConfiguration('openaiSmartCommit').get('minCommentWordsDetailed')||18) : (vscode.workspace.getConfiguration('openaiSmartCommit').get('minCommentWordsNormal')||12);
      const ruLines = String(data.comment_ru || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const smartComments = (ruLines.length?ruLines:[ensureCommentDetail('', files, diff, minWordsLoc)]).map(c => `#comment ${ensureCommentDetail(c, files, diff, minWordsLoc)}`);
      const minutesAuto = estimateTimeMinutes(diff, files);
      const timeTag = formatMinutes(minutesAuto);
      repo.inputBox.value = [headerH, ...smartComments, `#time ${timeTag}`].join('\n');
      return;
    }
  } catch { /* fall back to single pass below */ }

  const system = prompt || 'You are an assistant generating a JIRA Smart Commit. Return exactly two lines.';
  const user = `branch=${branch}\nfiles=[${files.join(', ')}]\ndiff:\n${diff}`;
  const body = { model, temperature, max_tokens: maxTokens, messages: [ { role: 'system', content: system }, { role: 'user', content: user } ] };
  const json = await postJson(endpoint, { Authorization: `Bearer ${apiKey}` }, body);
  let content = (json?.choices?.[0]?.message?.content || '').trim();
  // Tolerate code fences / numbering / extra text
  content = content.replace(/^```[a-zA-Z0-9]*\n?/g, '').replace(/```$/g, '').trim();
  let rawLines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (rawLines.length === 0) {
    rawLines = ['type: update'];
  }
  // Normalize if model added numbering like "1)" / "2)"
  rawLines = rawLines.map(s => s.replace(/^\d+\)\s*/, ''));

  // Header + freeform comment lines (0..n)
  let headerLine = rawLines[0];
  let commentLines = rawLines.slice(1);

  // Inject or strip issue key in header
  if (selectedKey) {
    headerLine = headerLine
      .replace(/^ASK-ISSUE-KEY\b/, selectedKey)
      .replace(/^ISSUE-Key\b/, selectedKey)
      .replace(/^[A-Z][A-Z0-9]+-[0-9]+\b/, selectedKey);
    if (!/^([A-Z][A-Z0-9]+-[0-9]+)\b/.test(headerLine)) {
      headerLine = `${selectedKey} ${headerLine}`;
    }
  } else {
    headerLine = headerLine
      .replace(/^ASK-ISSUE-KEY\s+/, '')
      .replace(/^ISSUE-Key\s+/, '')
      .replace(/^[A-Z][A-Z0-9]+-[0-9]+\s+/, '');
  }

  // Ensure we have at least one decent comment line (Russian). Remove any tags from model.
  const cfgLoc = vscode.workspace.getConfiguration('openaiSmartCommit');
  const cd = cfgLoc.get('commentDetail');
  const minWords = (cd === 'detailed') ? (cfgLoc.get('minCommentWordsDetailed')||18) : (cfgLoc.get('minCommentWordsNormal')||12);
  if (commentLines.length === 0) {
    const improved = ensureCommentDetail('', files, diff, minWords);
    commentLines = [improved];
  } else {
    commentLines = commentLines
      .map(s => s
        .replace(/(^|\s)#(time|in-progress)\b[^\n]*/gi, '')
        .replace(/^#comment\s+/i,'')
        .trim())
      .filter(Boolean);
    if (commentLines.length === 0) {
      const improved = ensureCommentDetail('', files, diff, minWords);
      commentLines = [improved];
    }
  }

  // Compute time and build final message (multi-line comments)
  const minutesAuto = estimateTimeMinutes(diff, files);
  const timeTag = formatMinutes(minutesAuto);
  const commentsSmart = commentLines.map(c => `#comment ${ensureCommentDetail(c, files, diff, minWords)}`);
  const finalLines = [headerLine, ...commentsSmart, `#time ${timeTag}`];
  const finalMsg = finalLines.join('\n');

  repo.inputBox.value = finalMsg;
}

let gctx = null;
async function activate(context) {
  gctx = context;
  const disposable = vscode.commands.registerCommand('openaiSmartCommit.generate', async (...args) => {
    const repoArg = (args && args[0]);
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      await gitExt?.activate();
      const api = gitExt?.exports?.getAPI(1);
      let repo;
      const activePath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
      if (activePath && api?.repositories?.length) {
        const sorted = api.repositories.slice().sort((a,b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
        const byActive = sorted.find(r => activePath.startsWith(r.rootUri.fsPath));
        if (byActive) repo = byActive;
      }
      if (!repo) repo = repoArg && repoArg.rootUri ? repoArg : (api?.repositories?.find(r => r.ui?.selected) || api?.repositories?.[0]);
      if (!repo) return vscode.window.showErrorMessage('No Git repository found.');

      try {
        const cfg = vscode.workspace.getConfiguration('openaiSmartCommit');
        const autoStage = cfg.get('autoStage');
        if (autoStage === 'all') {
          sh('git add -A', repo.rootUri.fsPath);
          vscode.window.setStatusBarMessage('Staged all changes', 1200);
        } else if (autoStage === 'new') {
          const untrackedZ = sh('git ls-files --others --exclude-standard -z', repo.rootUri.fsPath);
          if (untrackedZ) {
            const arr = untrackedZ.split('\0').filter(Boolean).slice(0, 200);
            while (arr.length) {
              const chunk = arr.splice(0, 50).map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
              sh(`git add -- ${chunk}`, repo.rootUri.fsPath);
            }
            vscode.window.setStatusBarMessage('Staged new files', 1200);
          }
        }
      } catch {}

      // Pick Jira issue first (always show a small pre-picker to avoid silent skips)
      let selectedKey = null;
      try {
        const cfg2 = vscode.workspace.getConfiguration('openaiSmartCommit');
        if (cfg2.get('issuePicker')) {
          selectedKey = await pickJiraIssue({
            jiraBase: cfg2.get('jira.baseUrl'),
            jiraTokenSetting: cfg2.get('jira.apiToken'),
            jql: cfg2.get('jira.jql'),
            maxResults: cfg2.get('jira.maxIssues'),
          });
        }
      } catch (e) { /* ignore */ }

      await generate(repo, selectedKey);
      vscode.window.setStatusBarMessage('Smart commit generated', 2000);
    } catch (e) {
      vscode.window.showErrorMessage(`Smart commit failed: ${e.message}`);
    }
  });
  context.subscriptions.push(disposable);

  // Store Jira token in SecretStorage
  const setTok = vscode.commands.registerCommand('openaiSmartCommit.setJiraToken', async () => {
    try {
      const token = await vscode.window.showInputBox({ prompt: 'Enter Jira API token', password: true, ignoreFocusOut: true });
      if (!token) return;
      await context.secrets.store('openaiSmartCommit.jira.token', token);
      vscode.window.showInformationMessage('Jira API token stored securely.');
    } catch (e) {
      vscode.window.showErrorMessage('Failed to store Jira token');
    }
  });
  context.subscriptions.push(setTok);
}

function deactivate() {}

module.exports = { activate, deactivate };

// ---- Jira Picker ----
async function pickJiraIssue({ jiraBase, jiraTokenSetting, jql, maxResults }) {
  const cfg = vscode.workspace.getConfiguration('openaiSmartCommit');
  const tokenFromSecret = await getSecret('openaiSmartCommit.jira.token');
  const token = jiraTokenSetting || tokenFromSecret || process.env.JIRA_API_TOKEN || '';
  if (!jiraBase || !token) return await manualIssueKey();

  const headers = { 'Content-Type': 'application/json' };
  // Auth: prefer Basic username:token (Server/DC), otherwise Bearer PAT
  headers.Authorization = 'Bearer ' + token;
  // Prefer GET for Server/DC compatibility
  const encJql = encodeURIComponent(jql || 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
  const max = Math.min(Number(maxResults || 50), 100);
  async function callGET(path) {
    const base = jiraBase.replace(/\/$/, '');
    const url = `${base}${path}?jql=${encJql}&maxResults=${max}&fields=summary,key`;
    return await new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? require('https') : require('http');
      const req = mod.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers }, (r) => {
        let data = '';
        r.on('data', (d) => (data += d));
        r.on('end', () => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else { reject(new Error(`Jira HTTP ${r.statusCode}`)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  let data;
  try { data = await callGET('/rest/api/2/search'); }
  catch { try { data = await callGET('/rest/api/3/search'); } catch (e) { return await manualIssueKey(); } }

  const items = (data.issues || []).map((it) => ({ key: it.key, summary: it.fields?.summary || '' }));
  const picks = items.map((it) => ({ label: it.key, description: it.summary }));
  picks.unshift({ label: '$(refresh) Refresh', description: 'Reload issues' });
  picks.push({ label: '$(edit) Enter key…', description: 'Manually type issue key' });
  picks.push({ label: '$(circle-slash) Skip', description: 'Do not set issue key' });

  while (true) {
    const sel = await vscode.window.showQuickPick(picks, { placeHolder: 'Select Jira issue', ignoreFocusOut: true });
    if (!sel) return null;
    if (sel.label.startsWith('$(refresh)')) { try { return await pickJiraIssue({ jiraBase, jiraTokenSetting, jql, maxResults }); } catch { return null; } }
    if (sel.label.startsWith('$(circle-slash)')) return null;
    if (sel.label.startsWith('$(edit)')) return await manualIssueKey();
    return sel.label; // key
  }
}

async function manualIssueKey() {
  const key = await vscode.window.showInputBox({ prompt: 'Enter Jira issue key (e.g., PROJ-123)', placeHolder: 'KEY-123', ignoreFocusOut: true });
  return key || null;
}

async function getSecret(name) {
  try {
    const ctx = gctx;
    if (ctx?.secrets) return await ctx.secrets.get(name);
    return null;
  } catch { return null; }
}

async function getJiraSummarySafe(baseUrl, tokenSetting, key) {
  try {
    if (!baseUrl || !tokenSetting || !key) return '';
    const base = baseUrl.replace(/\/$/, '');
    const path = `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary`;
    const url = new URL(base + path);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const headers = { 'Authorization': 'Bearer ' + tokenSetting };
    const res = await new Promise((resolve, reject) => {
      const req = mod.request({ method: 'GET', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, headers }, (r) => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    if (res.status >= 200 && res.status < 300) {
      const json = JSON.parse(res.body);
      return json?.fields?.summary || '';
    }
    return '';
  } catch { return ''; }
}

// ---- Time estimation helpers ----
function detectType(files) {
  const f = (files || []).map(s => s.toLowerCase());
  const has = (pred) => f.some(pred);
  if (has(p => p.startsWith('.github/') || p.includes('/.github/workflows/') || p.endsWith('.gitlab-ci.yml') || p.includes('jenkinsfile') || p.endsWith('azure-pipelines.yml'))) return 'ci';
  if (has(p => p.startsWith('infra/') || p.startsWith('terraform/') || p.endsWith('.tf') || p.endsWith('.hcl') || p.startsWith('ansible/') || p.startsWith('k8s/') || p.startsWith('helm/') || p.endsWith('dockerfile') || p.endsWith('.dockerignore'))) return 'infra';
  if (has(p => p.startsWith('docs/') || p.endsWith('.md') || p.endsWith('.adoc') || p.startsWith('changelog'))) return 'docs';
  if (has(p => p.includes('/__tests__/') || p.startsWith('tests/') || p.includes('.test.') || p.includes('.spec.'))) return 'test';
  if (has(p => p.includes('/perf/') || p.includes('benchmark'))) return 'perf';
  if (has(p => p.includes('package.json') || p.includes('requirements.txt') || p.includes('pom.xml'))) return 'build';
  return 'chore';
}

function estimateTimeMinutes(diff, files) {
  if (!diff) return 15;
  const lines = diff.split('\n');
  let changed = 0;
  for (const ln of lines) {
    if (ln.startsWith('+++') || ln.startsWith('---')) continue;
    if (ln.startsWith('+') || ln.startsWith('-')) changed++;
  }
  let base;
  if (changed <= 20) base = 15;
  else if (changed <= 50) base = 30;
  else if (changed <= 100) base = 45;
  else if (changed <= 200) base = 60;
  else if (changed <= 400) base = 120;
  else base = 240; // will be multiplied and then capped to 8h

  const t = detectType(files);
  const multMap = { ci: 0.8, docs: 0.8, test: 0.8, fix: 1.0, refactor: 1.1, infra: 1.2, feat: 1.5, chore: 0.9 };
  const mult = multMap[t] || 1.0;
  let minutes = Math.round((base * mult) / 15) * 15;
  if (minutes < 15) minutes = 15;
  if (minutes > 480) minutes = 480; // cap 8h
  return minutes;
}

function formatMinutes(mins) {
  if (mins % 60 === 0) return (mins / 60) + 'h';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function ensureCommentDetail(text, files, diff, minWords) {
  const count = (text.trim().match(/\S+/g) || []).length;
  if (count >= minWords) return text;
  // Не перечисляем файлы/окружения; добавляем общие подробности по мотивации/влиянию
  const changes = (diff || '').split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
  const hints = [];
  if (changes > 0) hints.push('пояснены причины и ожидаемый эффект');
  if (changes > 100) hints.push('затронуты значимые части конфигурации');
  const extra = hints.length ? ' — ' + hints.join('; ') : '';
  return (text && text.length ? text : 'Расширенный комментарий по изменениям') + extra;
}
