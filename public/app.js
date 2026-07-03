/* ============================================================
   Claude Code transcript viewer — client logic.
   Parses a .jsonl session transcript and renders it in the
   Claude Code TUI style (bullets, tool calls, diffs, thinking).
   ============================================================ */

'use strict';

/* ------------------------- tiny helpers ------------------------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const basename = (p) => (typeof p === 'string' ? p.split('/').pop() : p);

// Strip ANSI/VT escape sequences (color codes etc.) from captured terminal output.
const ANSI_RE = /[\x1b\x9b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g;
// Also drop carriage returns and stray C0/C1 control bytes (keep \n and \t).
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const stripAnsi = (s) => (typeof s === 'string' ? s.replace(ANSI_RE, '').replace(CTRL_RE, '') : s);

/* ------------------------- markdown ------------------------- */
// Compact, safe markdown -> HTML. Source is escaped before any
// formatting so transcript text can never inject markup.
function renderInline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return 'C' + (codes.length - 1) + '';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, t, u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])__([^_\n]+?)__(?![_\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/C(\d+)/g, (_m, i) => `<code>${codes[+i]}</code>`);
  return s;
}

function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // blank
    if (/^\s*$/.test(line)) { i++; continue; }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${renderInline(escapeHtml(h[2]))}</h${h[1].length}>`); i++; continue; }
    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
    // blockquote (group consecutive)
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    // table (header | --- | rows)
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = splitRow(lines[i]); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(splitRow(lines[i++]));
      let t = '<table><thead><tr>' + head.map((c) => `<th>${renderInline(escapeHtml(c))}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of body) t += '<tr>' + r.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('') + '</tr>';
      out.push(t + '</tbody></table>');
      continue;
    }
    // unordered / ordered list (group)
    if (/^\s*([-*+]\s+|\d+[.)]\s+)/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]\s+|\d+[.)]\s+)/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('') + `</${tag}>`);
      continue;
    }
    // paragraph (group until blank / special)
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
           !/^\s*\|.*\|\s*$/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${renderInline(escapeHtml(buf.join('\n')))}</p>`);
  }
  return out.join('\n');
}

/* ------------------------- expand/clamp ------------------------- */
function makeExpandable(container, pre, fullText, opts = {}) {
  const lineCount = fullText.split('\n').length;
  const limit = opts.lines || 8;
  if (lineCount <= limit && fullText.length < 700) return; // no need
  pre.classList.add('clamped');
  const toggle = el('div', 'expand-toggle');
  const hidden = lineCount - limit;
  const collapsedLabel = hidden > 0 ? `… +${hidden} lines (click to expand)` : '… show more';
  // Drive the label from the DOM (the `clamped` class) so it stays correct even
  // when something else expands the block — e.g. search auto-unfold.
  const sync = () => { toggle.textContent = pre.classList.contains('clamped') ? collapsedLabel : 'show less'; };
  pre._syncExpand = sync;
  sync();
  toggle.addEventListener('click', () => { pre.classList.toggle('clamped'); sync(); });
  container.appendChild(toggle);
}

/* connector row: the ⎿ elbow + a body element */
function connector(bodyEl, errored) {
  const wrap = el('div', 'connector' + (errored ? ' result-error' : ''));
  wrap.appendChild(el('span', 'elbow', '⎿'));
  const cb = el('div', 'cbody');
  cb.appendChild(bodyEl);
  wrap.appendChild(cb);
  return wrap;
}

/* ------------------------- tool rendering ------------------------- */
// Returns {nameHtml, argHtml} for the ⏺ tool head line.
function toolHead(name, input) {
  input = input || {};
  const arg = (v) => `<span class="tool-args">${escapeHtml(v)}</span>`;
  switch (name) {
    case 'Bash':
      // show the full command (multi-line preserved via .tool-args white-space)
      return { label: 'Bash', arg: arg(input.command || ''), sub: input.description || '' };
    case 'Read': return { label: 'Read', arg: arg(basename(input.file_path) || '') };
    case 'Edit': return { label: 'Edit', arg: arg(basename(input.file_path) || '') };
    case 'MultiEdit': return { label: 'MultiEdit', arg: arg(basename(input.file_path) || '') };
    case 'Write': return { label: 'Write', arg: arg(basename(input.file_path) || '') };
    case 'TodoWrite': return { label: 'Update Todos', arg: '' };
    case 'Glob': return { label: 'Glob', arg: arg(input.pattern || '') };
    case 'Grep': return { label: 'Grep', arg: arg(input.pattern || '') };
    case 'Task':
    case 'Agent': return { label: name, arg: arg(input.description || input.subagent_type || ''), sub: input.prompt || '' };
    case 'WebFetch': return { label: 'WebFetch', arg: arg(input.url || '') };
    case 'WebSearch': return { label: 'WebSearch', arg: arg(input.query || '') };
    case 'Skill': return { label: 'Skill', arg: arg(input.skill || input.command || '') };
    case 'AskUserQuestion': return { label: 'AskUserQuestion', arg: '' };
    default: {
      // generic: pick a representative primary field
      const keys = ['name', 'path', 'file_path', 'query', 'pattern', 'url', 'command', 'prompt', 'description', 'title'];
      let primary = '';
      for (const k of keys) if (input[k]) { primary = String(input[k]).split('\n')[0]; break; }
      const pretty = name.startsWith('mcp__') ? name.replace(/^mcp__/, '').replace(/__/g, ':') : name;
      return { label: pretty, arg: primary ? arg(primary) : '' };
    }
  }
}

function renderTodos(input) {
  const wrap = el('div');
  const todos = (input && input.todos) || [];
  for (const t of todos) {
    const status = t.status || 'pending';
    const row = el('div', 'todo ' + status);
    const box = status === 'completed' ? '☒' : '☐';
    const label = status === 'in_progress' ? (t.activeForm || t.content) : t.content;
    row.classList.toggle('done', status === 'completed');
    const b = el('span', 'box', box + ' ');
    const l = el('span', 'label', label || '');
    row.appendChild(b); row.appendChild(l);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderDiff(structuredPatch) {
  const wrap = el('div', 'diff');
  let adds = 0, dels = 0;
  for (const hunk of structuredPatch) {
    const hh = el('div', 'diff-hunk', `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    wrap.appendChild(hh);
    let oldN = hunk.oldStart, newN = hunk.newStart;
    for (const raw of hunk.lines) {
      const sign = raw[0];
      const text = raw.slice(1);
      const line = el('div', 'diff-line');
      const gut = el('span', 'diff-gutter');
      const sg = el('span', 'diff-sign');
      const tx = el('span', 'diff-text');
      tx.textContent = text;
      if (sign === '+') { line.classList.add('add'); sg.textContent = '+'; gut.textContent = String(newN++); adds++; }
      else if (sign === '-') { line.classList.add('del'); sg.textContent = '-'; gut.textContent = String(oldN++); dels++; }
      else { line.classList.add('ctx'); sg.textContent = ' '; gut.textContent = String(newN++); oldN++; }
      line.appendChild(gut); line.appendChild(sg); line.appendChild(tx);
      wrap.appendChild(line);
    }
  }
  return { node: wrap, adds, dels };
}

