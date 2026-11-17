/*  Explorer AI Proofreader - apply reviewer answers to the ORIGINAL Word file (pure logic, no DOM, no network)
 *
 *  Input : the .docx the check was made from + the findings with the reviewer's decisions.
 *  Output: a copy of that .docx in which
 *            - every agreed / edited finding is a TRACKED CHANGE (Word: Review > Accept All, or one by one),
 *            - every reviewer comment is a Word COMMENT on the right passage,
 *            - findings that cannot be placed with certainty are left alone and listed (and get a "do this by hand" comment),
 *          plus a clean copy (all changes accepted) and a report in which every finding has exactly one outcome.
 *
 *  The file is edited at the XML level (word/document.xml, word/comments.xml and the two bookkeeping files); styles, images,
 *  numbering, headers, footnotes ... are copied byte for byte. After building, the result is READ BACK and proven:
 *    - rejecting every change gives the original text again, paragraph for paragraph,
 *    - accepting every change gives exactly the planned text and nothing else,
 *    - untouched paragraphs and everything outside paragraphs are identical,
 *    - every other file in the package is identical.
 *  Needs JSZip (global in the page; DA.setZip(JSZip) in Node tests).
 */
(function (global) {
  'use strict';
  const DA = (global.DA = global.DA || {});
  let ZIP = global.JSZip || null;
  DA.setZip = (z) => { ZIP = z; };
  const getZip = () => { if (!ZIP) throw new Error('The zip library (JSZip) is not loaded.'); return ZIP; };
  DA.version = '1.0';

  // ---------------------------------------------------------------- small helpers
  const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
  const enc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const encA = (s) => enc(s).replace(/"/g, '&quot;');
  const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
  const wordCh = (c) => !!c && /[\p{L}\p{N}\p{M}]/u.test(c);
  const TAG_SRC = '<(\\/?)([A-Za-z][\\w.-]*:[\\w.-]+|[A-Za-z][\\w.-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*?)(\\/?)>';

  // top-level children of xml.slice(from,to): elements {name,start,end,innerStart,innerEnd,self} and gaps {name:null}
  function kids(xml, from, to) {
    const out = []; let depth = 0, cur = null, pos = from, m;
    const re = new RegExp(TAG_SRC, 'g'); re.lastIndex = from;
    while ((m = re.exec(xml)) && m.index < to) {
      const closing = m[1] === '/', self = m[4] === '/', name = m[2];
      if (!closing && depth === 0) {
        if (m.index > pos) out.push({ name: null, start: pos, end: m.index });
        if (self) { out.push({ name, start: m.index, end: m.index + m[0].length, self: true }); pos = m.index + m[0].length; }
        else { cur = { name, start: m.index, innerStart: m.index + m[0].length }; depth = 1; }
      } else if (!closing && !self) depth++;
      else if (closing) { depth--; if (depth === 0 && cur) { cur.innerEnd = m.index; cur.end = m.index + m[0].length; out.push(cur); pos = cur.end; cur = null; } }
    }
    if (pos < to) out.push({ name: null, start: pos, end: to });
    return out;
  }

  // top-level <w:p> blocks of a document (a paragraph inside a text box is nested in its host paragraph: the host is flagged)
  function paragraphSpans(xml) {
    const out = [], re = /<(\/?)w:p(?=[\s>\/])((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g; let m, depth = 0, start = -1, nested = false;
    while ((m = re.exec(xml))) {
      const closing = m[1] === '/', self = m[3] === '/';
      if (!closing) {
        if (self) { if (depth === 0) out.push({ start: m.index, end: m.index + m[0].length, empty: true }); else nested = true; }
        else { if (depth === 0) { start = m.index; nested = false; } else nested = true; depth++; }
      } else { depth--; if (depth === 0) out.push({ start, end: m.index + m[0].length, nested }); }
    }
    return out;
  }

  // ---------------------------------------------------------------- reading a paragraph
  function parseRun(raw) {
    const open = new RegExp(TAG_SRC).exec(raw)[0], innerEnd = raw.lastIndexOf('</w:r>');
    const run = { open, rPr: '', atoms: [] };
    if (innerEnd < 0) { run.atoms.push({ raw: '', kind: 'opaque', text: '' }); return run; }          // self-closing run: nothing in it
    kids(raw, open.length, innerEnd).forEach((k) => {
      const r = raw.slice(k.start, k.end);
      if (k.name === null) { if (r.trim()) run.atoms.push({ raw: r, kind: 'opaque', text: '' }); return; }
      if (k.name === 'w:rPr' && !run.rPr && !run.atoms.length) { run.rPr = r; return; }
      let kind = 'opaque', text = '';
      if (k.name === 'w:t') { kind = 't'; text = k.self ? '' : dec(raw.slice(k.innerStart, k.innerEnd)); }
      else if (k.name === 'w:tab') { kind = 'tab'; text = '\t'; }
      else if (k.name === 'w:cr') { kind = 'br'; text = '\n'; }
      else if (k.name === 'w:br') {
        const ty = /w:type="([^"]*)"/.exec(r);
        if (!ty || ty[1] === 'textWrapping') { kind = 'br'; text = '\n'; } else kind = 'pagebreak';
      }
      else if (k.name === 'w:noBreakHyphen') { kind = 'nbh'; text = '\u2011'; }
      else if (k.name === 'w:softHyphen' || k.name === 'w:lastRenderedPageBreak') kind = k.name === 'w:lastRenderedPageBreak' ? 'softpage' : 'marker';
      run.atoms.push({ raw: r, kind, text });
    });
    return run;
  }

  function parseParagraph(p) {
    const open = new RegExp(TAG_SRC).exec(p.raw)[0], innerEnd = p.raw.lastIndexOf('</w:p>');
    p.open = open; p.nodes = []; let pos = 0, text = '';
    kids(p.raw, open.length, innerEnd).forEach((k, i) => {
      const r = p.raw.slice(k.start, k.end);
      if (k.name === 'w:pPr' && !p.nodes.length) { p.nodes.push({ kind: 'ppr', raw: r, a0: 0, a1: 0 }); p.pPr = r; return; }
      if (k.name === 'w:r') {
        const run = parseRun(r), node = { kind: 'run', raw: r, run, a0: pos, a1: pos };
        run.atoms.forEach((a) => { a.a0 = pos; pos += a.text.length; a.a1 = pos; text += a.text; });
        node.a1 = pos; p.nodes.push(node); return;
      }
      if (k.name && /^w:(hyperlink|smartTag|ins|sdt|fldSimple|moveTo|customXml|dir|bdo)$/.test(k.name)) {      // contains text we do not edit
        let t = ''; (r.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || []).forEach((x) => { t += dec(x.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '')); });
        const node = { kind: 'tx', raw: r, text: t, a0: pos, a1: pos + t.length }; pos += t.length; text += t; p.nodes.push(node); return;
      }
      p.nodes.push({ kind: 'pass', raw: r, a0: pos, a1: pos });
    });
    p.text = text;
  }

  function readDoc(xml) {
    const spans = paragraphSpans(xml), soft = (xml.match(/<w:lastRenderedPageBreak\b/g) || []).length, layout = soft >= 2; let page = 1;
    const paras = spans.map((sp, idx) => {
      const p = { idx, start: sp.start, end: sp.end, raw: xml.slice(sp.start, sp.end), skip: false, text: '', nodes: [], page: 0, fp: {} };
      if (sp.empty || sp.nested) { p.skip = true; p.page = page; return p; }
      parseParagraph(p);
      if (!layout && /<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/.test(p.pPr || '')) page++;
      let first = 0;
      p.nodes.forEach((n) => {
        if (n.kind === 'run') n.run.atoms.forEach((a) => {
          if (a.kind === 'softpage' && layout) page++;
          else if (a.kind === 'pagebreak' && !layout) page++;
          else if (a.kind === 't' && !first && a.text.trim()) first = page;
        });
        else if (n.kind === 'tx') { if (layout) page += (n.raw.match(/<w:lastRenderedPageBreak\b/g) || []).length; if (!first && n.text.trim()) first = page; }
      });
      p.page = first || page;
      return p;
    });
    return { xml, paras, layout };
  }

  // ---------------------------------------------------------------- matching
  const INVIS = /[\u00ad\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  // Folded text for comparing: whitespace collapsed, invisible characters dropped; level 1 also unifies quotes, dashes and the ellipsis.
  // rs/re map every folded character back to its raw offsets in the paragraph.
  function fold(raw, lvl) {
    const s = [], rs = [], re = []; let prevSp = false;
    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i];
      if (INVIS.test(ch)) continue;
      if (/\s/.test(ch)) { if (prevSp) { re[re.length - 1] = i + 1; continue; } s.push(' '); rs.push(i); re.push(i + 1); prevSp = true; continue; }
      prevSp = false;
      if (lvl > 0) {
        if (/[\u2018\u2019\u201a\u201b\u2032\u02bc]/.test(ch)) ch = "'";
        else if (/[\u201c\u201d\u201e\u201f\u2033]/.test(ch)) ch = '"';
        else if (/[\u2010-\u2015\u2212]/.test(ch)) ch = '-';
        else if (ch === '\u2026') { s.push('.', '.', '.'); rs.push(i, i, i); re.push(i + 1, i + 1, i + 1); continue; }
      }
      s.push(ch); rs.push(i); re.push(i + 1);
    }
    return { s: s.join(''), rs, re };
  }
  const pfp = (p, lvl) => p.fp[lvl] || (p.fp[lvl] = fold(p.text, lvl));
  const hitsOf = (hay, nd) => { const o = []; let i = hay.indexOf(nd); while (i >= 0) { o.push(i); i = hay.indexOf(nd, i + 1); } return o; };
  const boundaryOk = (s, a, b, relaxStart, relaxEnd) => !((!relaxStart && wordCh(s[a]) && wordCh(s[a - 1])) || (!relaxEnd && wordCh(s[b - 1]) && wordCh(s[b])));
  const stripEll = (s) => clean(s).trim().replace(/^(?:\.{3}|\u2026)\s*/, '').replace(/\s*(?:\.{3}|\u2026)$/, '').trim();

  // The words of the finding -> exactly one place in the file, or a reason why not.
  function locate(model, item) {
    let q = clean(item.original).trim(), trunc = '';
    if (/(?:\.{3}|\u2026)\s*$/.test(q)) trunc = 'tail';
    if (/^(?:\.{3}|\u2026)/.test(q)) trunc = trunc ? 'both' : 'head';
    q = stripEll(q);
    if (!q) return { status: 'noquote' };
    const ctx = stripEll(item.context);
    let sawPartial = null;
    for (let lvl = 0; lvl <= 1; lvl++) {
      const nd = fold(q, lvl).s; if (!nd.trim()) continue;
      const cF = ctx ? fold(ctx, lvl).s : '';
      let cands = [], partial = [];
      model.paras.forEach((p, pi) => {
        if (p.skip || !p.text) return; const f = pfp(p, lvl);
        hitsOf(f.s, nd).forEach((i) => { const c = { pi, fs: i, fe: i + nd.length, f }; (boundaryOk(f.s, i, i + nd.length, trunc === 'head' || trunc === 'both', trunc === 'tail' || trunc === 'both') ? cands : partial).push(c); });
      });
      if (!cands.length) { if (partial.length && !sawPartial) sawPartial = partial; continue; }
      if (cands.length > 1 && cF.length >= nd.length) {
        const keep = cands.filter((c) => { let j = c.f.s.indexOf(cF); while (j >= 0) { if (j <= c.fs && c.fe <= j + cF.length) return true; j = c.f.s.indexOf(cF, j + 1); } return false; });
        if (keep.length) cands = keep;
      }
      if (cands.length > 1 && item.page) { const k = cands.filter((c) => model.paras[c.pi].page === +item.page); if (k.length) cands = k; }
      const hit = (c) => ({ pi: c.pi, ms: c.f.rs[c.fs], me: c.f.re[c.fe - 1] });
      if (cands.length === 1) return { status: 'one', hit: hit(cands[0]), trunc };
      return { status: 'many', count: cands.length };
    }
    if (sawPartial && sawPartial.length === 1) { const c = sawPartial[0]; return { status: 'partial', hit: { pi: c.pi, ms: c.f.rs[c.fs], me: c.f.re[c.fe - 1] }, trunc }; }
    return { status: 'none' };
  }

  // The paragraph (and the sentence in it) a finding talks about; used for insertions and for "do this by hand" comments.
  function locateContext(model, item, tailOnly) {
    let c = stripEll(item.context); if (!c) return null;
    for (let lvl = 0; lvl <= 1; lvl++) {
      let f0 = fold(c, lvl).s.trim(); if (tailOnly && f0.length > 80) f0 = f0.slice(-80); if (f0.length < 8) return null;
      let cands = [];
      model.paras.forEach((p, pi) => { if (p.skip || !p.text) return; const f = pfp(p, lvl); hitsOf(f.s, f0).forEach((i) => cands.push({ pi, fs: i, fe: i + f0.length, f })); });
      if (!cands.length) continue;
      if (cands.length > 1 && item.page) { const k = cands.filter((x) => model.paras[x.pi].page === +item.page); if (k.length) cands = k; }
      if (cands.length === 1) { const x = cands[0]; return { pi: x.pi, ms: x.f.rs[x.fs], me: x.f.re[x.fe - 1], count: 1 }; }
      return { count: cands.length };
    }
    return null;
  }

  // ---------------------------------------------------------------- planning
  const boundary = (s, i) => i <= 0 || i >= s.length || wordCh(s[i - 1]) !== wordCh(s[i]);
  // smallest change that turns old into new, cut at word boundaries (so the tracked change shows only what really changes)
  function trimDiff(oldS, newS) {
    let a = 0; const lim = Math.min(oldS.length, newS.length);
    while (a < lim && oldS[a] === newS[a]) a++;
    while (a > 0 && !(boundary(oldS, a) && boundary(newS, a))) a--;
    let b = 0; const lim2 = Math.min(oldS.length, newS.length) - a;
    while (b < lim2 && oldS[oldS.length - 1 - b] === newS[newS.length - 1 - b]) b++;
    while (b > 0 && !(boundary(oldS, oldS.length - b) && boundary(newS, newS.length - b))) b--;
    return { a, b, del: oldS.slice(a, oldS.length - b), ins: newS.slice(a, newS.length - b) };
  }
  // can the range [ds,de) of this paragraph be replaced safely? (only plain text inside; nothing like a tab, field, image, link)
  function rangeBlock(p, ds, de) {
    for (const n of p.nodes) {
      if (n.kind === 'pass' && ds < n.a0 && n.a0 < de && /^<w:(?:del|moveFrom|moveTo)\b/.test(n.raw)) return 'it crosses somebody else\'s tracked change';
      if (n.kind === 'tx') { if (ds === de ? (ds > n.a0 && ds < n.a1) : (n.a0 < de && n.a1 > ds)) return 'it is inside a link, field or earlier tracked change'; continue; }
      if (n.kind !== 'run') continue;
      for (const a of n.run.atoms) {
        if (a.kind === 't' || a.kind === 'softpage' || a.kind === 'marker') continue;
        const len = a.a1 - a.a0;
        if (len > 0 ? (a.a0 < de && a.a1 > ds && ds !== de) || (ds === de && ds > a.a0 && ds < a.a1) : (ds < a.a0 && a.a0 < de)) return a.kind === 'tab' ? 'it contains a tab' : a.kind === 'br' ? 'it contains a line break' : 'it contains a field, footnote mark or picture';
      }
    }
    return '';
  }
  const cutBlock = (p, x) => p.nodes.some((n) => n.kind === 'tx' && x > n.a0 && x < n.a1);
  const initials = (n) => (String(n || '').trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 3).toUpperCase() || 'R');
  const ANS = { agree: 'Agreed', edit: 'Edited', disagree: 'Disagreed', none: 'No answer' };

  // items: [{id,type,severity,loc,page,context,original,corrected,insert,decision,final,comment}]; final = text to use (null = leave as it is, '' = delete)
  function plan(model, items, opts) {
    const R = items.map((it) => ({ it, id: it.id, answer: ANS[it.decision] || 'No answer', fin: it.final == null ? null : clean(it.final), comment: clean(it.comment).trim(), outcome: '', detail: '', loc: null, edit: null, note: null }));
    const edits = [], comments = [], inserts = [];
    const manual = (r, why) => { r.outcome = 'manual'; r.detail = why; };
    R.forEach((r) => {
      const it = r.it;
      if (r.answer === 'Agreed' && (r.fin == null || r.fin === '')) {          // "Agree" on a finding that has no wording: the problem is confirmed, but there is nothing to put in (never "delete this text")
        manual(r, 'the reviewer agreed it is a problem, but no wording was suggested, so nothing was changed');
        let at = null; if (it.insert) at = locateContext(model, it, true); else { const l = locate(model, it); at = l && l.hit ? { pi: l.hit.pi, ms: l.hit.ms, me: l.hit.me } : locateContext(model, it, false); }
        if (at && at.pi != null && !cutBlock(model.paras[at.pi], at.ms) && !cutBlock(model.paras[at.pi], at.me)) { r.note = true; comments.push({ r, pi: at.pi, cs: at.ms, ce: at.me, manual: true, text: 'DO BY HAND (#' + it.id + ', Agreed): the reviewer agreed that this is a problem, but no wording was suggested.' + (r.comment ? ' Reviewer comment: ' + r.comment : '') }); }
        return;
      }
      if (it.insert) {                                                         // text missing in the translation: a whole new paragraph after the anchor
        const where = locateContext(model, it, true); r.loc = where;
        if (r.fin == null || r.fin === '') {
          if (r.comment && where && where.pi != null) { comments.push({ r, pi: where.pi, cs: where.ms, ce: where.me, text: 'Reviewer comment (#' + it.id + ', ' + r.answer + '): ' + r.comment }); r.outcome = 'commented'; r.detail = 'comment added at the place where text is missing'; }
          else if (r.comment) manual(r, 'could not find where this comment belongs'); else { r.outcome = 'kept'; r.detail = r.answer === 'Disagreed' ? 'reviewer disagreed: nothing changed' : 'no answer: nothing changed'; }
          return;
        }
        if (!where || where.pi == null) return manual(r, where && where.count > 1 ? 'the sentence it follows appears ' + where.count + ' times' : 'could not find the sentence it should follow');
        inserts.push({ r, pi: where.pi, text: r.fin, comment: r.comment });
        r.outcome = 'applied'; r.detail = 'new paragraph inserted after the sentence it follows (check the position)'; return;
      }
      const loc = locate(model, it); r.loc = loc;
      const text = r.comment ? 'Reviewer comment (#' + it.id + ', ' + r.answer + '): ' + r.comment : '';
      if (r.fin == null) {                                                     // no change to the text
        if (!r.comment) { r.outcome = 'kept'; r.detail = r.answer === 'Disagreed' ? 'reviewer disagreed: nothing changed' : 'no answer: nothing changed'; return; }
        const h = loc.hit;
        if ((loc.status === 'one' || loc.status === 'partial') && !cutBlock(model.paras[h.pi], h.ms) && !cutBlock(model.paras[h.pi], h.me)) { comments.push({ r, pi: h.pi, cs: h.ms, ce: h.me, text }); r.outcome = 'commented'; r.detail = 'reviewer comment added; text unchanged'; return; }
        const c = locateContext(model, it, false);
        if (c && c.pi != null) { comments.push({ r, pi: c.pi, cs: c.ms, ce: c.me, text }); r.outcome = 'commented'; r.detail = 'reviewer comment added on the sentence (exact words not found)'; return; }
        return manual(r, 'reviewer comment could not be placed (' + (loc.status === 'none' ? 'words not found in this file' : loc.status === 'many' ? 'words appear in ' + loc.count + ' places' : 'no exact words given') + ')');
      }
      // a change to make
      let why = '';
      if (loc.status === 'noquote') why = 'the finding gives no exact words to replace';
      else if (loc.status === 'none') why = 'the words were not found in this file (different version?)';
      else if (loc.status === 'many') why = 'the same words appear in ' + loc.count + ' places and the sentence/page did not settle which';
      else if (loc.status === 'partial') why = 'the words only occur inside longer words';
      else if (loc.trunc) why = 'the finding quotes only part of the passage ("...")';
      let ed = null;
      if (!why) {
        const p = model.paras[loc.hit.pi], oldRaw = p.text.slice(loc.hit.ms, loc.hit.me);
        if (oldRaw === r.fin) { r.outcome = 'already'; r.detail = 'the text already reads as suggested'; if (r.comment) { const h = loc.hit; if (!cutBlock(p, h.ms) && !cutBlock(p, h.me)) comments.push({ r, pi: h.pi, cs: h.ms, ce: h.me, text }); } return; }
        const d = trimDiff(oldRaw, r.fin), ds = loc.hit.ms + d.a, de = loc.hit.me - d.b;
        // a reviewer often types the sentence's full stop into the new words while the document already has it right after the replaced words: never double it
        let insTxt = d.ins, stopDropped = false;
        if (insTxt && /[.,;:!?\u2026]$/.test(insTxt) && p.text[de] === insTxt[insTxt.length - 1]) { insTxt = insTxt.slice(0, -1); stopDropped = true; }
        if (ds === de && insTxt === '') { r.outcome = 'already'; r.detail = 'the text already reads as suggested'; if (r.comment) { const h = loc.hit; if (!cutBlock(p, h.ms) && !cutBlock(p, h.me)) comments.push({ r, pi: h.pi, cs: h.ms, ce: h.me, text }); } return; }
        const bl = rangeBlock(p, ds, de); if (bl) why = bl; else if (cutBlock(p, ds) || cutBlock(p, de) || cutBlock(p, loc.hit.ms) || cutBlock(p, loc.hit.me)) why = 'it is inside a link, field or earlier tracked change';
        else ed = { r, pi: loc.hit.pi, ms: loc.hit.ms, me: loc.hit.me, ds, de, text: insTxt, comment: text, stopDropped };
      }
      if (why) {                                                               // keep the file untouched, but leave a visible note where we can
        manual(r, why);
        const c = locateContext(model, it, false);
        if (c && c.pi != null) { r.note = true; comments.push({ r, pi: c.pi, cs: c.ms, ce: c.me, manual: true, text: 'DO BY HAND (#' + it.id + ', ' + r.answer + '): replace "' + clean(it.original).trim() + '" with "' + r.fin + '". Not applied automatically: ' + why + '.' + (r.comment ? ' Reviewer comment: ' + r.comment : '') }); }
        return;
      }
      edits.push(ed); r.edit = ed; r.outcome = 'applied';
      r.detail = (ed.text === '' ? 'deleted as tracked change' : (ed.ds === ed.de ? 'inserted as tracked change' : 'replaced as tracked change')) + (ed.stopDropped ? ' (the full stop that already follows was not doubled)' : '');
    });
    // two findings must never change the same words in different ways
    const byP = {}; edits.forEach((e) => { (byP[e.pi] = byP[e.pi] || []).push(e); });
    Object.keys(byP).forEach((k) => {
      const list = byP[k].sort((a, b) => a.ds - b.ds || a.de - b.de); let last = null;
      list.forEach((e) => {
        if (last && (e.ds < last.de || (e.ds === last.ds && e.de === last.de && e !== last))) {
          if (e.ds === last.ds && e.de === last.de && e.text === last.text) { e.dup = last; e.r.outcome = 'applied'; e.r.detail = 'same change as #' + last.r.id + ' (made once)'; return; }
          e.drop = true; manual(e.r, 'it overlaps the change for #' + last.r.id); e.r.edit = null; return;
        }
        last = e;
      });
    });
    const live = edits.filter((e) => !e.drop && !e.dup);
    // comments that belong to a change (only the reviewer's words); the change itself is anchored over the quoted words
    live.forEach((e) => { if (e.comment) comments.push({ r: e.r, pi: e.pi, cs: e.ms, ce: e.me, text: e.comment, edit: e }); });
    edits.filter((e) => e.dup && e.comment).forEach((e) => comments.push({ r: e.r, pi: e.pi, cs: e.ms, ce: e.me, text: e.comment }));
    inserts.forEach((x) => { if (x.comment) x.commentText = 'Reviewer comment (#' + x.r.id + ', ' + x.r.answer + '): ' + x.comment; });
    return { R, edits: live, comments, inserts };
  }

  // ---------------------------------------------------------------- writing a paragraph
  const atomXml = (a, partial) => (partial == null ? a.raw : '<w:t xml:space="preserve">' + enc(partial) + '</w:t>');
  // cut a run into pieces at the given raw offsets (only offsets strictly inside the run's text)
  function splitRun(n, cuts) {
    const run = n.run, inside = cuts.filter((x) => x > n.a0 && x < n.a1);
    const mk = (atoms, a0, a1) => ({ kind: 'run', a0, a1, run, xml: run.open + run.rPr + atoms.map((x) => x.xml).join('') + '</w:r>', atoms });
    if (!inside.length) return [{ kind: 'run', a0: n.a0, a1: n.a1, run, xml: n.raw, atoms: run.atoms.map((a) => ({ xml: a.raw })) }];
    const out = []; let cur = [], curA0 = n.a0;
    const flush = (at) => { if (cur.length) out.push(mk(cur, curA0, at)); cur = []; curA0 = at; };
    run.atoms.forEach((a) => {
      if (inside.indexOf(a.a0) >= 0 && cur.length) flush(a.a0);               // a cut falls exactly between two atoms
      if (a.kind === 't' && a.a1 > a.a0) {
        let from = a.a0; const pts = inside.filter((x) => x > a.a0 && x < a.a1);   // cuts inside this piece of text
        pts.forEach((x) => { cur.push({ xml: atomXml(a, a.text.slice(from - a.a0, x - a.a0)) }); flush(x); from = x; });
        cur.push({ xml: pts.length ? atomXml(a, a.text.slice(from - a.a0)) : a.raw });
      } else cur.push({ xml: a.raw });
    });
    flush(n.a1); return out;
  }
  const toDel = (x) => x.replace(/<w:t(?=[\s>\/])/g, '<w:delText').replace(/<\/w:t>/g, '</w:delText>');
  const textRuns = (rPr, text) => {                                           // new text -> one run (tabs and line breaks as Word elements)
    let body = ''; String(text).split(/(\t|\r\n|\n|\r)/).forEach((s) => { if (s === '\t') body += '<w:tab/>'; else if (/^(\r\n|\n|\r)$/.test(s)) body += '<w:br/>'; else if (s) body += '<w:t xml:space="preserve">' + enc(s) + '</w:t>'; });
    return '<w:r>' + (rPr || '') + body + '</w:r>';
  };

  // ctx: { tracked, author, date, nextId() }
  function rebuildParagraph(p, edits, comments, ctx) {
    const cuts = new Set(); edits.forEach((e) => { cuts.add(e.ds); cuts.add(e.de); }); comments.forEach((c) => { cuts.add(c.cs); cuts.add(c.ce); });
    const cutList = Array.from(cuts).sort((x, y) => x - y), pieces = [];          // cuts must run in order
    p.nodes.forEach((n) => {
      if (n.kind === 'run') splitRun(n, cutList).forEach((x) => pieces.push(x));
      else pieces.push({ kind: n.kind, a0: n.a0, a1: n.a1, xml: n.raw });
    });
    const delOf = (pc) => { if (pc.kind !== 'run') return null; for (const e of edits) if (e.de > e.ds && pc.a0 >= e.ds && pc.a1 <= e.de && (pc.a1 > pc.a0 || (pc.a0 > e.ds && pc.a0 < e.de))) return e; return null; };
    // events at raw offsets: 0 = a comment ends here, 1 = a comment starts here, 2 = pure insertion here
    const events = [];
    comments.forEach((c) => { if (c.edit && c.edit.ds === c.edit.de) return; events.push({ x: c.cs, o: 1, c }); events.push({ x: c.ce, o: 0, c }); });
    edits.forEach((e) => { if (e.ds === e.de) events.push({ x: e.ds, o: 2, e }); });
    events.sort((a, b) => a.x - b.x || a.o - b.o); let ei = 0;
    const attrs = () => ' w:id="' + ctx.nextId() + '" w:author="' + encA(ctx.author) + '" w:date="' + ctx.date + '"';
    const refRun = (c) => '<w:r><w:commentReference w:id="' + c.id + '"/></w:r>';
    const insXml = (e, rPr) => { if (!e.text) return ''; const run = textRuns(rPr, e.text); return ctx.tracked ? '<w:ins' + attrs() + '>' + run + '</w:ins>' : run; };
    let out = '', curDel = null, lastRPr = '', lastEnd = 0, delRPr = '', nextRPr = '';
    const rPrAfter = (x) => { for (const pc of pieces) if (pc.kind === 'run' && pc.a0 >= x && pc.run.rPr) return pc.run.rPr; return lastRPr; };
    const fire = (limit) => {
      while (ei < events.length && events[ei].x <= limit) {
        const ev = events[ei++];
        if (ev.o === 1) out += '<w:commentRangeStart w:id="' + ev.c.id + '"/>';
        else if (ev.o === 0) out += '<w:commentRangeEnd w:id="' + ev.c.id + '"/>' + refRun(ev.c);
        else {
          const cm = comments.find((c) => c.edit === ev.e), rp = lastRPr || rPrAfter(ev.x);
          if (cm) out += '<w:commentRangeStart w:id="' + cm.id + '"/>' + insXml(ev.e, rp) + '<w:commentRangeEnd w:id="' + cm.id + '"/>' + refRun(cm);
          else out += insXml(ev.e, rp);
        }
      }
    };
    const closeDel = () => {
      if (!curDel) return; if (ctx.tracked) out += '</w:del>';
      if (lastEnd === curDel.de) out += insXml(curDel, delRPr);
      curDel = null;
    };
    pieces.forEach((pc) => {
      if (pc.kind === 'ppr') { out += pc.xml; return; }
      const e = delOf(pc);
      if (curDel && curDel !== e) closeDel();
      fire(pc.a0);
      if (e) {
        if (!curDel) { curDel = e; delRPr = pc.run.rPr; if (ctx.tracked) out += '<w:del' + attrs() + '>'; }
        if (ctx.tracked) out += toDel(pc.xml); lastEnd = pc.a1;
      } else out += pc.xml;
      if (pc.kind === 'run' && pc.run.rPr && pc.a1 > pc.a0) lastRPr = pc.run.rPr;
    });
    closeDel(); fire(Infinity);
    return p.open + out + '</w:p>';
  }

  function insertedParagraph(anchor, text, ctx, cm) {
    const mark = '<w:ins' + ' w:id="' + ctx.nextId() + '" w:author="' + encA(ctx.author) + '" w:date="' + ctx.date + '"/>';
    let ppr = anchor.pPr || '';
    if (ppr) {
      ppr = ppr.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, '').replace(/<w:pPrChange[\s\S]*?<\/w:pPrChange>/g, '');
      if (/<w:rPr>/.test(ppr)) ppr = ppr.replace('<w:rPr>', () => '<w:rPr>' + (ctx.tracked ? mark : ''));
      else ppr = ppr.replace(/<\/w:pPr>\s*$/, () => (ctx.tracked ? '<w:rPr>' + mark + '</w:rPr>' : '') + '</w:pPr>');
    } else if (ctx.tracked) ppr = '<w:pPr><w:rPr>' + mark + '</w:rPr></w:pPr>';
    let rPr = ''; for (const n of anchor.nodes) if (n.kind === 'run' && n.run.rPr && n.a1 > n.a0) { rPr = n.run.rPr; break; }
    const run = textRuns(rPr, text), body = ctx.tracked ? '<w:ins w:id="' + ctx.nextId() + '" w:author="' + encA(ctx.author) + '" w:date="' + ctx.date + '">' + run + '</w:ins>' : run;
    const wrapped = cm ? '<w:commentRangeStart w:id="' + cm.id + '"/>' + body + '<w:commentRangeEnd w:id="' + cm.id + '"/><w:r><w:commentReference w:id="' + cm.id + '"/></w:r>' : body;
    return '<w:p>' + ppr + wrapped + '</w:p>';
  }

  // ---------------------------------------------------------------- reading the result back (independent of the code above)
  const OPEN = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*?';
  function readText(px, mode) {
    let x = px;
    if (mode === 'rejected') x = x.replace(new RegExp('<w:ins\\b' + OPEN + '(?<!\\/)>[\\s\\S]*?<\\/w:ins>', 'g'), '');
    else if (mode === 'accepted') x = x.replace(new RegExp('<w:del\\b' + OPEN + '(?<!\\/)>[\\s\\S]*?<\\/w:del>', 'g'), '');
    const re = new RegExp('<w:(t|delText)(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:\\1>|<w:tab\\s*\\/>|<w:cr\\s*\\/>|<w:noBreakHyphen\\s*\\/>|<w:br(?:\\s[^>]*)?\\/>', 'g'); let out = '', m;
    while ((m = re.exec(x))) {
      if (m[1]) out += dec(m[2]);
      else if (m[0].indexOf('<w:tab') === 0) out += '\t';
      else if (m[0].indexOf('<w:noBreakHyphen') === 0) out += '\u2011';
      else if (m[0].indexOf('<w:cr') === 0) out += '\n';
      else { const ty = /w:type="([^"]*)"/.exec(m[0]); if (!ty || ty[1] === 'textWrapping') out += '\n'; }
    }
    return out;
  }
  const isNewPara = (px, ids) => { const m = /<w:pPr\b[\s\S]*?<w:ins\b[^>]*w:id="(\d+)"[^>]*\/>[\s\S]*?<\/w:pPr>/.exec(px); return !!m && (!ids || ids.has(m[1])); };
  function balanced(xml) {
    const re = new RegExp(TAG_SRC, 'g'), st = []; let m;
    while ((m = re.exec(xml))) { if (m[4] === '/') continue; if (m[1] === '/') { if (st.pop() !== m[2]) return false; } else st.push(m[2]); }
    return st.length === 0;
  }
  const wellFormed = (xml) => { if (!balanced(xml)) return false; if (typeof DOMParser !== 'undefined') { try { const d = new DOMParser().parseFromString(xml, 'application/xml'); if (d.getElementsByTagName('parsererror').length) return false; } catch (_) { return false; } } return true; };

  // ---------------------------------------------------------------- fingerprint of a file (so the review can tell it is the same document later)
  async function sha256hex(str) {
    const c = global.crypto && global.crypto.subtle ? global.crypto : null; if (!c) return '';
    const b = await c.subtle.digest('SHA-256', new TextEncoder().encode(str)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function fingerprintXml(xml) {
    const model = readDoc(xml), texts = []; let words = 0;
    model.paras.forEach((p) => { if (p.skip) return; const f = fold(p.text, 0).s.trim(); if (f) { texts.push(f); words += f.split(' ').length; } });
    return { v: 1, n: texts.length, words, sha: await sha256hex(texts.join('\n')) };
  }
  DA.fingerprint = async function (u8) {
    const zip = await getZip().loadAsync(u8), f = zip.file('word/document.xml'); if (!f) return null; return fingerprintXml(await f.async('string'));
  };
  DA.compareFingerprint = function (saved, now, savedWords) {
    if (saved && saved.sha && now && now.sha) return saved.sha === now.sha ? { same: true, level: 'exact', text: 'This is exactly the document that was checked.' }
      : { same: false, level: 'differs', text: 'This file is NOT identical to the one that was checked (' + saved.n + ' paragraphs / ' + saved.words + ' words then, ' + now.n + ' / ' + now.words + ' now).' };
    const w = +(saved && saved.words) || +savedWords || 0;
    if (w && now) { const r = Math.abs(now.words - w) / w; return r <= 0.03 ? { same: true, level: 'rough', text: 'The word count is about the same as when it was checked (' + w + ' then, ' + now.words + ' now). The review has no exact fingerprint, so this is a weaker check.' } : { same: false, level: 'differs', text: 'The word count differs from when it was checked (' + w + ' then, ' + now.words + ' now).' }; }
    return { same: null, level: 'unknown', text: 'The review holds no fingerprint of the checked file, so only the quoted words can be compared.' };
  };

  // ---------------------------------------------------------------- the whole job
  const CT_COMMENTS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
  const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
  const iso = (d) => { const t = d ? new Date(d) : new Date(); return (isNaN(t) ? new Date() : t).toISOString().replace(/\.\d+Z$/, 'Z'); };

  function commentsXml(list, author, date, existing) {
    const body = list.map((c) => {
      const paras = String(c.text).split(/\r?\n/).map((line, i) => '<w:p>' + (i === 0 ? '<w:r><w:annotationRef/></w:r>' : '') + '<w:r><w:t xml:space="preserve">' + enc(line) + '</w:t></w:r></w:p>').join('');
      return '<w:comment w:id="' + c.id + '" w:author="' + encA(author) + '" w:date="' + date + '" w:initials="' + encA(initials(author)) + '">' + paras + '</w:comment>';
    }).join('');
    if (existing) return existing.replace(/<\/w:comments>\s*$/, () => body + '</w:comments>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + body + '</w:comments>';
  }

  function buildDocXml(model, P, ctx) {
    const byEdit = {}, byCom = {}, byIns = {};
    P.edits.forEach((e) => { (byEdit[e.pi] = byEdit[e.pi] || []).push(e); });
    P.comments.forEach((c) => { (byCom[c.pi] = byCom[c.pi] || []).push(c); });
    P.inserts.forEach((x) => { (byIns[x.pi] = byIns[x.pi] || []).push(x); });
    const touched = Array.from(new Set(Object.keys(byEdit).concat(Object.keys(byCom), Object.keys(byIns)).map(Number))).sort((a, b) => a - b);
    const repl = touched.map((pi) => {                                         // in document order, so the change numbers run forwards
      const p = model.paras[pi]; let neu = p.raw;
      if (byEdit[pi] || byCom[pi]) neu = rebuildParagraph(p, byEdit[pi] || [], byCom[pi] || [], ctx);
      (byIns[pi] || []).forEach((x) => { neu += insertedParagraph(p, x.text, ctx, x.cm); });
      return { p, neu };
    });
    let xml = model.xml; for (let i = repl.length - 1; i >= 0; i--) xml = xml.slice(0, repl[i].p.start) + repl[i].neu + xml.slice(repl[i].p.end);
    return xml;
  }

  async function sameBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  // items: see plan(); opts: { author, date, clean:true, manualComments:true }
  DA.run = async function (u8, items, opts) {
    opts = opts || {};
    const Z = getZip(); let zip;
    try { zip = await Z.loadAsync(u8); } catch (e) { throw new Error('This file could not be opened as a Word document (.docx).'); }
    const docFile = zip.file('word/document.xml'); if (!docFile) throw new Error('This is not a Word document (.docx): word/document.xml is missing.');
    const xml = await docFile.async('string'), model = readDoc(xml);
    const author = clean(opts.author).trim() || 'Reviewer', date = iso(opts.date), P = plan(model, items, opts);
    if (opts.manualComments === false) P.comments = P.comments.filter((c) => !c.manual);
    // what the file already contains (ids stay unique)
    const oldComments = zip.file('word/comments.xml') ? await zip.file('word/comments.xml').async('string') : '';
    let maxId = 0; (xml + oldComments).replace(/w:id="(\d+)"/g, (m, d) => { if (+d > maxId) maxId = +d; return m; });
    let idc = maxId + 1; P.comments.forEach((c) => { c.id = idc++; });
    P.inserts.forEach((x) => { if (x.comment) { x.cm = { id: idc++, text: x.commentText, ins: true }; P.comments.push(x.cm); x.cm.pi = -1; } });
    const base = idc;
    const mkCtx = (tracked) => { let n = base; return { tracked, author, date, nextId: () => n++ }; };
    const commentList = P.comments.slice().sort((a, b) => a.id - b.id);
    // ---- the two documents
    const trackedXml = buildDocXml(model, { edits: P.edits, comments: P.comments.filter((c) => c.pi >= 0), inserts: P.inserts }, mkCtx(true));
    const cleanXml = opts.clean === false ? null : buildDocXml(model, { edits: P.edits, comments: P.comments.filter((c) => c.pi >= 0), inserts: P.inserts }, mkCtx(false));
    const hasChange = P.edits.length > 0 || P.inserts.length > 0 || P.comments.length > 0;
    // ---- package parts
    const rels = zip.file('word/_rels/document.xml.rels') ? await zip.file('word/_rels/document.xml.rels').async('string') : null;
    const ctypes = zip.file('[Content_Types].xml') ? await zip.file('[Content_Types].xml').async('string') : null;
    const needRel = rels && P.comments.length && rels.indexOf(REL_COMMENTS) < 0, needCt = ctypes && P.comments.length && ctypes.indexOf('/word/comments.xml') < 0;
    let newRels = rels, newCt = ctypes, relAdd = '', ctAdd = '';
    if (needRel) { let mx = 0; rels.replace(/Id="rId(\d+)"/g, (m, d) => { if (+d > mx) mx = +d; return m; }); relAdd = '<Relationship Id="rId' + (mx + 1) + '" Type="' + REL_COMMENTS + '" Target="comments.xml"/>'; newRels = rels.replace(/<\/Relationships>\s*$/, () => relAdd + '</Relationships>'); }
    if (needCt) { ctAdd = '<Override PartName="/word/comments.xml" ContentType="' + CT_COMMENTS + '"/>'; newCt = ctypes.replace(/<\/Types>\s*$/, () => ctAdd + '</Types>'); }
    const cx = P.comments.length ? commentsXml(commentList, author, date, oldComments || '') : '';
    const NF = { createFolders: false };                                         // Word's own files have no folder entries; keep it that way
    const gen = async (docXml, which) => {
      const z = await Z.loadAsync(u8); z.file('word/document.xml', opts._mutate ? opts._mutate(docXml, which) : docXml, NF);
      if (opts._mutateZip) await opts._mutateZip(z, which);
      if (P.comments.length) { z.file('word/comments.xml', cx, NF); if (newRels !== rels) z.file('word/_rels/document.xml.rels', newRels, NF); if (newCt !== ctypes) z.file('[Content_Types].xml', newCt, NF); }
      return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    };
    const out = { tracked: hasChange ? await gen(trackedXml, 'tracked') : null, clean: hasChange && cleanXml ? await gen(cleanXml, 'clean') : null };
    // ---- prove it
    const receipt = hasChange ? await verify({ zip, model, xml, P, out, trackedXml, cleanXml, newRels, newCt, rels, ctypes, relAdd, ctAdd, cx, oldComments, u8 }) : { ok: true, checks: [{ name: 'Nothing to change in the file', ok: true, detail: '' }] };
    // ---- ledger (one line per finding)
    const ledger = P.R.map((r) => ({ id: r.id, type: r.it.type || '', severity: r.it.severity || '', loc: r.it.loc || '', page: r.it.page || '', answer: r.answer, outcome: r.outcome, detail: r.detail,
      original: r.it.insert ? '' : clean(r.it.original), use: r.fin == null ? '' : r.fin, comment: r.comment, handNote: !!r.note }));
    const tot = { sent: ledger.length, applied: 0, already: 0, commented: 0, kept: 0, manual: 0 }; ledger.forEach((l) => { tot[l.outcome] = (tot[l.outcome] || 0) + 1; });
    const toApply = P.R.filter((r) => r.fin != null && r.fin !== undefined).length;
    const accounted = tot.applied + tot.already + P.R.filter((r) => r.outcome === 'manual' && r.fin != null).length === toApply && ledger.every((l) => l.outcome);
    receipt.checks.push({ name: 'Every finding has exactly one outcome', ok: ledger.length === items.length && ledger.every((l) => l.outcome) && accounted, detail: tot.sent + ' findings: ' + tot.applied + ' applied, ' + tot.already + ' already as suggested, ' + tot.commented + ' comment only, ' + tot.kept + ' left as they are, ' + tot.manual + ' need you' });
    receipt.ok = receipt.checks.every((c) => c.ok);
    // ---- is it the right file? share of findings whose words were found
    const withQ = P.R.filter((r) => !r.it.insert && stripEll(r.it.original)), found = withQ.filter((r) => r.loc && (r.loc.status === 'one' || r.loc.status === 'many' || r.loc.status === 'partial')).length;
    const gate = { quotes: withQ.length, found, ratio: withQ.length ? found / withQ.length : 1 };
    gate.ok = gate.ratio >= 0.9;
    return { ledger, totals: tot, toApply, gate, receipt, files: out, csv: ledgerCsv(ledger), author, date, counts: { edits: P.edits.length, inserts: P.inserts.length, comments: P.comments.length } };
  };

  async function verify(c) {
    const checks = [], add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    const { zip, model, P, out } = c, Z = getZip();
    const edByP = {}; P.edits.forEach((e) => { (edByP[e.pi] = edByP[e.pi] || []).push(e); });
    const planned = (p) => { let t = p.text; (edByP[p.idx] || []).slice().sort((a, b) => b.ds - a.ds).forEach((e) => { t = t.slice(0, e.ds) + e.text + t.slice(e.de); }); return t; };
    const touched = new Set(P.edits.map((e) => e.pi).concat(P.comments.filter((x) => x.pi >= 0).map((x) => x.pi)));
    const seq = []; model.paras.forEach((p) => { seq.push({ p }); P.inserts.filter((x) => x.pi === p.idx).forEach((x) => seq.push({ ins: x })); });
    const skel = (x, spans) => { let s = '', pos = 0; spans.forEach((sp) => { s += x.slice(pos, sp.start) + '\u0001'; pos = sp.end; }); return (s + x.slice(pos)).replace(/\u0001+/g, '\u0001'); };
    const origSkel = skel(c.xml, paragraphSpans(c.xml)), pl = (a) => (a.length ? 'paragraph ' + a.slice(0, 5).join(', ') : '');
    for (const which of ['tracked', 'clean']) {
      if (!out[which]) continue;
      const tr = which === 'tracked', label = tr ? 'Tracked file: ' : 'Clean file: ', z2 = await Z.loadAsync(out[which]);
      // the package: every part except the four we meant to touch is byte-identical, and nothing was added or lost
      const mine = ['word/document.xml', 'word/comments.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml'];
      const had = Object.keys(zip.files), now = Object.keys(z2.files), diffs = [];
      for (const n of had) { if (zip.files[n].dir || mine.indexOf(n) >= 0) continue; const f2 = z2.file(n); if (!f2) { diffs.push(n + ' is missing'); continue; } if (!(await sameBytes(await zip.file(n).async('uint8array'), await f2.async('uint8array')))) diffs.push(n + ' differs'); }
      now.forEach((n) => { if (!zip.files[n] && n !== 'word/comments.xml') diffs.push(n + ' was added'); });
      had.forEach((n) => { if (!z2.files[n]) diffs.push(n + ' is missing'); });
      add(label + 'every other file in the Word package is identical (' + had.filter((n) => !zip.files[n].dir && mine.indexOf(n) < 0).length + ' files)', !diffs.length, diffs.slice(0, 4).join('; '));
      const rels2 = z2.file('word/_rels/document.xml.rels') ? await z2.file('word/_rels/document.xml.rels').async('string') : null, ct2 = await z2.file('[Content_Types].xml').async('string');
      add(label + 'the file lists changed only by the one comments entry', (rels2 === null ? c.rels === null : rels2.replace(c.relAdd, '') === c.rels) && ct2.replace(c.ctAdd, '') === c.ctypes && (c.relAdd ? rels2.split(c.relAdd).length === 2 : true), '');
      // the document, paragraph by paragraph
      const doc2 = await z2.file('word/document.xml').async('string'), px2 = paragraphSpans(doc2).map((sp) => doc2.slice(sp.start, sp.end));
      add(label + 'same paragraphs in the same order (' + model.paras.length + (P.inserts.length ? ' + ' + P.inserts.length + ' inserted' : '') + ')', px2.length === seq.length, px2.length + ' found, ' + seq.length + ' expected');
      let uOk = 0, rOk = 0, aOk = 0, iOk = 0; const uBad = [], rBad = [], aBad = [], iBad = [];
      seq.forEach((s, k) => {
        const px = px2[k]; if (px == null) return;
        if (s.p) {
          const p = s.p;
          if (!touched.has(p.idx)) { if (px === p.raw) uOk++; else uBad.push(p.idx + 1); return; }
          if (p.skip) return;
          if (tr) { if (readText(px, 'rejected') === readText(p.raw, 'rejected')) rOk++; else rBad.push(p.idx + 1); }
          if (readText(px, 'accepted') === planned(p)) aOk++; else aBad.push(p.idx + 1);
        } else {
          const good = readText(px, 'accepted') === s.ins.text && (!tr || (isNewPara(px) && readText(px, 'rejected') === ''));
          if (good) iOk++; else iBad.push('#' + s.ins.r.id);
        }
      });
      add(label + 'paragraphs you did not touch are identical, byte for byte (' + uOk + ' checked)', !uBad.length, pl(uBad));
      if (tr) add(label + 'rejecting every change gives back your original text (' + rOk + ' changed paragraphs checked)', !rBad.length, pl(rBad));
      add(label + 'accepting every change gives exactly the planned text and nothing else (' + aOk + ' changed paragraphs checked)', !aBad.length, pl(aBad));
      if (P.inserts.length) add(label + 'inserted paragraphs read exactly as planned' + (tr ? ' and vanish when rejected' : '') + ' (' + iOk + ')', !iBad.length, iBad.join(', '));
      add(label + 'everything outside the paragraphs (page setup, sections) is identical', skel(doc2, paragraphSpans(doc2)) === origSkel, '');
      // well formed, and every comment is complete
      const cx2 = z2.file('word/comments.xml') ? await z2.file('word/comments.xml').async('string') : '';
      add(label + 'the XML is well formed', wellFormed(doc2) && (!cx2 || wellFormed(cx2)), '');
      const grab = (re, s) => (s.match(re) || []).map((x) => x.replace(/\D/g, ''));
      const st = grab(/<w:commentRangeStart w:id="\d+"/g, doc2), en = grab(/<w:commentRangeEnd w:id="\d+"/g, doc2), rf = grab(/<w:commentReference w:id="\d+"/g, doc2), df = grab(/<w:comment w:id="\d+"/g, cx2);
      const mineIds = P.comments.map((x) => String(x.id));
      add(label + 'every comment has a start, an end, a reference and its text (' + mineIds.length + ')', mineIds.every((d) => st.indexOf(d) >= 0 && en.indexOf(d) >= 0 && rf.indexOf(d) >= 0 && df.indexOf(d) >= 0) && st.length === en.length, '');
      const ids = grab(/<w:(?:ins|del) [^>]*?w:id="\d+"/g, doc2).concat(grab(/<w:commentRangeStart w:id="\d+"/g, doc2));
      add(label + 'every change and comment has its own number', new Set(ids).size === ids.length, '');
    }
    return { ok: checks.every((x) => x.ok), checks };
  }

  function ledgerCsv(ledger) {
    const head = ['#', 'Location', 'Page', 'Type', 'Reviewer answer', 'Result', 'Detail', 'Current text', 'Replace with', 'Reviewer comment'];
    const RES = { applied: 'Applied in Word', already: 'Already as suggested', commented: 'Comment added', kept: 'Left as it is', manual: 'NEEDS YOU' };
    return [head].concat(ledger.map((l) => [l.id, l.loc, l.page, l.type, l.answer, RES[l.outcome] || l.outcome, l.detail, l.original, l.use, l.comment]))
      .map((r) => r.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  }

  Object.assign(DA, { _internals: { fold, readDoc, locate, plan, trimDiff, readText, paragraphSpans, kids, splitRun, parseRun, locateContext } });
})(typeof window !== 'undefined' ? window : globalThis);