// Build the result connector(s) under a tool call.
function renderToolResult(name, input, result) {
  const frag = document.createDocumentFragment();
  const tur = result && result.toolUseResult;

  // Edit / Write -> diff view
  if ((name === 'Edit' || name === 'MultiEdit' || name === 'Write') && tur && Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) {
    const { node, adds, dels } = renderDiff(tur.structuredPatch);
    const summary = el('div', 'diff-summary',
      `Updated ${basename(tur.filePath || input.file_path || '')} with ${adds} addition${adds !== 1 ? 's' : ''} and ${dels} removal${dels !== 1 ? 's' : ''}`);
    const cb = el('div');
    cb.appendChild(summary);
    cb.appendChild(node);
    frag.appendChild(connector(cb, false));
    return frag;
  }

  // TodoWrite -> checklist
  if (name === 'TodoWrite') {
    frag.appendChild(connector(renderTodos(input), false));
    return frag;
  }

  // Generic text result
  const text = stripAnsi(resultText(result));
  const errored = isErrorResult(result);
  if (text === '' && !errored) {
    // no captured output
    const note = el('div', 'result-pre', '(no output)');
    note.style.color = 'var(--text-fainter)';
    frag.appendChild(connector(note, false));
    return frag;
  }

  // Read -> show a compact summary line + expandable content
  const cb = el('div');
  if (name === 'Read' && !errored) {
    const nLines = text.split('\n').length;
    const sum = el('div', 'result-pre', `Read ${nLines} line${nLines !== 1 ? 's' : ''}`);
    cb.appendChild(sum);
  } else {
    const pre = el('pre', 'result-pre');
    pre.textContent = text;
    cb.appendChild(pre);
    makeExpandable(cb, pre, text, { lines: errored ? 30 : 8 });
  }
  frag.appendChild(connector(cb, errored));
  return frag;
}

function resultText(result) {
  if (!result) return '';
  const block = result.block;
  if (block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((b) => (b && typeof b === 'object'
        ? (b.type === 'text' ? b.text : (b.type === 'tool_reference' ? '' : JSON.stringify(b)))
        : String(b))).join('');
    }
  }
  const tur = result.toolUseResult;
  if (typeof tur === 'string') return tur;
  if (tur && typeof tur === 'object') {
    if (typeof tur.stdout === 'string' || typeof tur.stderr === 'string') {
      return [tur.stdout, tur.stderr].filter(Boolean).join('\n');
    }
    if (typeof tur.content === 'string') return tur.content;
  }
  return '';
}

function isErrorResult(result) {
  if (!result) return false;
  if (result.block && result.block.is_error) return true;
  const tur = result.toolUseResult;
  if (typeof tur === 'string' && /^Error\b/i.test(tur)) return true;
  if (tur && tur.interrupted) return true;
  return false;
}

/* ------------------------- transcript model ------------------------- */
const META_TYPES = new Set([
  'ai-title', 'agent-name', 'mode', 'permission-mode', 'custom-title',
  'last-prompt', 'file-history-snapshot', 'summary',
]);

function parseJsonl(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch (_) { /* skip malformed */ }
  }
  return entries;
}

// Map tool_use_id -> {block, toolUseResult}; mark which entries are pure result carriers.
function indexResults(entries) {
  const byId = new Map();
  const carrier = new Set();
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    let onlyResults = content.length > 0;
    for (const b of content) {
      if (b && b.type === 'tool_result') {
        byId.set(b.tool_use_id, { block: b, toolUseResult: e.toolUseResult });
      } else {
        onlyResults = false;
      }
    }
    if (onlyResults) carrier.add(e);
  }
  return { byId, carrier };
}

function sessionMeta(entries) {
  const meta = {};
  for (const e of entries) {
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.gitBranch && !meta.gitBranch) meta.gitBranch = e.gitBranch;
    if (e.version && !meta.version) meta.version = e.version;
    if (e.type === 'assistant' && e.message && e.message.model && !meta.model) meta.model = e.message.model;
    if (e.type === 'ai-title' && e.aiTitle && !meta.title) meta.title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) meta.title = e.customTitle;
    if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
  }
  return meta;
}

// Detect harness-injected text that should render compactly rather than as a
// normal user prompt: skill content (folded) and background task notifications.
function classifySpecialText(t) {
  if (/<task-notification>/.test(t)) return 'notification';
  if (/^Base directory for this skill:/.test(t.trimStart())) return 'skill-content';
  if (/^This session is being continued from a previous conversation/.test(t.trimStart())) return 'continuation';
  return null;
}

/* Parse a user string-content message into a structured kind. */
function classifyUserString(s) {
  const special = classifySpecialText(s);
  if (special === 'notification') return { kind: 'notification', text: s.trim() };
  if (special === 'skill-content') return { kind: 'skill-content', text: s };
  if (special === 'continuation') return { kind: 'continuation', text: s };
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [, ''])[1].trim();
    return { kind: 'command', name: cmd[1].trim().replace(/^\/+/, ''), args };
  }
  const stdout = s.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdout) return { kind: 'command-output', text: stripAnsi(stdout[1].trim()) };
  const bashIn = s.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bashIn) return { kind: 'bash-input', text: bashIn[1].trim() };
  const bashOut = s.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  if (bashOut) return { kind: 'command-output', text: stripAnsi(bashOut[1].trim()) };
  // meta-ish wrappers we should not show as a prompt
  if (/^<(local-command-caveat|command-message|system-reminder)/.test(s.trim())) return { kind: 'skip' };
  return { kind: 'prompt', text: s };
}

// Build a flat list of render items from the entry list.
function buildItems(entries) {
  const { byId, carrier } = indexResults(entries);
  const items = [];
  items.push({ kind: 'session', meta: sessionMeta(entries) });

  for (const e of entries) {
    if (META_TYPES.has(e.type)) continue;
    if (e.type === 'attachment') continue;
    const side = !!e.isSidechain;

    if (e.type === 'system') {
      const c = e.content;
      if (!c || e.subtype === 'turn_duration') continue;
      items.push({ kind: 'system', text: String(c), side });
      continue;
    }

    if (e.type === 'user') {
      if (carrier.has(e)) continue; // rendered under its tool call
      const content = e.message && e.message.content;
      if (typeof content === 'string') {
        const c = classifyUserString(content);
        if (c.kind === 'skip') continue;
        if (c.kind === 'command') items.push({ kind: 'user-command', name: c.name, args: c.args, side });
        else if (c.kind === 'command-output') items.push({ kind: 'command-output', text: c.text, side });
        else if (c.kind === 'bash-input') items.push({ kind: 'bash-input', text: c.text, side });
        else if (c.kind === 'notification') items.push({ kind: 'notification', text: c.text, side });
        else if (c.kind === 'skill-content') items.push({ kind: 'skill-content', text: c.text, side });
        else if (c.kind === 'continuation') items.push({ kind: 'continuation', text: c.text, side });
        else if (e.isMeta) continue;
        else items.push({ kind: 'user-prompt', text: c.text, side });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') {
            const t = (b.text || '').trim();
            if (!t) continue;
            const special = classifySpecialText(t);
            if (special === 'notification') items.push({ kind: 'notification', text: t, side });
            else if (special === 'skill-content') items.push({ kind: 'skill-content', text: b.text, side });
            else if (special === 'continuation') items.push({ kind: 'continuation', text: b.text, side });
            else if (/^\[Request interrupted/i.test(t)) items.push({ kind: 'interrupted', text: t, side });
            else items.push({ kind: 'user-prompt', text: b.text, side });
          } else if (b.type === 'image') {
            items.push({ kind: 'image', src: imageSrc(b), side });
          } else if (b.type === 'tool_result') {
            // orphan tool_result (no matching tool_use rendered) — show raw
            items.push({ kind: 'orphan-result', block: b, toolUseResult: e.toolUseResult, side });
          }
        }
      }
      continue;
    }

    if (e.type === 'assistant') {
      const content = (e.message && e.message.content) || [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          if ((b.text || '').trim()) items.push({ kind: 'assistant-text', text: b.text, side });
        } else if (b.type === 'thinking') {
          if ((b.thinking || '').trim()) items.push({ kind: 'thinking', text: b.thinking, side });
        } else if (b.type === 'tool_use') {
          items.push({ kind: 'tool', name: b.name, input: b.input, result: byId.get(b.id), side });
        }
      }
      continue;
    }
  }
  return items;
}

function imageSrc(b) {
  const src = b.source || {};
  if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
  if (src.type === 'url' && src.url) return src.url;
  return '';
}

/* ------------------------- DOM builders for items ------------------------- */
function row(bulletChar, bulletCls, bodyEl, rowCls) {
  const r = el('div', 'row ' + (rowCls || ''));
  r.appendChild(el('span', 'bullet ' + (bulletCls || ''), bulletChar));
  const body = el('div', 'body');
  if (bodyEl) body.appendChild(bodyEl);
  r.appendChild(body);
  return { row: r, body };
}

function buildSession(meta) {
  const box = el('div', 'session-box');
  const title = el('div', 'session-title');
  title.innerHTML = `<span class="spark">✻</span>Welcome to Claude Code Transcript Viewer`;
  box.appendChild(title);
  const grid = el('div', 'session-meta');
  const add = (k, v, vcls) => {
    if (!v) return;
    grid.appendChild(el('span', 'k', k));
    grid.appendChild(el('span', 'v ' + (vcls || ''), v));
  };
  if (meta.title) add('session', meta.title);
  add('cwd', meta.cwd);
  add('git', meta.gitBranch, 'branch');
  add('model', meta.model, 'model');
  add('version', meta.version);
  box.appendChild(grid);
  return box;
}

// A reusable disclosure: clickable header with a chevron toggling a body node.
function foldable(labelText, bodyNode, opts = {}) {
  const wrap = el('div');
  const head = el('div', 'fold-head');
  const chev = el('span', 'chev', opts.open ? '▾' : '▸');
  head.appendChild(chev);
  head.appendChild(document.createTextNode(' ' + labelText));
  bodyNode.classList.add('fold-body');
  bodyNode.style.display = opts.open ? '' : 'none';
  head.addEventListener('click', () => {
    const show = bodyNode.style.display === 'none';
    bodyNode.style.display = show ? '' : 'none';
    chev.textContent = show ? '▾' : '▸';
  });
  wrap.appendChild(head);
  wrap.appendChild(bodyNode);
  return wrap;
}

function buildItemNode(item) {
  let node;
  switch (item.kind) {
    case 'session': node = buildSession(item.meta); break;

    case 'skill-content': {
      const m = item.text.match(/Base directory for this skill:\s*(\S+)/);
      const skill = m ? m[1].split('/').pop() : 'skill';
      const lines = item.text.split('\n').length;
      const md = el('div', 'md');
      md.innerHTML = mdToHtml(item.text);
      const fold = foldable(`Skill content · ${skill} (${lines} lines)`, md, { open: false });
      node = row('', '', fold, 'msg-skill').row;
      break;
    }

    case 'continuation': {
      const lines = item.text.split('\n').length;
      const md = el('div', 'md');
      md.innerHTML = mdToHtml(item.text);
      const fold = foldable(`Session continued — summary of earlier conversation (${lines} lines)`, md, { open: false });
      node = row('', '', fold, 'msg-continuation').row;
      break;
    }

    case 'notification': {
      const status = (item.text.match(/<status>([\s\S]*?)<\/status>/) || [, ''])[1].trim();
      const summary = (item.text.match(/<summary>([\s\S]*?)<\/summary>/) || [, ''])[1].trim();
      const label = `Background task ${status || 'event'}${summary ? ' — ' + summary : ''}`;
      const pre = el('pre', 'result-pre');
      pre.textContent = item.text.trim();
      const fold = foldable(label, pre, { open: false });
      node = row('◔', '', fold, 'msg-notification').row;
      break;
    }

    case 'user-prompt': {
      const body = el('div');
      const caret = el('span', 'caret', '> ');
      const text = el('span', 'utext');
      text.textContent = item.text;
      body.appendChild(caret); body.appendChild(text);
      node = row('', '', body, 'msg-user').row;
      break;
    }
    case 'user-command': {
      const body = el('div');
      body.innerHTML = `<span class="caret">&gt; </span><span class="slash-cmd">/${escapeHtml(item.name)}${item.args ? ' ' + escapeHtml(item.args) : ''}</span>`;
      node = row('', '', body, 'msg-user command').row;
      break;
    }
    case 'bash-input': {
      const body = el('div');
      body.innerHTML = `<span class="caret">! </span><span class="slash-cmd">${escapeHtml(item.text)}</span>`;
      node = row('', '', body, 'msg-user command').row;
      break;
    }
    case 'command-output': {
      const pre = el('pre', 'result-pre');
      pre.textContent = item.text;
      const r = row('⏺', '', null, 'msg-tool');
      r.body.appendChild(connector(pre, false));
      node = r.row;
      break;
    }
    case 'interrupted': {
      const b = el('div', 'interrupted', item.text);
      node = row('', '', b, 'msg-system').row;
      break;
    }
    case 'image': {
      const r = row('⏺', '', null, 'msg-user');
      if (item.src) { const img = el('img', 'tool-image'); img.src = item.src; r.body.appendChild(img); }
      else r.body.appendChild(el('span', 'tool-sub', '[image]'));
      node = r.row;
      break;
    }

    case 'assistant-text': {
      const md = el('div', 'md');
      md.innerHTML = mdToHtml(item.text);
      node = row('⏺', '', md, 'msg-assistant').row;
      break;
    }

    case 'thinking': {
      const r = row('✻', '', null, 'msg-thinking');
      const head = el('div', 'thinking-head');
      head.innerHTML = `<span class="chev">▸</span>Thinking…`;
      const bodyT = el('div', 'thinking-body');
      bodyT.textContent = item.text;
      bodyT.style.display = 'none';
      head.addEventListener('click', () => {
        const open = bodyT.style.display === 'none';
        bodyT.style.display = open ? '' : 'none';
        head.querySelector('.chev').textContent = open ? '▾' : '▸';
      });
      r.body.appendChild(head);
      r.body.appendChild(bodyT);
      node = r.row;
      break;
    }

    case 'tool': {
      const head = el('div', 'tool-head');
      const th = toolHead(item.name, item.input);
      head.innerHTML = `<span class="tool-name">${escapeHtml(th.label)}</span>` +
        (th.arg ? `(${th.arg})` : '');
      const r = row('⏺', '', null, 'msg-tool');
      r.body.appendChild(head);
      if (th.sub) {
        const sub = el('div', 'tool-sub');
        sub.textContent = th.sub.split('\n')[0].slice(0, 200);
        r.body.appendChild(sub);
      }
      r.body.appendChild(renderToolResult(item.name, item.input || {}, item.result));
      node = r.row;
      break;
    }

    case 'orphan-result': {
      const pre = el('pre', 'result-pre');
      pre.textContent = stripAnsi(resultText({ block: item.block, toolUseResult: item.toolUseResult }));
      const r = row('⏺', '', null, 'msg-tool');
      r.body.appendChild(connector(pre, !!item.block.is_error));
      node = r.row;
      break;
    }

    case 'system': {
      const b = el('div');
      b.textContent = item.text.split('\n')[0].slice(0, 300);
      node = row('⏵', '', b, 'msg-system').row;
      break;
    }

    default:
      node = el('div');
  }
  if (item.side && node.classList) {
    const wrap = el('div', 'sidechain');
    wrap.appendChild(node);
    return wrap;
  }
  return node;
}

/* ------------------------- incremental render ------------------------- */
// Render this many rows per batch; overridable via ?batch=N for testing huge files.
const BATCH = Number(new URLSearchParams(location.search).get('batch')) || 600;
let ITEMS = [];
let cursor = 0;              // position in the current view, not an item index
let VIEW = null;             // array of item indices to render (selective filter), or null = all
let VIEW_SET = null;         // Set of the same indices for O(1) membership tests
const viewLength = () => (VIEW ? VIEW.length : ITEMS.length);

function renderBatch() {
  const tx = $('#transcript');
  const frag = document.createDocumentFragment();
  const end = Math.min(cursor + BATCH, viewLength());
  for (; cursor < end; cursor++) {
    const idx = VIEW ? VIEW[cursor] : cursor;
    const node = buildItemNode(ITEMS[idx]);
    if (node && node.dataset) {
      node.dataset.item = String(idx); // ORIGINAL item index — stable across filtered views
      if (sel.mode === 'select') injectCheckbox(node);
    }
    frag.appendChild(node);
  }
  tx.appendChild(frag);
  const bar = $('#loadMoreBar');
  if (cursor < viewLength()) {
    bar.hidden = false;
    $('#loadMoreBtn').textContent = `Load more — ${viewLength() - cursor} items remaining`;
  } else {
    bar.hidden = true;
  }
}

// Re-render the transcript restricted to `indices` (null = all items).
function setView(indices) {
  VIEW = indices;
  VIEW_SET = indices ? new Set(indices) : null;
  cursor = 0;
  $('#transcript').innerHTML = '';
  closeSearch();
  renderBatch();
  buildSidebar();
  $('#view').scrollTop = 0;
  updateSidebarActive(); // highlight the first visible prompt
}

function showTranscript(entries) {
  ITEMS = buildItems(entries);
  resetSelection();
  $('#landing').hidden = true;
  $('#view').hidden = false;
  $('#reloadBtn').hidden = false;
  $('#searchBtn').hidden = false;
  $('#selectBtn').hidden = false;
  setView(null);
}

/* ------------------------- selective mode ------------------------- */
// normal: plain view · select: a checkbox before each item · filtered: only the
// checked items are rendered (checkboxes hidden). The checked set survives mode
// switches so a filter can be edited and re-applied.
const sel = { mode: 'normal', checked: new Set() };

function setItemChecked(node, box, on) {
  box.checked = on;
  const idx = Number(node.dataset.item);
  if (on) sel.checked.add(idx); else sel.checked.delete(idx);
  node.classList.toggle('sel-selected', on);
  updateSelBar();
}

function injectCheckbox(node) {
  if (node.querySelector(':scope > .sel-check')) return;
  const box = el('input', 'sel-check');
  box.type = 'checkbox';
  box.checked = sel.checked.has(Number(node.dataset.item));
  box.title = 'Select this item';
  node.classList.toggle('sel-selected', box.checked);
  box.addEventListener('change', () => setItemChecked(node, box, box.checked));
  node.prepend(box);
}

// Push the checked set back into every rendered checkbox (after all/none).
function syncCheckboxes() {
  document.querySelectorAll('#transcript .sel-check').forEach((box) => {
    const idx = Number(box.parentNode.dataset.item);
    box.checked = sel.checked.has(idx);
    box.parentNode.classList.toggle('sel-selected', box.checked);
  });
}

function updateSelBar() {
  const n = sel.checked.size;
  $('#selCount').textContent = sel.mode === 'filtered'
    ? `showing ${n} of ${ITEMS.length} items` : `${n} selected`;
  const picking = sel.mode === 'select';
  $('#selAll').hidden = !picking;
  $('#selNone').hidden = !picking;
  $('#selApply').hidden = !picking;
  $('#selApply').disabled = n === 0;
  $('#selEdit').hidden = sel.mode !== 'filtered';
}

function enterSelectMode() {
  if (sel.mode === 'filtered') setView(null); // show everything again for picking
  sel.mode = 'select';
  document.body.classList.add('select-mode');
  document.body.classList.remove('filtered-mode');
  document.querySelectorAll('#transcript [data-item]').forEach(injectCheckbox);
  $('#selectBar').hidden = false;
  updateSelBar();
}

function applySelection() {
  if (!sel.checked.size) return;
  sel.mode = 'filtered';
  document.body.classList.remove('select-mode');
  document.body.classList.add('filtered-mode');
  setView([...sel.checked].sort((a, b) => a - b));
  updateSelBar();
}

function exitSelectMode() { // back to the normal full view
  sel.mode = 'normal';
  document.body.classList.remove('select-mode', 'filtered-mode');
  $('#selectBar').hidden = true;
  if (VIEW) setView(null);
}

function resetSelection() {
  sel.mode = 'normal';
  sel.checked.clear();
  document.body.classList.remove('select-mode', 'filtered-mode');
  $('#selectBar').hidden = true;
  VIEW = null; VIEW_SET = null;
}

/* ------------------------- left sidebar (prompt index) ------------------------- */
let promptEntries = []; // [{ itemIndex, el }]
let sidebarActive = -1;

function buildSidebar() {
  const list = $('#sidebarList');
  list.innerHTML = '';
  promptEntries = [];
  sidebarActive = -1;
  for (let idx = 0; idx < ITEMS.length; idx++) {
    if (ITEMS[idx].kind !== 'user-prompt') continue; // only the user's own typed prompts
    if (VIEW_SET && !VIEW_SET.has(idx)) continue;    // hidden by the selective filter
    const preview = (ITEMS[idx].text || '').split('\n').map((s) => s.trim()).find(Boolean) || '(empty)';
    const btn = el('button', 'sidebar-item', preview);
    btn.dataset.target = String(idx);
    btn.title = preview;
    btn.addEventListener('click', () => jumpToPrompt(idx));
    list.appendChild(btn);
    promptEntries.push({ itemIndex: idx, el: btn });
  }
  if (!promptEntries.length) {
    list.appendChild(el('div', 'sidebar-empty', 'No user prompts'));
  }
  document.body.classList.add('has-sidebar');
  document.body.classList.remove('sidebar-collapsed'); // open on each new transcript
  $('#sidebarToggle').textContent = '◀';
  $('#sidebar').hidden = false;
  $('#sidebarToggle').hidden = false;
}

function jumpToPrompt(itemIndex) {
  ensureRendered(itemIndex);
  const node = $('#transcript').querySelector(`[data-item="${itemIndex}"]`);
  if (node) node.scrollIntoView({ block: 'start' });
  setSidebarActive(itemIndex);
}

// Keep the active entry inside the middle 80% of the sidebar (>=10% from each edge).
function scrollSidebarEntryIntoView(el) {
  const list = $('#sidebarList');
  const lr = list.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const margin = lr.height * 0.1;
  if (er.top < lr.top + margin) list.scrollTop -= (lr.top + margin) - er.top;
  else if (er.bottom > lr.bottom - margin) list.scrollTop += er.bottom - (lr.bottom - margin);
}

function setSidebarActive(itemIndex) {
  if (itemIndex === sidebarActive) return;
  sidebarActive = itemIndex;
  let activeEl = null;
  for (const p of promptEntries) {
    const on = p.itemIndex === itemIndex;
    p.el.classList.toggle('active', on);
    if (on) activeEl = p.el;
  }
  if (activeEl) scrollSidebarEntryIntoView(activeEl);
}

// On scroll, highlight the prompt that is current or immediately above the viewport top.
function updateSidebarActive() {
  if (!promptEntries.length) return;
  const tx = $('#transcript');
  const vTop = $('#view').getBoundingClientRect().top;
  let current = promptEntries[0].itemIndex;
  for (const p of promptEntries) {
    const node = tx.querySelector(`[data-item="${p.itemIndex}"]`);
    if (!node) continue;
    const top = node.getBoundingClientRect().top - vTop;
    if (top <= 100) current = p.itemIndex; else break;
  }
  setSidebarActive(current);
}

/* ------------------------- search ------------------------- */
// Plain-text content of an item, used to find matches across the whole
// transcript (including not-yet-rendered batches).
function itemText(item) {
  switch (item.kind) {
    case 'session': { const m = item.meta || {}; return [m.title, m.cwd, m.gitBranch, m.model, m.version].filter(Boolean).join(' '); }
    case 'user-command': return '/' + (item.name || '') + ' ' + (item.args || '');
    case 'tool': {
      const i = item.input || {};
      const parts = [item.name];
      for (const k of ['command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill']) if (i[k]) parts.push(String(i[k]));
      if (item.name === 'TodoWrite' && Array.isArray(i.todos)) for (const t of i.todos) parts.push(t.content || '');
      if (item.result) {
        parts.push(stripAnsi(resultText(item.result)));
        const tur = item.result.toolUseResult;
        if (tur && Array.isArray(tur.structuredPatch)) for (const h of tur.structuredPatch) parts.push((h.lines || []).join('\n'));
      }
      return parts.join('\n');
    }
    case 'orphan-result': return stripAnsi(resultText({ block: item.block, toolUseResult: item.toolUseResult }));
    case 'image': return '';
    default: return item.text || '';
  }
}

const search = { q: '', regex: false, caseSensitive: false, re: null, invalid: false, matches: [], current: -1, debounce: 0 };

// Searchable content scopes; each renders as a toggle button. Default-on scopes
// preserve the prior behavior (thinking / summaries / skill / system off).
const SEARCH_SCOPES = [
  { id: 'prompt',   label: 'prompt',   on: true,  kinds: ['user-prompt'] },
  { id: 'answer',   label: 'answer',   on: true,  kinds: ['assistant-text'] },
  { id: 'tool',     label: 'tool',     on: true,  kinds: ['tool', 'orphan-result', 'command-output', 'bash-input', 'user-command'] },
  { id: 'thinking', label: 'thinking', on: false, kinds: ['thinking'] },
  { id: 'summary',  label: 'summary',  on: false, kinds: ['continuation'] },
  { id: 'skill',    label: 'skill',    on: false, kinds: ['skill-content'] },
  { id: 'system',   label: 'system',   on: false, kinds: ['notification', 'system'] },
];
const KIND_SCOPE = {};
const scopeOn = {};
for (const s of SEARCH_SCOPES) { scopeOn[s.id] = s.on; for (const k of s.kinds) KIND_SCOPE[k] = s.id; }

// Compile the query into a global, case-insensitive RegExp.
// Returns null for an empty query, undefined for an invalid regex.
function buildRegex(q, isRegex) {
  if (!q) return null;
  const src = isRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape for literal mode
  const flags = search.caseSensitive ? 'g' : 'gi';
  try { return new RegExp(src, flags); } catch (_) { return undefined; }
}

function clearHighlights() {
  document.querySelectorAll('mark.search-hit').forEach((m) => {
    const t = document.createTextNode(m.textContent);
    const p = m.parentNode;
    p.replaceChild(t, m);
    p.normalize(); // merge split text nodes so future searches match across boundaries
  });
}

// Wrap regex matches inside an element's text nodes; returns the marks in order.
function highlightIn(root, re) {
  const marks = [];
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.parentNode && n.parentNode.nodeName !== 'MARK'
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const tn of textNodes) {
    const val = tn.nodeValue;
    re.lastIndex = 0;
    const ranges = [];
    let m;
    while ((m = re.exec(val))) {
      if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; // guard zero-width matches
    }
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [s, e] of ranges) {
      if (s < last) continue; // skip overlaps
      if (s > last) frag.appendChild(document.createTextNode(val.slice(last, s)));
      const mk = document.createElement('mark');
      mk.className = 'search-hit';
      mk.textContent = val.slice(s, e);
      frag.appendChild(mk);
      marks.push(mk);
      last = e;
    }
    if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
  return marks;
}

function ensureRendered(itemIndex) {
  const pos = VIEW ? VIEW.indexOf(itemIndex) : itemIndex; // map item index -> view position
  if (pos < 0) return; // item not in the current filtered view
  while (cursor <= pos && cursor < viewLength()) renderBatch();
}

// Expand any collapsed thinking / folded blocks (and un-clamp results) that
// contain `node`, so a match inside them becomes visible and scrollable.
function revealAncestors(node) {
  for (let n = node; n && n !== document.body; n = n.parentNode) {
    if (n.nodeType !== 1) continue;
    if ((n.classList.contains('thinking-body') || n.classList.contains('fold-body')) && n.style.display === 'none') {
      n.style.display = '';
      const chev = n.previousElementSibling && n.previousElementSibling.querySelector('.chev');
      if (chev) chev.textContent = '▾';
    }
    if (n.classList.contains('result-pre') && n.classList.contains('clamped')) {
      n.classList.remove('clamped');
      if (n._syncExpand) n._syncExpand(); // update its toggle label to the expanded state
    }
  }
}

function updateSearchCount() {
  const el = $('#searchCount');
  if (search.invalid) { el.textContent = 'bad re'; el.classList.add('none'); return; }
  const total = search.matches.length;
  el.textContent = `${total ? search.current + 1 : 0}/${total}`;
  el.classList.toggle('none', !!search.q && total === 0);
}

function runSearch(q) {
  search.q = q;
  clearHighlights();
  search.matches = [];
  search.current = -1;
  const re = buildRegex(q, search.regex);
  search.invalid = re === undefined;
  search.re = re || null;
  if (re) {
    for (let idx = 0; idx < ITEMS.length; idx++) {
      const it = ITEMS[idx];
      if (VIEW_SET && !VIEW_SET.has(idx)) continue; // hidden by the selective filter
      const sc = KIND_SCOPE[it.kind];
      if (sc && !scopeOn[sc]) continue; // scope toggled off
      if (it._t == null) it._t = itemText(it);
      re.lastIndex = 0;
      let m, occ = 0;
      while ((m = re.exec(it._t))) {
        if (m[0].length > 0) { search.matches.push({ itemIndex: idx, occ }); occ++; }
        if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
      }
    }
  }
  if (search.matches.length) gotoMatch(0);
  else updateSearchCount();
}

function gotoMatch(i) {
  if (!search.matches.length || !search.re) { updateSearchCount(); return; }
  search.current = (i + search.matches.length) % search.matches.length;
  const { itemIndex, occ } = search.matches[search.current];
  clearHighlights();
  ensureRendered(itemIndex);
  const node = $('#transcript').querySelector(`[data-item="${itemIndex}"]`);
  if (node) {
    const marks = highlightIn(node, search.re);
    const active = marks[occ] || marks[marks.length - 1];
    if (active) {
      revealAncestors(active); // expand collapsed thinking/folded blocks so the hit shows
      active.classList.add('active');
      active.scrollIntoView({ block: 'center' });
    } else {
      node.scrollIntoView({ block: 'center' });
    }
  }
  updateSearchCount();
}

// Render one toggle button per search scope into the find bar.
function renderSearchScopes(input) {
  const wrap = $('#searchScopes');
  wrap.innerHTML = '';
  for (const s of SEARCH_SCOPES) {
    const b = el('button', 'search-nav search-toggle' + (scopeOn[s.id] ? ' on' : ''), s.label);
    b.dataset.scope = s.id;
    b.title = `Search ${s.label} content`;
    b.addEventListener('click', () => {
      scopeOn[s.id] = !scopeOn[s.id];
      b.classList.toggle('on', scopeOn[s.id]);
      runSearch(input.value);
      input.focus();
    });
    wrap.appendChild(b);
  }
}

function openSearch() {
  if ($('#view').hidden) return;
  $('#searchBar').hidden = false;
  const input = $('#searchInput');
  input.focus();
  input.select();
  if (input.value) runSearch(input.value);
}

function closeSearch() {
  $('#searchBar').hidden = true;
  clearHighlights();
  search.q = '';
  search.matches = [];
  search.current = -1;
}

/* ------------------------- loading ------------------------- */
function showError(msg) {
  const e = $('#landingError');
  e.hidden = false;
  e.textContent = msg;
}

function loadText(text, sourceName) {
  const entries = parseJsonl(text);
  if (!entries.length) { showError('No valid JSONL records found in this file.'); return; }
  document.title = (sourceName ? sourceName + ' — ' : '') + 'Claude Code Viewer';
  showTranscript(entries);
}

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadText(String(reader.result), file.name);
  reader.onerror = () => showError('Could not read the file.');
  reader.readAsText(file);
}

async function boot() {
  // wire up controls
  const fileInput = $('#fileInput');
  const dropzone = $('#dropzone');
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    handleFile(f);
  });
  // allow dropping anywhere on the landing
  const landing = $('#landing');
  ['dragover', 'drop'].forEach((ev) => landing.addEventListener(ev, (e) => e.preventDefault()));

  $('#loadMoreBtn').addEventListener('click', renderBatch);
  $('#reloadBtn').addEventListener('click', () => {
    closeSearch();
    resetSelection();
    $('#view').hidden = true;
    $('#reloadBtn').hidden = true;
    $('#searchBtn').hidden = true;
    $('#selectBtn').hidden = true;
    $('#sidebar').hidden = true;
    $('#sidebarToggle').hidden = true;
    document.body.classList.remove('has-sidebar');
    $('#landing').hidden = false;
    $('#landingError').hidden = true;
  });

  // ---- selective mode controls ----
  $('#selectBtn').addEventListener('click', () => {
    if ($('#view').hidden) return;
    if (sel.mode === 'normal') enterSelectMode(); else exitSelectMode();
  });
  $('#selAll').addEventListener('click', () => {
    for (let i = 0; i < ITEMS.length; i++) sel.checked.add(i);
    syncCheckboxes();
    updateSelBar();
  });
  $('#selNone').addEventListener('click', () => {
    sel.checked.clear();
    syncCheckboxes();
    updateSelBar();
  });
  $('#selApply').addEventListener('click', applySelection);
  $('#selEdit').addEventListener('click', enterSelectMode);
  $('#selExit').addEventListener('click', exitSelectMode);
  // While picking, a click anywhere on an item toggles it. Capture phase, so
  // folds / expanders / links inside the item don't also fire in select mode.
  $('#transcript').addEventListener('click', (e) => {
    if (sel.mode !== 'select') return;
    if (e.target.classList && e.target.classList.contains('sel-check')) return; // native box path
    const s = window.getSelection();
    if (s && !s.isCollapsed) return; // let text selection through
    const node = e.target.closest('[data-item]');
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    const box = node.querySelector(':scope > .sel-check');
    if (box) setItemChecked(node, box, !box.checked);
  }, true);

  // ---- search controls ----
  const searchInput = $('#searchInput');
  $('#searchBtn').addEventListener('click', () => {
    if ($('#searchBar').hidden) openSearch(); else closeSearch();
  });
  $('#searchClose').addEventListener('click', closeSearch);
  $('#searchNext').addEventListener('click', () => gotoMatch(search.current + 1));
  $('#searchPrev').addEventListener('click', () => gotoMatch(search.current - 1));
  $('#searchRegex').addEventListener('click', () => {
    search.regex = !search.regex;
    $('#searchRegex').classList.toggle('on', search.regex);
    runSearch(searchInput.value);
    searchInput.focus();
  });
  searchInput.addEventListener('input', (e) => {
    clearTimeout(search.debounce);
    const v = e.target.value;
    search.debounce = setTimeout(() => runSearch(v), 130);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoMatch(search.current + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  renderSearchScopes(searchInput);
  $('#searchCase').addEventListener('click', () => {
    search.caseSensitive = !search.caseSensitive;
    $('#searchCase').classList.toggle('on', search.caseSensitive);
    runSearch(searchInput.value);
    searchInput.focus();
  });

  // ---- sidebar fold + resize ----
  $('#sidebarToggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    $('#sidebarToggle').textContent = collapsed ? '▶' : '◀';
  });
  $('#sidebarResizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.min(560, Math.max(150, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    };
    const up = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  // intercept Ctrl/Cmd+F to open our find bar instead of the browser's
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      if ($('#view').hidden) return; // nothing loaded — let the browser handle it
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape' && !$('#searchBar').hidden) {
      closeSearch();
    }
  });

  // auto-load more when scrolled near the bottom + keep the sidebar in sync (throttled)
  let scrollScheduled = false;
  $('#view').addEventListener('scroll', (e) => {
    const v = e.target;
    if (cursor < viewLength() && v.scrollTop + v.clientHeight > v.scrollHeight - 600) renderBatch();
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(() => { scrollScheduled = false; updateSidebarActive(); });
    }
  });

  // 1) file provided by the Node server (--file)
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    if (info && info.hasFile) {
      const text = await fetch('/api/transcript').then((r) => r.text());
      loadText(text, info.name);
      return;
    }
  } catch (_) { /* no server (static host) */ }
  // 2) static hosting (e.g. GitHub Pages): auto-load a bundled demo if present
  try {
    const res = await fetch('demo-session.jsonl');
    if (res.ok) { loadText(await res.text(), 'demo-session.jsonl'); return; }
  } catch (_) { /* none — stay on the landing/upload screen */ }
}

boot();
