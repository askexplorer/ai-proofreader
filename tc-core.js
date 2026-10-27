/*  Explorer AI Proofreader - translation check core (pure logic, no DOM, no network)
 *
 *  Compares a SOURCE document with its TRANSLATION so nothing is silently skipped:
 *    1. read both into paragraphs (RTF / text / pages),
 *    2. split into chapters and pair them (by number, else by order, else by length),
 *    3. cut each chapter pair into windows small enough for one model call,
 *    4. build the prompts and strictly validate the answers (every paragraph on both sides
 *       must be accounted for, quotes must really exist in the text),
 *    5. add rule-based checks (numbers, untranslated text, length outliers, missing chapters),
 *    6. score the result with a fixed rubric.
 *
 *  The browser page (index.html) does the file reading, the API calls and the display.
 */
(function (global) {
  'use strict';

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 1. Text helpers
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  const SOFT_HYPHEN = String.fromCharCode(0xAD), ZW = /[\u200b\u200c\u200d\u2060\ufeff]/g;
  const LINE_SEP = String.fromCharCode(0x2028), PARA_SEP = String.fromCharCode(0x2029);

  // one clean line of text: NFC, no soft hyphens / zero-width marks, single spaces
  function clean(s) {
    let t = String(s == null ? '' : s).split(SOFT_HYPHEN).join('').replace(ZW, '').split(LINE_SEP).join(' ').split(PARA_SEP).join(' ');
    try { t = t.normalize('NFC'); } catch (_) { /* old engine */ }
    return t.replace(/[\s\u00a0]+/g, ' ').trim();
  }
  const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/g;         // kana, han, hangul, thai
  function countWords(text) {
    const t = String(text || '');
    const cjk = (t.match(CJK_RE) || []).length;
    if (cjk > t.length * 0.3) return Math.ceil(cjk / 2);                              // no spaces between words
    return (t.match(/\S+/g) || []).length;
  }
  const norm = (s) => clean(s).toLowerCase().replace(/[\u2018\u2019\u201a\u201b\u02bc`\u00b4]/g, "'").replace(/[\u201c\u201d\u201e\u201f]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-');

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 2. RTF reader (the "Word" files that are really RTF, e.g. EXP-...-Manuscript.doc)
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf',
    'footerl', 'footerr', 'footerf', 'footnote', 'annotation', 'fldinst', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'latentstyles',
    'themedata', 'colorschememapping', 'datastore', 'xmlnstbl', 'filetbl', 'revtbl', 'pgptbl', 'mmathpr', 'wgrffmtfilter', 'fontemb', 'defchp',
    'defpap', 'operator', 'private', 'userprops', 'nonshppict', 'shpinst', 'shptxt']);
  const RTF_CHAR = { emdash: '\u2014', endash: '\u2013', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d', bullet: '\u2022',
    emspace: ' ', enspace: ' ', qmspace: ' ', tab: '\t', line: LINE_SEP, zwj: '', zwnj: '', ltrmark: '', rtlmark: '' };
  const decoders = {};
  function byteToChar(b, cp) {
    if (b < 0x80) return String.fromCharCode(b);
    const label = 'windows-' + cp;
    try {
      if (!decoders[label]) decoders[label] = new TextDecoder(label);
      return decoders[label].decode(new Uint8Array([b]));
    } catch (_) { return String.fromCharCode(b); }
  }
  function rtfToText(rtf) {
    const s = String(rtf || '');
    const cpm = /\\ansicpg(\d+)/.exec(s), cp = cpm ? cpm[1] : '1252';
    const out = [];
    let i = 0, n = s.length;
    const stack = [];                                              // { skip, uc }
    let skip = false, uc = 1, skipChars = 0;
    const emit = (t) => { if (!skip && t) { if (skipChars > 0) { skipChars -= t.length; return; } out.push(t); } };
    while (i < n) {
      const ch = s[i];
      if (ch === '{') { stack.push({ skip, uc }); i++; continue; }
      if (ch === '}') { const st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } i++; continue; }
      if (ch === '\r' || ch === '\n') { i++; continue; }
      if (ch !== '\\') {
        let j = i; while (j < n && s[j] !== '\\' && s[j] !== '{' && s[j] !== '}' && s[j] !== '\r' && s[j] !== '\n') j++;
        emit(s.slice(i, j)); i = j; continue;
      }
      // control sequence
      i++; if (i >= n) break;
      const c = s[i];
      if (c === '\\' || c === '{' || c === '}') { emit(c); i++; continue; }
      if (c === '~') { emit(' '); i++; continue; }
      if (c === '_') { emit('\u2011'); i++; continue; }
      if (c === '-' || c === '|' || c === ':') { i++; continue; }
      if (c === '*') {                                              // ignorable destination
        i++; skip = true; continue;
      }
      if (c === "'") {                                              // \'hh
        const hex = s.substr(i + 1, 2); i += 3;
        const b = parseInt(hex, 16);
        if (!isNaN(b)) emit(byteToChar(b, cp));
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)?[ ]?/.exec(s.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const w = m[1].toLowerCase(), arg = m[2] != null ? parseInt(m[2], 10) : null;
      if (RTF_SKIP.has(w)) { skip = true; continue; }
      if (w === 'fldrslt' || w === 'field') { continue; }
      if (w === 'par' || w === 'sect' || w === 'page') { emit('\n\n'); continue; }
      if (w === 'row') { emit('\n\n'); continue; }
      if (w === 'cell') { emit('\t'); continue; }
      if (w === 'uc') { uc = arg == null ? 1 : arg; continue; }
      if (w === 'u') {
        let code = arg == null ? 0 : arg; if (code < 0) code += 65536;
        if (!skip) out.push(String.fromCharCode(code));
        skipChars = uc;                                             // skip the ANSI fallback that follows
        // fallback may be \'hh (4 chars) or a plain char: consume it now
        for (let k = 0; k < uc; k++) {
          if (s[i] === '\\' && s[i + 1] === "'") i += 4; else if (i < n && s[i] !== '\\' && s[i] !== '{' && s[i] !== '}') i++;
        }
        skipChars = 0;
        continue;
      }
      if (w === 'bin') { i += Math.max(arg || 0, 0); continue; }
      if (Object.prototype.hasOwnProperty.call(RTF_CHAR, w)) { emit(RTF_CHAR[w]); continue; }
    }
    return out.join('');
  }

  // What kind of file is this? (first bytes)
  function sniffFormat(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const head = String.fromCharCode.apply(null, Array.from(b.subarray(0, 8)));
    if (head.indexOf('{\\rtf') === 0) return 'rtf';
    if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return 'ole-doc';      // legacy binary .doc
    if (head.indexOf('PK') === 0) return 'zip';
    if (head.indexOf('%PDF') === 0) return 'pdf';
    return 'text';
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 3. Paragraphs
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // text -> [{ i, text, page, words, chars }]. `pages` optional: array of page texts (paragraphs joined by blank lines).
  function makePara(text, i, page) { const t = clean(text); return { i, text: t, page: page || null, words: countWords(t), chars: t.length }; }

  function hardWrapped(lines) {
    // lines of a PDF / hard-wrapped text file: most lines are short and do not end a sentence
    const ne = lines.filter((l) => l.trim()); if (ne.length < 20) return false;
    const avg = ne.reduce((a, l) => a + l.length, 0) / ne.length;
    const noEnd = ne.filter((l) => !/[.!?:;"'\u201d\u2019\u00bb\u3002\uff01\uff1f)\]]\s*$/.test(l)).length / ne.length;
    return avg < 95 && noEnd > 0.6;
  }
  function paragraphsFromText(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n');
    const blocks = t.split(/\n[ \t]*\n+/).map((b) => b.trim()).filter(Boolean);
    const lines = t.split('\n');
    const nonEmptyLines = lines.filter((l) => l.trim()).length;
    // Blocks are paragraphs when blank lines are the separators (Word/IDML/RTF output) ...
    if (blocks.length >= nonEmptyLines * 0.6) return blocks.map(clean).filter(Boolean);
    // ... otherwise every line is a paragraph, unless the text is hard-wrapped (PDF): then re-join
    if (!hardWrapped(lines)) return lines.map(clean).filter(Boolean);
    const out = []; let cur = '';
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) { if (cur) out.push(cur); cur = ''; continue; }
      cur = cur ? cur + ' ' + l : l;
      if (/[.!?\u3002\uff01\uff1f\u201d"]$/.test(l) && l.length < 60) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out.map(clean).filter(Boolean);
  }
  function parasFromText(text) { return paragraphsFromText(text).map((t, i) => makePara(t, i, null)); }
  function parasFromPages(pageTexts) {
    const out = [];
    (pageTexts || []).forEach((pt, pi) => {
      paragraphsFromText(pt).forEach((t) => out.push(makePara(t, out.length, pi + 1)));
    });
    return out;
  }
  function docStats(paras) {
    const words = paras.reduce((a, p) => a + p.words, 0), chars = paras.reduce((a, p) => a + p.chars, 0);
    return { nParas: paras.length, words, chars };
  }

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // 4. Chapters
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  const KW = '(?:chapter|part|section|book|chap\\.?|\\u0433\\u043b\\u0430\\u0432\\u0430|\\u0431\\u04af\\u043b\\u044d\\u0433|\\u0431\\u0430\\u0433\\u0446|chapitre|cap[i\\u00ed]tulo|capitolo|kapitel|bab|\\u0627\\u0644\\u0641\\u0635\\u0644|\\u0627\\u0644\\u0628\\u0627\\u0628|\\u7b2c)';
  const KW_RE = new RegExp('^\\s*' + KW + '\\s*([0-9\\u0660-\\u0669]{1,3}|[IVXLC]{1,6})\\b\\s*[.:\\-\\u2013\\u2014]?\\s*(.*)$', 'i');
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function romanToInt(r) { let t = 0; const s = r.toUpperCase(); for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]] || 0, nx = ROMAN[s[i + 1]] || 0; t += v < nx ? -v : v; } return t; }
  const arabicIndicToInt = (s) => parseInt(String(s).replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x0660), 10);
  const looksLikeToc = (t) => /\t/.test(t) || /\.{3,}\s*\d+\s*$/.test(t) || /\s\d{1,3}\s*$/.test(t) && /^\s*\d{1,3}\s+\S.{3,}\s\d{1,3}\s*$/.test(t);
  const isTitleLike = (t) => !!t && t.length <= 140 && !/[.!?\u2026]\s*$/.test(t) && countWords(t) <= 20;

  // Candidate chapter headings in a paragraph list: { at, num, title, titleParas, kind }
  function headingCandidates(paras) {
    const out = [];
    for (let k = 0; k < paras.length; k++) {
      const t = paras[k].text;
      if (!t || t.length > 160) continue;
      let m;
      if ((m = /^\s*(\d{1,3})\s*$/.exec(t))) {
        const nxt = paras[k + 1] ? paras[k + 1].text : '';
        const title = isTitleLike(nxt) && !/^\d{1,3}$/.test(nxt) ? nxt : '';
        out.push({ at: k, num: parseInt(m[1], 10), title, titleParas: title ? 1 : 0, kind: 'number', w: title ? 1.6 : 1 });
      } else if ((m = KW_RE.exec(t)) && !looksLikeToc(t)) {
        const num = /^[IVXLC]+$/i.test(m[1]) ? romanToInt(m[1]) : /[\u0660-\u0669]/.test(m[1]) ? arabicIndicToInt(m[1]) : parseInt(m[1], 10);
        let title = clean(m[2]), tp = 0;
        if (!title && paras[k + 1] && isTitleLike(paras[k + 1].text)) { title = paras[k + 1].text; tp = 1; }
        if (num > 0) out.push({ at: k, num, title, titleParas: tp, kind: 'keyword', w: 1.6 });
      } else if ((m = /^\s*(\d{1,2})[.)]\s+(\S.{2,100})$/.exec(t)) && isTitleLike(m[2]) && !looksLikeToc(t)) {
        out.push({ at: k, num: parseInt(m[1], 10), title: m[2], titleParas: 0, kind: 'numbered-title', w: 0.8 });
      }
    }
    return out;
  }
  // Pick the longest believable chapter sequence 1,2,3 ... (stray numbers such as page numbers are ignored)
  function bestSequence(cands) {
    const n = cands.length; if (!n) return [];
    const dp = new Array(n).fill(0), prev = new Array(n).fill(-1);
    let bi = 0;
    for (let j = 0; j < n; j++) {
      dp[j] = cands[j].w + (cands[j].num === 1 ? 1 : 0);
      for (let i = 0; i < j; i++) {
        if (cands[i].num < cands[j].num && cands[i].at < cands[j].at) {
          const gap = cands[j].num - cands[i].num;
          const sc = dp[i] + cands[j].w + (gap === 1 ? 2 : 0.4 / gap);
          if (sc > dp[j]) { dp[j] = sc; prev[j] = i; }
        }
      }
      if (dp[j] > dp[bi]) bi = j;
    }
    const seq = []; for (let k = bi; k !== -1; k = prev[k]) seq.unshift(cands[k]);
    return seq;
  }
  // -> { sections:[{ idx, num, title, start, bodyStart, end, kind }], structured, note }
  // Section 0 (num 0) is the front matter before the first chapter; `end` is exclusive.
  function detectSections(paras) {
    const cands = headingCandidates(paras);
    const seq = bestSequence(cands);
    // a believable chapter list: at least 3 headings and they mostly follow each other
    const consecutive = seq.filter((c, k) => k > 0 && c.num - seq[k - 1].num === 1).length;
    const structured = seq.length >= 3 && consecutive >= (seq.length - 1) * 0.6;
    if (!structured) {
      return { sections: [{ idx: 0, num: 1, title: '', start: 0, bodyStart: 0, end: paras.length, kind: 'whole' }], structured: false,
               note: seq.length ? 'No clear chapter structure (found ' + seq.length + ' possible headings)' : 'No chapter headings found' };
    }
    const sections = [];
    if (seq[0].at > 0) sections.push({ idx: 0, num: 0, title: 'Front matter', start: 0, bodyStart: 0, end: seq[0].at, kind: 'front' });
    seq.forEach((c, k) => {
      const end = k + 1 < seq.length ? seq[k + 1].at : paras.length;
      sections.push({ idx: sections.length, num: c.num, title: c.title, start: c.at, bodyStart: c.at + 1 + c.titleParas, end, kind: c.kind });
    });
    return { sections, structured: true, note: seq.length + ' chapters found' };
  }

  // Pair source and translation sections: by chapter number, else by order, else not at all.
  function matchSections(srcSecs, tgtSecs) {
    const sNums = srcSecs.filter((s) => s.num > 0), tNums = tgtSecs.filter((s) => s.num > 0);
    const out = []; let how = 'number';
    const tByNum = new Map(tNums.map((s) => [s.num, s])), sByNum = new Map(sNums.map((s) => [s.num, s]));
    const common = sNums.filter((s) => tByNum.has(s.num)).length;
    if (sNums.length >= 3 && tNums.length >= 3 && common < Math.min(sNums.length, tNums.length) * 0.6) {
      if (sNums.length === tNums.length) {
        how = 'order';
        sNums.forEach((s, k) => out.push({ num: s.num, label: String(s.num), src: s, tgt: tNums[k] }));
      } else return null;                                          // cannot pair: caller falls back to length alignment
    } else {
      const nums = Array.from(new Set(sNums.map((s) => s.num).concat(tNums.map((s) => s.num)))).sort((a, b) => a - b);
      nums.forEach((nu) => out.push({ num: nu, label: String(nu), src: sByNum.get(nu) || null, tgt: tByNum.get(nu) || null }));
    }
    const sf = srcSecs.find((s) => s.num === 0), tf = tgtSecs.find((s) => s.num === 0);
    if (sf || tf) out.unshift({ num: 0, label: 'Front', src: sf || null, tgt: tf || null });
    return { pairs: out, how };
  }

  global.TC = Object.assign(global.TC || {}, {
    clean, countWords, norm, rtfToText, sniffFormat,
    makePara, paragraphsFromText, parasFromText, parasFromPages, docStats,
    headingCandidates, bestSequence, detectSections, matchSections,
  });

  // ======================================================================
  // 5. Length-based alignment (Gale & Church 1993) - used to cut long chapters / unstructured
  //    documents into windows at points where both sides still line up.
  // ======================================================================
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const BEADS = [[1, 1, 0.89], [1, 0, 0.0099], [0, 1, 0.0099], [2, 1, 0.089], [1, 2, 0.089], [2, 2, 0.011], [3, 1, 0.002], [1, 3, 0.002]];
  // a, b: arrays of paragraph lengths (chars). Returns beads [{ s:[i..], t:[j..], cost }] covering every paragraph once.
  function alignByLength(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return [{ s: a.map((_, i) => i), t: b.map((_, j) => j), cost: 0 }].filter((x) => x.s.length || x.t.length);
    const sumA = a.reduce((x, y) => x + y, 0) || 1, sumB = b.reduce((x, y) => x + y, 0) || 1, c = sumB / sumA, S2 = 6.8 * c;
    const preA = [0], preB = [0]; a.forEach((v) => preA.push(preA[preA.length - 1] + v)); b.forEach((v) => preB.push(preB[preB.length - 1] + v));
    const cost = (di, dj, i, j, prior) => {
      const l1 = preA[i] - preA[i - di], l2 = preB[j] - preB[j - dj];
      let mm = -Math.log(prior);
      if (di && dj) { const delta = (l2 - l1 * c) / Math.sqrt(Math.max(l1, 1) * S2); mm += -Math.log(Math.max(2 * (1 - normCdf(Math.abs(delta))), 1e-9)); }
      else mm += 6;                                               // a paragraph with no counterpart is expensive
      return mm;
    };
    const W = Math.max(25, Math.ceil(0.2 * Math.max(n, m)));
    const lo = (i) => Math.max(0, Math.floor(i * m / n) - W), hi = (i) => Math.min(m, Math.ceil(i * m / n) + W);
    const D = [], BP = [];
    for (let i = 0; i <= n; i++) { const w = hi(i) - lo(i) + 1; D.push(new Float64Array(w).fill(Infinity)); BP.push(new Int8Array(w).fill(-1)); }
    const get = (i, j) => { const l = lo(i); return (j < l || j > hi(i)) ? Infinity : D[i][j - l]; };
    D[0][0 - lo(0)] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = lo(i); j <= hi(i); j++) {
        if (i === 0 && j === 0) continue;
        let best = Infinity, bk = -1;
        for (let k = 0; k < BEADS.length; k++) {
          const di = BEADS[k][0], dj = BEADS[k][1];
          if (i - di < 0 || j - dj < 0) continue;
          const prev = get(i - di, j - dj); if (prev === Infinity) continue;
          const v = prev + cost(di, dj, i, j, BEADS[k][2]);
          if (v < best) { best = v; bk = k; }
        }
        D[i][j - lo(i)] = best; BP[i][j - lo(i)] = bk;
      }
    }
    // trace back
    const beads = []; let i = n, j = m;
    if (get(n, m) === Infinity) return [{ s: a.map((_, x) => x), t: b.map((_, x) => x), cost: Infinity }];
    while (i > 0 || j > 0) {
      const k = BP[i][j - lo(i)]; if (k < 0) break;
      const di = BEADS[k][0], dj = BEADS[k][1];
      const s = [], t = []; for (let x = i - di; x < i; x++) s.push(x); for (let x = j - dj; x < j; x++) t.push(x);
      beads.unshift({ s, t, cost: cost(di, dj, i, j, BEADS[k][2]) });
      i -= di; j -= dj;
    }
    return beads;
  }

  // ======================================================================
  // 6. Windows: one model call each
  // ======================================================================
  const CPT = { latin: 3.2, mid: 1.9, dense: 1.2 };               // characters per token (conservative)
  function scriptClass(lang) {
    const l = String(lang || '').toLowerCase();
    if (/bengali|hindi|tamil|malayalam|telugu|kannada|gujarati|punjabi|marathi|thai|japanese|korean|chinese|mandarin/.test(l)) return 'dense';
    if (/arabic|persian|farsi|urdu|hebrew|russian|mongolian|uzbek|ukrainian|bulgarian|serbian|kazakh|cyrillic/.test(l)) return 'mid';
    return 'latin';
  }
  const tokensOf = (chars, lang) => Math.ceil(chars / CPT[scriptClass(lang)]);

  // pair: { num, label, src: section|null, tgt: section|null }; docs: { paras, lang }
  function windowsForPair(pair, srcDoc, tgtDoc, o) {
    o = o || {};
    const maxTok = o.maxWindowTokens || 7000, maxParas = o.maxParas || 80;
    const sp = pair.src ? srcDoc.paras.slice(pair.src.start, pair.src.end) : [];
    const tp = pair.tgt ? tgtDoc.paras.slice(pair.tgt.start, pair.tgt.end) : [];
    const title = (pair.tgt && pair.tgt.title) || (pair.src && pair.src.title) || '';
    const base = pair.num === 0 ? 'Front matter' : (pair.label === 'All' ? 'Whole document' : 'Chapter ' + pair.num + (pair.src && pair.src.title ? ' - ' + pair.src.title : ''));
    const mk = (s0, s1, t0, t1, part, parts) => {
      const src = sp.slice(s0, s1), tgt = tp.slice(t0, t1);
      const chars = src.reduce((x, p) => x + p.chars, 0), tchars = tgt.reduce((x, p) => x + p.chars, 0);
      return { id: 's' + pair.num + (parts > 1 ? '-' + part : ''), num: pair.num, label: base + (parts > 1 ? ' (part ' + part + ' of ' + parts + ')' : ''), part, parts, src, tgt,
               srcWords: src.reduce((x, p) => x + p.words, 0), tgtWords: tgt.reduce((x, p) => x + p.words, 0),
               srcBase: pair.src ? pair.src.bodyStart : 0, tgtBase: pair.tgt ? pair.tgt.bodyStart : 0,
               estTokens: tokensOf(chars, srcDoc.lang) + tokensOf(tchars, tgtDoc.lang), title };
    };
    if (!sp.length || !tp.length) return [mk(0, sp.length, 0, tp.length, 1, 1)];
    const tokAll = tokensOf(sp.reduce((x, p) => x + p.chars, 0), srcDoc.lang) + tokensOf(tp.reduce((x, p) => x + p.chars, 0), tgtDoc.lang);
    if (tokAll <= maxTok && sp.length <= maxParas && tp.length <= maxParas) return [mk(0, sp.length, 0, tp.length, 1, 1)];
    // too big: cut at well-aligned points
    const beads = alignByLength(sp.map((p) => p.chars), tp.map((p) => p.chars));
    const k = Math.max(Math.ceil(tokAll / maxTok), Math.ceil(Math.max(sp.length, tp.length) / maxParas));
    const tokOfBead = (bd) => tokensOf(bd.s.reduce((x, i) => x + sp[i].chars, 0), srcDoc.lang) + tokensOf(bd.t.reduce((x, j) => x + tp[j].chars, 0), tgtDoc.lang);
    const cum = []; let acc = 0; beads.forEach((bd) => { acc += tokOfBead(bd); cum.push(acc); });
    const cuts = [];                                                       // bead indexes after which to cut
    for (let q = 1; q < k; q++) {
      const target = tokAll * q / k; let best = -1, bs = Infinity;
      for (let bi = 0; bi < beads.length - 1; bi++) {
        if (cuts.length && bi <= cuts[cuts.length - 1]) continue;
        const dist = Math.abs(cum[bi] - target) / tokAll * 10 + (beads[bi].s.length === 1 && beads[bi].t.length === 1 ? 0 : 1) + Math.min(beads[bi].cost, 8) / 8;
        if (cum[bi] > target * 0.7 && cum[bi] < target * 1.3 && dist < bs) { bs = dist; best = bi; }
      }
      if (best >= 0) cuts.push(best);
    }
    const out = []; let s0 = 0, t0 = 0, bPrev = 0;
    const parts = cuts.length + 1;
    cuts.concat([beads.length - 1]).forEach((bi, pi) => {
      let s1 = s0, t1 = t0;
      for (let x = bPrev; x <= bi; x++) { if (beads[x].s.length) s1 = beads[x].s[beads[x].s.length - 1] + 1; if (beads[x].t.length) t1 = beads[x].t[beads[x].t.length - 1] + 1; }
      out.push(mk(s0, s1, t0, t1, pi + 1, parts)); s0 = s1; t0 = t1; bPrev = bi + 1;
    });
    return out;
  }

  // Everything: sections for both docs -> { windows, structure }
  function planWindows(srcDoc, tgtDoc, o) {
    o = o || {};
    const sd = detectSections(srcDoc.paras), td = detectSections(tgtDoc.paras);
    let pairs = null, how = 'whole';
    if (sd.structured && td.structured) {
      const m = matchSections(sd.sections, td.sections);
      if (m) { pairs = m.pairs; how = m.how; }
    }
    const repairs = [];
    if (pairs && how === 'number') repairGaps(pairs, srcDoc, tgtDoc, sd, td, repairs);
    if (!pairs) {
      pairs = [{ num: 1, label: 'All', src: { start: 0, bodyStart: 0, end: srcDoc.paras.length, num: 1, title: '' }, tgt: { start: 0, bodyStart: 0, end: tgtDoc.paras.length, num: 1, title: '' } }];
      how = 'length';
    }
    const only = o.onlySections && o.onlySections.length ? new Set(o.onlySections.map(Number)) : null;
    const windows = []; const structural = [];
    pairs.forEach((p) => {
      if (only && !only.has(p.num)) return;
      if (!p.src && p.tgt) { structural.push({ kind: 'added-section', pair: p }); windows.push(...windowsForPair(p, srcDoc, tgtDoc, o)); return; }
      if (p.src && !p.tgt) { structural.push({ kind: 'missing-section', pair: p }); windows.push(...windowsForPair(p, srcDoc, tgtDoc, o)); return; }
      windows.push(...windowsForPair(p, srcDoc, tgtDoc, o));
    });
    // chapters whose length is far from the book's usual translation ratio (possible boundary problem)
    const rs = windows.filter((w) => w.src.length && w.tgt.length && w.part === 1 && w.srcWords >= 150).map((w) => w.tgtWords / w.srcWords);
    const med = median(rs);
    if (med > 0) windows.forEach((w) => {
      if (w.src.length && w.tgt.length && w.srcWords >= 150) { const r = (w.tgtWords / w.srcWords) / med; if (r > 1.9 || r < 0.5) w.suspect = { ratio: r }; }
    });
    return { windows, pairs, how, structural, repairs, srcSections: sd, tgtSections: td };
  }
  // A chapter that has no partner although its neighbours do: look for a stray number heading in the gap (a mistyped chapter number).
  function repairGaps(pairs, srcDoc, tgtDoc, sd, td, repairs) {
    const docs = { src: { doc: srcDoc, secs: sd.sections }, tgt: { doc: tgtDoc, secs: td.sections } };
    const cands = { src: headingCandidates(srcDoc.paras).filter((c) => c.kind === 'number'), tgt: headingCandidates(tgtDoc.paras).filter((c) => c.kind === 'number') };
    ['tgt', 'src'].forEach((side) => {
      const other = side === 'tgt' ? 'src' : 'tgt';
      pairs.forEach((p, k) => {
        if (!p[other] || p[side] || p.num === 0) return;                           // only: other side has the chapter, this side lacks it
        let a = null, b = null;
        for (let x = k - 1; x >= 0; x--) if (pairs[x][side]) { a = pairs[x]; break; }
        for (let x = k + 1; x < pairs.length; x++) if (pairs[x][side]) { b = pairs[x]; break; }
        if (!a || !b) return;
        const lo = a[side].bodyStart, hi = b[side].start;
        const hit = cands[side].find((c) => c.at >= lo && c.at < hi && c.at > a[side].start);
        if (!hit) return;
        const t0 = a[side].end; a[side].end = hit.at;
        p[side] = { idx: -1, num: p.num, title: hit.title, start: hit.at, bodyStart: hit.at + 1 + hit.titleParas, end: t0, kind: 'repaired' };
        repairs.push({ side, num: p.num, found: hit.num, at: hit.at });
        void docs;
      });
    });
  }

  // ======================================================================
  // 7. Prompts
  // ======================================================================
  const TYPES = ['Omission', 'Addition', 'Mistranslation', 'Number', 'Terminology', 'Untranslated', 'Structure'];
  const SEVERITIES = ['Critical', 'Major', 'Minor', 'Query'];
  const SEV_WEIGHT = { Critical: 10, Major: 5, Minor: 1, Query: 0 };
  const TYPE_ALIAS = { omission: 'Omission', omitted: 'Omission', missing: 'Omission', addition: 'Addition', added: 'Addition', insertion: 'Addition',
    mistranslation: 'Mistranslation', mistranslated: 'Mistranslation', meaning: 'Mistranslation', accuracy: 'Mistranslation', 'wrong translation': 'Mistranslation',
    number: 'Number', numbers: 'Number', numeric: 'Number', date: 'Number', 'number/date': 'Number', terminology: 'Terminology', term: 'Terminology', name: 'Terminology', 'proper noun': 'Terminology',
    untranslated: 'Untranslated', structure: 'Structure', consistency: 'Terminology' };

  function systemPrompt(o) {
    const sl = o.srcLang || 'the source language', tl = o.tgtLang || 'the translation language';
    return `You are a senior translation reviewer: a professional ${sl} to ${tl} translator and editor checking a published translation against its original. Compare the SOURCE (${sl}) with the TRANSLATION (${tl}) paragraph by paragraph.

You receive numbered paragraphs: [S1], [S2] ... are the source; [T1], [T2] ... are the translation. Do two things.

1) ALIGNMENT. Match every source paragraph with the translation paragraph(s) that translate it. A translator or the layout may merge or split paragraphs, so groups can be 1 to 1, 1 to many, or many to 1. Return "alignment" as a list of strings "S|T" where S and T are comma-separated numbers or ranges, in document order:
   "1|1"  "2|2,3"  "4-6|4-5"  "7|"  "|8"
   A source paragraph with NO counterpart in the translation is written "7|" (omitted). A translation paragraph with NO counterpart in the source is written "|8" (added). EVERY source paragraph [S#] and EVERY translation paragraph [T#] must appear exactly once. Do not mark a paragraph as omitted or added if its content appears elsewhere in the translation: pair it instead.

2) ISSUES. Report real translation problems only:
   - Omission: source content (a sentence, clause, name, qualifier or number) is missing in the translation.
   - Addition: the translation contains content that is not in the source.
   - Mistranslation: the meaning differs, is reversed, or is wrong (wrong word sense, wrong subject or object, wrong tense that changes the facts, a negation lost).
   - Number: a number, date, time, quantity, unit or currency differs from the source.
   - Terminology: a key term, title or proper name is translated wrongly or inconsistently inside this text.
   - Untranslated: text that should be translated was left in the source language.
   Severity: Critical = a whole sentence or more is missing or added, the meaning is reversed, or a number, date or name that matters is wrong. Major = the meaning is clearly changed or part of a sentence is missing or added, or a key term is wrong. Minor = small loss of nuance or a slightly inaccurate word that does not change the message. Query = you suspect a problem but are not sure (about 70 percent). Prefer Query to guessing.

DO NOT report: spelling, grammar or punctuation of the translation (a separate proofreading handles that), style or word-order choices, idioms that are correctly rendered, reasonable transliteration of names, added explanations that are harmless, differences caused only by layout, hyphenation, headings or page furniture. The translation may be a typeset book: running headers, page numbers, and pull-quotes that repeat a sentence from the body are layout, not additions (pair a repeated sentence with the text it repeats, or list it as "|n" without reporting an issue). Do not invent problems. If everything is fine return an empty "issues" list.

For every issue give: "type", "severity", "s" (source paragraph numbers), "t" (translation paragraph numbers; for an omission use the translation paragraph the missing text belongs after, or [] if unknown), "source" (the exact source words, verbatim, at most 30 words), "target" (the exact translation words, verbatim from the [T#] text, at most 30 words; use "" for an omission), "fix" (the corrected or missing text written in ${tl}; keep it short; "" if you cannot), and "why" (one plain English sentence that starts with the problem).
Quote exactly: copy "source" and "target" character for character from the text you were given.

Return ONLY valid JSON, no markdown:
{"alignment":["1|1","2|2,3","3|"],"issues":[{"type":"Omission","severity":"Critical","s":[3],"t":[2],"source":"...","target":"","fix":"...","why":"..."}]}${o.extra ? '\n\nAdditional instructions from the editor:\n' + o.extra : ''}`;
  }
  function userPrompt(win, o) {
    const sl = o.srcLang || 'source', tl = o.tgtLang || 'translation';
    const fmt = (arr, tag) => arr.map((p, k) => '[' + tag + (k + 1) + '] ' + p.text).join('\n');
    return `${win.label}${win.title ? '' : ''}\n\nSOURCE (${sl}): ${win.src.length} paragraphs\n${fmt(win.src, 'S')}\n\nTRANSLATION (${tl}): ${win.tgt.length} paragraphs\n${fmt(win.tgt, 'T')}`;
  }
  function verifySystemPrompt(o) {
    const sl = o.srcLang || 'the source language', tl = o.tgtLang || 'the translation language';
    return `You double-check possible translation defects between ${sl} (source) and ${tl} (translation). For each numbered claim decide whether it is TRUE by searching the whole text you are given.
- For an OMISSION claim: the quoted source passage supposedly has no counterpart. Search the entire translation; if the same content appears anywhere (even reworded, merged into another paragraph or moved) the claim is false.
- For an ADDITION claim: the quoted translation passage supposedly has no counterpart. Search the entire source; if the same content appears anywhere, the claim is false.
Answer "confirmed" only when you are sure the content is really absent. Answer "false_alarm" when the content is present (say where in "note"). Answer "unsure" otherwise.
Return ONLY valid JSON: {"verdicts":[{"id":1,"verdict":"confirmed|false_alarm|unsure","note":"short"}]}`;
  }
  function verifyUserPrompt(win, items, o) {
    const fmt = (arr, tag) => arr.map((p, k) => '[' + tag + (k + 1) + '] ' + p.text).join('\n');
    return `${win.label}\n\nFULL SOURCE:\n${fmt(win.src, 'S')}\n\nFULL TRANSLATION:\n${fmt(win.tgt, 'T')}\n\nCLAIMS TO CHECK:\n` +
      items.map((it) => it.n + '. ' + it.type.toUpperCase() + ' - ' + (it.type === 'Omission' ? 'source ' + it.refs + ' has no counterpart: "' + it.text + '"' : 'translation ' + it.refs + ' has no counterpart: "' + it.text + '"')).join('\n');
  }

  // ======================================================================
  // 8. Reading the model's answer (strict)
  // ======================================================================
  function parseSide(str, max) {
    const out = [];
    String(str || '').split(',').forEach((tok) => {
      const t = tok.trim(); if (!t) return;
      const m = /^(\d+)\s*(?:-|\u2013|\.\.)\s*(\d+)$/.exec(t);
      if (m) { const a = +m[1], b = +m[2]; for (let x = a; x <= b && x <= max; x++) if (x >= 1) out.push(x); }
      else if (/^\d+$/.test(t)) { const v = +t; if (v >= 1) out.push(v); }
    });
    return out;
  }
  // -> { groups:[{s:[1-based], t:[1-based]}], missingS, missingT, dupS, dupT, badRange }
  function parseAlignment(list, nS, nT) {
    const groups = [], seenS = new Map(), seenT = new Map(); let bad = 0;
    (Array.isArray(list) ? list : []).forEach((g) => {
      const str = typeof g === 'string' ? g : (g && typeof g === 'object' ? (Array.isArray(g.s) ? g.s.join(',') : g.s || '') + '|' + (Array.isArray(g.t) ? g.t.join(',') : g.t || '') : '');
      const parts = str.split('|'); if (parts.length !== 2) { bad++; return; }
      const s = parseSide(parts[0], nS + 5), t = parseSide(parts[1], nT + 5);
      if (!s.length && !t.length) return;
      if (s.some((x) => x > nS) || t.some((x) => x > nT)) bad++;
      const gs = s.filter((x) => x <= nS), gt = t.filter((x) => x <= nT);
      gs.forEach((x) => seenS.set(x, (seenS.get(x) || 0) + 1)); gt.forEach((x) => seenT.set(x, (seenT.get(x) || 0) + 1));
      groups.push({ s: gs, t: gt });
    });
    const missingS = [], missingT = [], dupS = [], dupT = [];
    for (let i = 1; i <= nS; i++) { if (!seenS.has(i)) missingS.push(i); else if (seenS.get(i) > 1) dupS.push(i); }
    for (let j = 1; j <= nT; j++) { if (!seenT.has(j)) missingT.push(j); else if (seenT.get(j) > 1) dupT.push(j); }
    return { groups, missingS, missingT, dupS, dupT, bad, complete: !missingS.length && !missingT.length };
  }

  function canonType(t) { const k = String(t || '').trim().toLowerCase(); return TYPE_ALIAS[k] || (TYPES.find((x) => x.toLowerCase() === k)) || 'Mistranslation'; }
  function canonSeverity(s) {
    const k = String(s || '').trim().toLowerCase();
    if (k === 'critical') return 'Critical'; if (k === 'major' || k === 'moderate' || k === 'high') return 'Major';
    if (k === 'minor' || k === 'low') return 'Minor'; if (k === 'query' || k === 'unsure') return 'Query';
    return 'Query';
  }
  const asIdx = (v, max) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= max);

  // find `quote` inside `text` (tolerant of quote style / spacing); returns the exact substring of text, or null
  function findQuote(text, quote) {
    const q = clean(quote); if (!q) return null;
    const i0 = text.indexOf(q); if (i0 >= 0) return text.substr(i0, q.length);
    const nt = norm(text), nq = norm(q); const j = nt.indexOf(nq);
    if (j >= 0 && nt.length === text.length) return text.substr(j, nq.length);            // same offsets after normalisation
    if (j >= 0) {                                                                             // lengths differ: map by word boundaries
      const words = text.split(' '), nw = nq.split(' '); let pos = 0;
      for (let w = 0; w + nw.length <= words.length; w++) {
        const cand = norm(words.slice(w, w + nw.length).join(' ')); if (cand === nq) return words.slice(w, w + nw.length).join(' ');
        pos += words[w].length + 1;
      }
    }
    return null;
  }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trim() + '...' : s; };
  const labelPara = (p, base) => { const k = p.i - base + 1; return k >= 1 ? '\u00b6' + k : 'heading'; };

  // The translation paragraph that comes just before where source paragraph `sFirst` should be (1-based), from the alignment.
  function anchorBefore(groups, sFirst) {
    let lastT = 0;
    for (const g of groups) {
      if (g.s.indexOf(sFirst) >= 0) return lastT;
      if (g.t.length) lastT = g.t[g.t.length - 1];
    }
    return lastT;
  }
  // Turn the model's JSON into canonical issues for one window.
  function readAnswer(win, ans) {
    const nS = win.src.length, nT = win.tgt.length;
    const al = parseAlignment(ans && ans.alignment, nS, nT);
    const issues = [];
    (ans && Array.isArray(ans.issues) ? ans.issues : []).forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const type = canonType(it.type), sev = canonSeverity(it.severity);
      const s = asIdx(it.s, nS), t = asIdx(it.t, nT);
      let sText = clean(it.source), tText = clean(it.target);
      const sPara = s.map((k) => win.src[k - 1]), tPara = t.map((k) => win.tgt[k - 1]);
      // quotes must really exist in the paragraphs they claim to come from
      let sOk = true, tOk = true;
      if (sText) { const hay = sPara.length ? sPara.map((p) => p.text).join(' ') : win.src.map((p) => p.text).join(' '); const f = findQuote(hay, sText); if (f) sText = f; else sOk = false; }
      if (tText) { const hay = tPara.length ? tPara.map((p) => p.text).join(' ') : win.tgt.map((p) => p.text).join(' '); const f = findQuote(hay, tText); if (f) tText = f; else tOk = false; }
      if (type !== 'Omission' && !s.length && !t.length) return;                              // cannot be located: ignore
      let why = clean(it.why), sevOut = sev;
      if (!sOk || !tOk) { sevOut = 'Query'; why = (why ? why + ' ' : '') + '(The quoted words could not be found verbatim in the text, so please check this one by hand.)'; }
      if (type === 'Omission' && s.length) { const a = anchorBefore(al.groups, s[0]); t.length = 0; if (a > 0) t.push(a); }   // where it belongs comes from the alignment, not from the model's guess
      issues.push({ type, severity: sevOut, s, t, sText, tText, sOk, tOk, fix: clean(it.fix), why, origin: 'ai' });
    });
    return { alignment: al, issues };
  }

  // ======================================================================
  // 9. Rule-based checks (no AI): numbers, untranslated text, length outliers
  // ======================================================================
  function numbersIn(text) {
    let t = String(text || '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
    t = t.replace(/(\d)[,\u00a0\u202f '](?=\d{3}(?!\d))/g, '$1').replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
    const set = new Set(); (t.match(/\d+(?:\.\d+)?/g) || []).forEach((x) => { if (x.length >= 2 || x.indexOf('.') >= 0) set.add(String(parseFloat(x))); });
    return set;
  }
  const tokensOfText = (s) => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i); }
  const median = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // groups: model alignment groups (1-based). `have` = issue keys already reported, to avoid duplicates.
  function ruleChecks(win, groups, o) {
    const out = [];
    const flaggedGroup = (g) => (o.have || []).some((x) => x.s.some((v) => g.s.indexOf(v) >= 0) && x.t.some((v) => g.t.indexOf(v) >= 0)) || (o.have || []).some((x) => x.s.length && x.s.every((v) => g.s.indexOf(v) >= 0) && g.s.length && !g.t.length);
    const ratios = [];
    groups.forEach((g) => {
      if (!g.s.length || !g.t.length) return;
      const sc = g.s.reduce((a, k) => a + win.src[k - 1].chars, 0), tc = g.t.reduce((a, k) => a + win.tgt[k - 1].chars, 0);
      if (sc >= 60) ratios.push(tc / sc);
    });
    const med = median(ratios);
    groups.forEach((g) => {
      if (!g.s.length || !g.t.length) return;
      const sText = g.s.map((k) => win.src[k - 1].text).join(' '), tText = g.t.map((k) => win.tgt[k - 1].text).join(' ');
      if (flaggedGroup(g)) return;
      // numbers: only a number that changed, or a large one (year, amount) that vanished; never in front matter (ISBNs, phone numbers, addresses)
      const sig = (set) => new Set([...set].filter((x) => String(x).replace('.', '').length < 7));
      const ns = sig(numbersIn(sText)), nt = sig(numbersIn(tText));
      const miss = [...ns].filter((x) => !nt.has(x)), extra = [...nt].filter((x) => !ns.has(x));
      if (win.num !== 0 && ((miss.length && extra.length) || miss.some((v) => +v >= 1000))) {
        out.push({ type: 'Number', severity: 'Query', s: g.s.slice(), t: g.t.slice(), sText: '', tText: '', sOk: true, tOk: true, fix: '',
          why: (miss.length ? 'Number' + (miss.length > 1 ? 's' : '') + ' ' + miss.slice(0, 4).join(', ') + ' in the source ' + (miss.length > 1 ? 'are' : 'is') + ' not in the translation' : '') +
               (miss.length && extra.length ? '; ' : '') + (extra.length ? 'number' + (extra.length > 1 ? 's' : '') + ' ' + extra.slice(0, 4).join(', ') + ' in the translation ' + (extra.length > 1 ? 'are' : 'is') + ' not in the source' : '') + '.', origin: 'rule' });
      }
      // untranslated: translation is (nearly) a copy of the source
      const sw = countWords(sText);
      if (sw >= 6) {
        const sim = jaccard(tokensOfText(sText), tokensOfText(tText));
        if (sim >= 0.85) out.push({ type: 'Untranslated', severity: 'Query', s: g.s.slice(), t: g.t.slice(), sText: '', tText: '', sOk: true, tOk: true, fix: '',
          why: 'The translation is (almost) identical to the source text, so it may have been left untranslated.', origin: 'rule' });
      }
      // length outlier
      const sc = sText.length, tc = tText.length;
      if (med > 0 && sc >= 150) {
        const r = tc / sc;
        if (r < med * 0.45) out.push({ type: 'Omission', severity: 'Query', s: g.s.slice(), t: g.t.slice(), sText: '', tText: '', sOk: true, tOk: true, fix: '',
          why: 'The translation is much shorter than this source passage (' + Math.round(r / med * 100) + '% of the usual length), so part of it may be missing.', origin: 'rule' });
        else if (r > med * 2.3) out.push({ type: 'Addition', severity: 'Query', s: g.s.slice(), t: g.t.slice(), sText: '', tText: '', sOk: true, tOk: true, fix: '',
          why: 'The translation is much longer than this source passage (' + Math.round(r / med * 100) + '% of the usual length), so something may have been added.', origin: 'rule' });
      }
    });
    return out;
  }

  // ======================================================================
  // 10. Scoring (fixed rubric): Critical 10 / Major 5 / Minor 1 / Query 0;
  //     score = 100 - 4 x penalty per 1000 source words.
  //     Pass: score >= 90 and no Critical. Revise: 75-89, or any Critical. Fail: below 75.
  // ======================================================================
  function scoreOf(issues, words) {
    const counts = { Critical: 0, Major: 0, Minor: 0, Query: 0 };
    let penalty = 0;
    issues.forEach((i) => { if (counts[i.severity] !== undefined) { counts[i.severity]++; penalty += SEV_WEIGHT[i.severity]; } });
    const per1000 = words > 0 ? penalty / (words / 1000) : 0;
    const value = Math.max(0, Math.min(100, Math.round(100 - 4 * per1000)));
    const verdict = value < 75 ? 'Fail' : (value < 90 || counts.Critical > 0) ? 'Revise' : 'Pass';
    return { value, verdict, penalty, per1000: Math.round(per1000 * 100) / 100, counts, words };
  }

  Object.assign(global.TC, {
    alignByLength, windowsForPair, planWindows, tokensOf, scriptClass,
    TYPES, SEVERITIES, SEV_WEIGHT, systemPrompt, userPrompt, verifySystemPrompt, verifyUserPrompt,
    parseAlignment, readAnswer, findQuote, canonType, canonSeverity, numbersIn, jaccard, ruleChecks, scoreOf, labelPara, clip,
  });

  // ======================================================================
  // 11. Running the check (the model call itself is injected, so this is testable offline)
  // ======================================================================
  // Tolerant JSON reader: strips code fences / chatter, then parses the outermost {...}
  function parseJSONLoose(raw) {
    let t = String(raw || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no JSON object in the answer');
    return JSON.parse(t.slice(a, b + 1));
  }

  function estimateRun(plan, o) {
    o = o || {};
    let inTok = 0, outTok = 0, calls = 0;
    const sys = 1900;                                               // system prompt (cached after the first call)
    plan.windows.forEach((w) => {
      if (!w.src.length || !w.tgt.length) return;
      const n = w.src.length + w.tgt.length;
      calls++; inTok += w.estTokens + 60 + (calls === 1 ? sys : 0); outTok += 150 + 9 * n + 170 * Math.max(1, Math.round(w.src.length / 8));
      calls += 0.25; inTok += 0.25 * (w.estTokens + sys); outTok += 0.25 * 220;                 // verification of omissions / additions
    });
    return { windows: plan.windows.length, calls: Math.ceil(calls), inTok: Math.round(inTok), outTok: Math.round(outTok) };
  }

  function halve(win, srcDoc, tgtDoc, o) {
    // cut a window in two at the best-aligned point near the middle
    if (win.src.length < 6 || win.tgt.length < 6) return null;
    const beads = alignByLength(win.src.map((p) => p.chars), win.tgt.map((p) => p.chars));
    if (beads.length < 3) return null;
    const tot = win.src.reduce((x, p) => x + p.chars, 0) + win.tgt.reduce((x, p) => x + p.chars, 0);
    let acc = 0, best = -1, bs = Infinity;
    beads.forEach((bd, bi) => {
      acc += bd.s.reduce((x, i) => x + win.src[i].chars, 0) + bd.t.reduce((x, j) => x + win.tgt[j].chars, 0);
      if (bi < beads.length - 1) { const d = Math.abs(acc - tot / 2) / tot + (bd.s.length === 1 && bd.t.length === 1 ? 0 : 0.1); if (d < bs) { bs = d; best = bi; } }
    });
    if (best < 0) return null;
    let s1 = 0, t1 = 0; for (let x = 0; x <= best; x++) { if (beads[x].s.length) s1 = beads[x].s[beads[x].s.length - 1] + 1; if (beads[x].t.length) t1 = beads[x].t[beads[x].t.length - 1] + 1; }
    if (s1 <= 0 || t1 <= 0 || s1 >= win.src.length || t1 >= win.tgt.length) return null;
    const mk = (src, tgt, tag) => Object.assign({}, win, { id: win.id + tag, label: win.label + (/\(part/.test(win.label) ? '' : '') , src, tgt,
      srcWords: src.reduce((x, p) => x + p.words, 0), tgtWords: tgt.reduce((x, p) => x + p.words, 0), split: true });
    return [mk(win.src.slice(0, s1), win.tgt.slice(0, t1), 'a'), mk(win.src.slice(s1), win.tgt.slice(t1), 'b')];
  }

  const paraRange = (list, base) => {
    if (!list.length) return '';
    const l = list.map((p) => labelPara(p, base)).filter((x, i, a) => a.indexOf(x) === i);
    return l.length > 2 ? l[0] + '-' + l[l.length - 1].replace('\u00b6', '') : l.join(', ');
  };

  // Final issue objects (locations, excerpts) from one window's raw issues
  function finishIssues(win, raws, o) {
    const chap = win.num > 0 ? 'Ch ' + win.num : (win.label === 'Whole document' ? '' : 'Front');
    return raws.map((r) => {
      const sP = r.s.map((k) => win.src[k - 1]).filter(Boolean), tP = r.t.map((k) => win.tgt[k - 1]).filter(Boolean);
      const insert = r.type === 'Omission' || (!tP.length && !r.tText);
      const anchor = tP.length ? tP[0] : null;
      const page = (anchor && anchor.page) || ((tP.find((p) => p.page) || {}).page) || null;
      const sRange = paraRange(sP, win.srcBase), tRange = paraRange(tP, win.tgtBase);
      const pre = chap ? chap + ' ' : '';
      return {
        type: r.type, severity: r.severity, origin: r.origin, window: win.id, chapter: win.num, chapterTitle: win.title || '',
        srcLoc: sRange ? pre + sRange : (chap || ''), tgtLoc: tRange ? (insert && r.type === 'Omission' ? 'after ' : '') + pre + tRange : (insert && r.type === 'Omission' ? 'near start of ' + (chap || 'text') : (chap || '')), page,
        srcText: r.sText || '', srcContext: sP.length ? clip(sP.map((p) => p.text).join(' '), 600) : '',
        tgtText: r.tText || '', tgtContext: tP.length ? clip(tP.map((p) => p.text).join(' '), 400) : '',
        fix: r.fix || '', why: r.why || '', insert: !!insert, quoteOk: r.sOk !== false && r.tOk !== false,
        verified: r.verified || null, note: r.note || '', sIdx: sP.map((p) => p.i), tIdx: tP.map((p) => p.i),
      };
    });
  }

  // state: { done: {windowId: result}, windows: [...] } survives errors so the run can continue.
  // ctx: { callModel(system, user, meta) -> { text, inTok, outTok, truncated }, onProgress(info), shouldStop(), srcLang, tgtLang, extra,
  //        sameScript, maxDepth }
  async function checkWindows(plan, srcDoc, tgtDoc, ctx, state) {
    state = state || { done: {}, results: [], inTok: 0, outTok: 0, calls: 0, splits: 0, verifyCalls: 0 };
    state.stopped = false; state.finished = false;                    // a continued run starts clean
    const o = { srcLang: ctx.srcLang, tgtLang: ctx.tgtLang, extra: ctx.extra, sameScript: ctx.sameScript };
    const system = systemPrompt(o), vsystem = verifySystemPrompt(o);
    const maxDepth = ctx.maxDepth == null ? 3 : ctx.maxDepth;

    async function ask(sys, user, meta) {
      const r = await ctx.callModel(sys, user, meta);
      state.inTok += r.inTok || 0; state.outTok += r.outTok || 0; state.calls++;
      return r;
    }

    async function doWindow(win, depth) {
      // chapters that exist on one side only need no model call
      if (!win.src.length || !win.tgt.length) {
        return { win, ledger: { s: win.src.map((p) => p.i), t: win.tgt.map((p) => p.i), unverifiedS: [], unverifiedT: [] }, raws: [], groups: [], dropped: [], rule: true };
      }
      let parsed = null, ans = null, note = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const user = userPrompt(win, o) + (note ? '\n\nIMPORTANT: ' + note : '');
        let r;
        try { r = await ask(system, user, { win, attempt, kind: 'check' }); }
        catch (e) {
          if (e && (e.policy || /policy/i.test(e.message || '')) && depth < maxDepth) { const h = halve(win, srcDoc, tgtDoc, o); if (h) return await both(h, depth); }
          throw e;
        }
        if (r.truncated) {
          const h = depth < maxDepth ? halve(win, srcDoc, tgtDoc, o) : null;
          if (h) { state.splits++; return await both(h, depth); }
        }
        try { ans = parseJSONLoose(r.text); } catch (e) { if (attempt < 2) { note = 'Return ONLY the JSON object, nothing else.'; continue; } throw new Error('The model did not return valid JSON for ' + win.label); }
        parsed = readAnswer(win, ans);
        if (parsed.alignment.complete) break;
        if (attempt === 0 || attempt === 1) {
          const ms = parsed.alignment.missingS.map((x) => 'S' + x), mt = parsed.alignment.missingT.map((x) => 'T' + x);
          note = 'Your alignment did not include ' + ms.concat(mt).slice(0, 12).join(', ') + '. List every source and translation paragraph exactly once.';
          if (attempt === 1 && depth < maxDepth && win.src.length >= 12) { const h = halve(win, srcDoc, tgtDoc, o); if (h) { state.splits++; return await both(h, depth); } }
        }
      }
      const al = parsed.alignment;
      const unS = al.missingS.map((k) => win.src[k - 1].i), unT = al.missingT.map((k) => win.tgt[k - 1].i);
      const raws = parsed.issues.slice();
      const groups = al.groups;
      // omitted / added paragraphs the model listed without describing them: make sure they appear as issues
      groups.forEach((g) => {
        if (g.s.length && !g.t.length && !raws.some((x) => x.type === 'Omission' && g.s.some((k) => x.s.indexOf(k) >= 0))) {
          const words = g.s.reduce((a, k) => a + win.src[k - 1].words, 0);
          const an = anchorBefore(groups, g.s[0]);
          if (words >= 3) raws.push({ type: 'Omission', severity: words >= 12 ? 'Critical' : 'Major', s: g.s.slice(), t: an > 0 ? [an] : [], sText: '', tText: '', sOk: true, tOk: true, fix: '', why: 'This source paragraph has no counterpart in the translation.', origin: 'ai' });
        }
        if (g.t.length && !g.s.length && !raws.some((x) => x.type === 'Addition' && g.t.some((k) => x.t.indexOf(k) >= 0))) {
          const words = g.t.reduce((a, k) => a + win.tgt[k - 1].words, 0);
          if (words >= 6) raws.push({ type: 'Addition', severity: 'Query', s: [], t: g.t.slice(), sText: '', tText: '', sOk: true, tOk: true, fix: '', why: 'This translation paragraph has no counterpart in the source. It may be added text, or layout text such as a caption or pull-quote.', origin: 'ai' });
        }
      });
      // Safety valve: when most paragraphs have no counterpart the two texts are not lined up
      // (wrong chapter boundary, a rewritten chapter ...). Say so once instead of listing dozens of bogus issues.
      let collapsed = null;
      const oS = groups.filter((g) => g.s.length && !g.t.length).reduce((a, g) => a + g.s.length, 0), aT = groups.filter((g) => g.t.length && !g.s.length).reduce((a, g) => a + g.t.length, 0);
      if (oS + aT > Math.max(6, 0.4 * (win.src.length + win.tgt.length) / 2 * 1.0)) {
        collapsed = { omitted: oS, added: aT };
        for (let q = raws.length - 1; q >= 0; q--) if (raws[q].type === 'Omission' || raws[q].type === 'Addition') raws.splice(q, 1);
        raws.push({ type: 'Structure', severity: 'Major', s: [], t: [], sText: '', tText: '', sOk: true, tOk: true, fix: '', origin: 'ai', collapsed: true,
          why: oS + ' source paragraph' + (oS === 1 ? '' : 's') + ' and ' + aT + ' translation paragraph' + (aT === 1 ? '' : 's') + ' have no counterpart, so this part of the translation does not line up with the source (a wrong chapter boundary, or heavily rewritten text). Check this part by hand.' });
      }
      // rule-based checks on top of the model's alignment
      const rules = collapsed ? [] : ruleChecks(win, groups, { have: raws, sameScript: ctx.sameScript });
      // second look at every omission / addition the model claimed
      const dropped = [];
      const claims = collapsed ? [] : raws.filter((x) => x.origin === 'ai' && (x.type === 'Omission' || x.type === 'Addition') && (x.s.length || x.t.length)).slice(0, 14);
      if (claims.length) {
        const items = claims.map((c, k) => ({ n: k + 1, type: c.type, refs: c.type === 'Omission' ? c.s.map((v) => 'S' + v).join(',') : c.t.map((v) => 'T' + v).join(','),
          text: clip(c.type === 'Omission' ? (c.sText || c.s.map((v) => win.src[v - 1].text).join(' ')) : (c.tText || c.t.map((v) => win.tgt[v - 1].text).join(' ')), 400) }));
        try {
          const vr = await ask(vsystem, verifyUserPrompt(win, items, o), { win, kind: 'verify' }); state.verifyCalls++;
          const vans = parseJSONLoose(vr.text);
          (vans.verdicts || []).forEach((v) => {
            const c = claims[(+v.id || 0) - 1]; if (!c) return;
            const vd = String(v.verdict || '').toLowerCase();
            if (vd === 'false_alarm') { c._drop = true; c.note = clean(v.note); dropped.push(c); }
            else if (vd === 'confirmed') { c.verified = 'confirmed'; c.note = clean(v.note); }
            else { c.verified = 'unsure'; c.note = clean(v.note); if (c.severity === 'Critical' || c.severity === 'Major') c.severity = 'Query'; }
          });
        } catch (e) { if (e && e.stop) throw e; /* verification is a bonus: keep the claims unverified */ }
      }
      const kept = raws.filter((x) => !x._drop).concat(rules);
      return { win, ledger: { s: win.src.map((p) => p.i), t: win.tgt.map((p) => p.i), unverifiedS: unS, unverifiedT: unT }, raws: kept, groups, dropped, rule: false, collapsed };
    }
    async function both(pair, depth) {
      const a = await doWindow(pair[0], depth + 1), b = await doWindow(pair[1], depth + 1);
      return { multi: [a, b] };
    }
    const flat = (r) => r.multi ? r.multi.reduce((x, y) => x.concat(flat(y)), []) : [r];

    const total = plan.windows.length;
    for (let wi = 0; wi < total; wi++) {
      const win = plan.windows[wi];
      if (state.done[win.id]) continue;
      if (ctx.shouldStop && ctx.shouldStop()) { state.stopped = true; break; }
      if (ctx.onProgress) ctx.onProgress({ index: wi, total, win, issues: state.results.reduce((a, r) => a + r.raws.length, 0), state });
      const r = await doWindow(win, 0);
      const parts = flat(r);
      parts.forEach((p) => state.results.push(p));
      state.done[win.id] = true;
    }
    state.finished = !state.stopped && plan.windows.every((w) => state.done[w.id]);
    return state;
  }

  // ======================================================================
  // 12. Report
  // ======================================================================
  // plan + finished state -> report object (issues, per-chapter table, coverage, score)
  function buildReport(plan, srcDoc, tgtDoc, state, meta) {
    meta = meta || {};
    const issues = []; const perWin = new Map();
    const cov = { windows: plan.windows.length, windowsDone: 0, splits: state.splits || 0, verifyCalls: state.verifyCalls || 0,
      srcParas: 0, tgtParas: 0, srcChecked: 0, tgtChecked: 0, oneToOne: 0, grouped: 0, omitted: 0, added: 0, unverified: [], dropped: 0 };
    const secRows = new Map();
    const secOf = (w) => { if (!secRows.has(w.num)) secRows.set(w.num, { num: w.num, title: w.title || '', label: w.num === 0 ? 'Front matter' : (plan.how === 'length' ? 'Whole document' : 'Chapter ' + w.num), srcWords: 0, tgtWords: 0, srcParas: 0, tgtParas: 0, issues: [], done: true }); return secRows.get(w.num); };
    plan.windows.forEach((w) => { const s = secOf(w); s.srcWords += w.srcWords; s.tgtWords += w.tgtWords; s.srcParas += w.src.length; s.tgtParas += w.tgt.length; if (!state.done[w.id]) s.done = false; });
    state.results.forEach((r) => {
      const w = r.win; cov.srcChecked += r.ledger.s.length - r.ledger.unverifiedS.length; cov.tgtChecked += r.ledger.t.length - r.ledger.unverifiedT.length;
      if (r.ledger.unverifiedS.length || r.ledger.unverifiedT.length) cov.unverified.push({ window: w.id, label: w.label, s: r.ledger.unverifiedS, t: r.ledger.unverifiedT });
      cov.dropped += r.dropped.length;
      r.groups.forEach((g) => { if (g.s.length && g.t.length) { if (g.s.length === 1 && g.t.length === 1) cov.oneToOne++; else cov.grouped++; } else if (g.s.length) cov.omitted += g.s.length; else cov.added += g.t.length; });
      const fin = finishIssues(w, r.raws, meta); const sec = secOf(w);
      fin.forEach((x) => { issues.push(x); sec.issues.push(x); });
    });
    // chapters that exist on one side only
    plan.structural.forEach((st) => {
      const p = st.pair; const w = plan.windows.find((x) => x.num === p.num); if (!w || !state.done[w.id]) return;
      const sec = secOf(w);
      const x = st.kind === 'missing-section'
        ? { type: 'Structure', severity: 'Critical', origin: 'rule', window: w.id, chapter: p.num, chapterTitle: (p.src && p.src.title) || '', srcLoc: 'Ch ' + p.num, tgtLoc: (p.num === 0 ? 'Front matter' : 'Ch ' + p.num) + ' (missing)', page: null, srcText: '', srcContext: clip(w.src.slice(0, 3).map((q) => q.text).join(' '), 400), tgtText: '', tgtContext: '', fix: '', why: (p.num === 0 ? 'The front matter is missing in the translation.' : 'Chapter ' + p.num + (p.src && p.src.title ? ' ("' + clip(p.src.title, 60) + '")' : '') + ' is in the source but missing in the translation (' + w.srcWords.toLocaleString() + ' words).'), insert: true, quoteOk: true, verified: null, note: '', sIdx: w.src.map((q) => q.i), tIdx: [] }
        : { type: 'Structure', severity: 'Critical', origin: 'rule', window: w.id, chapter: p.num, chapterTitle: (p.tgt && p.tgt.title) || '', srcLoc: '', tgtLoc: 'Ch ' + p.num, page: (w.tgt[0] && w.tgt[0].page) || null, srcText: '', srcContext: '', tgtText: '', tgtContext: clip(w.tgt.slice(0, 3).map((q) => q.text).join(' '), 400), fix: '', why: 'Chapter ' + p.num + ' exists only in the translation (' + w.tgtWords.toLocaleString() + ' words); the source has no matching chapter.', insert: false, quoteOk: true, verified: null, note: '', sIdx: [], tIdx: w.tgt.map((q) => q.i) };
      issues.push(x); sec.issues.push(x);
    });
    // heading typos recovered by the planner, and chapters whose length is far from the usual ratio
    (plan.repairs || []).forEach((r) => {
      const w = plan.windows.find((x) => x.num === r.num); if (!w || !state.done[w.id]) return;
      if (issues.some((q) => q.chapter === r.num && /heading/.test(q.tgtLoc) && q.origin === 'ai')) return;       // the model already raised it
      const x = { type: 'Structure', severity: 'Minor', origin: 'rule', window: w.id, chapter: r.num, chapterTitle: w.title || '', srcLoc: r.side === 'src' ? 'Ch ' + r.num : '', tgtLoc: r.side === 'tgt' ? 'Ch ' + r.num + ' heading' : '', page: (w.tgt[0] && w.tgt[0].page) || null,
        srcText: '', srcContext: '', tgtText: String(r.found), tgtContext: r.side === 'tgt' ? clip((w.tgt[0] || {}).text || '', 80) : '', fix: String(r.num), insert: false, quoteOk: true, verified: null, note: '', sIdx: [], tIdx: [],
        why: 'The chapter heading in the ' + (r.side === 'tgt' ? 'translation' : 'source') + ' reads "' + r.found + '" but chapter ' + r.num + ' is expected at this point.' };
      issues.push(x); secOf(w).issues.push(x);
    });
    const seenSuspect = new Set();
    plan.windows.forEach((w) => {
      if (!w.suspect || !state.done[w.id] || seenSuspect.has(w.num)) return; seenSuspect.add(w.num);
      const pct = Math.round(w.suspect.ratio * 100);
      const x = { type: 'Structure', severity: 'Query', origin: 'rule', window: w.id, chapter: w.num, chapterTitle: w.title || '', srcLoc: 'Ch ' + w.num, tgtLoc: 'Ch ' + w.num, page: (w.tgt[0] && w.tgt[0].page) || null,
        srcText: '', srcContext: '', tgtText: '', tgtContext: '', fix: '', insert: false, quoteOk: true, verified: null, note: '', sIdx: [], tIdx: [],
        why: 'This chapter\'s translation is ' + (pct > 100 ? 'much longer' : 'much shorter') + ' than the rest of the book compared with its source (' + pct + '% of the usual length). Check for missing or extra text, or a wrong chapter boundary.' };
      issues.push(x); secOf(w).issues.push(x);
    });
    cov.srcParas = plan.windows.reduce((a, w) => a + w.src.length, 0); cov.tgtParas = plan.windows.reduce((a, w) => a + w.tgt.length, 0);
    cov.windowsDone = plan.windows.filter((w) => state.done[w.id]).length;
    // whole-window failures count as "not verified"
    cov.srcChecked += state.results.filter((r) => r.rule).reduce((a, r) => a + r.ledger.unverifiedS.length, 0);
    cov.complete = cov.windowsDone === cov.windows && cov.unverified.length === 0;
    // order + number the issues in reading order (chapter, then source/translation position)
    const pos = (x) => (x.tIdx.length ? x.tIdx[0] : (x.sIdx.length ? x.sIdx[0] : 0));
    issues.sort((a, b) => (a.chapter - b.chapter) || ((a.page || 0) - (b.page || 0)) || (pos(a) - pos(b)));
    issues.forEach((x, k) => { x.id = k + 1; });
    const totalWords = tgtDoc && srcDoc ? Math.max(srcDoc.words || 0, 1) : 1;
    const sections = Array.from(secRows.values()).sort((a, b) => a.num - b.num).map((s) => {
      const sc = scoreOf(s.issues, s.srcWords || s.tgtWords);
      return { num: s.num, label: s.label, title: s.title, srcWords: s.srcWords, tgtWords: s.tgtWords, srcParas: s.srcParas, tgtParas: s.tgtParas, done: s.done,
               counts: sc.counts, score: sc.value, verdict: sc.verdict, issues: s.issues.length };
    });
    const checkedWords = plan.windows.filter((w) => state.done[w.id]).reduce((a, w) => a + w.srcWords, 0);
    return { v: 1, kind: 'translation', createdAt: new Date().toISOString(), how: plan.how, issues, sections, coverage: cov,
             score: scoreOf(issues, checkedWords || totalWords), scoredWords: checkedWords || totalWords };
  }

  // ======================================================================
  // 13. Hand-offs: reviewer link payload and CSV rows
  // ======================================================================
  function toShareIssues(issues, srcLang) {
    return issues.map((x) => ({
      id: x.id, type: x.type, severity: x.severity, page: x.page || null,
      loc: (x.tgtLoc || (x.srcLoc ? 'after source ' + x.srcLoc : '')) + (x.srcLoc && x.tgtLoc ? ' (source ' + x.srcLoc + ')' : ''),
      context: x.tgtContext || '', original: x.insert ? '' : x.tgtText, corrected: x.fix || '', explanation: x.why,
      insert: x.insert ? true : undefined,
      source: x.srcContext ? { label: 'Source' + (srcLang ? ' (' + srcLang + ')' : ''), text: x.srcContext } : undefined,
    }));
  }
  const CSV_HEAD = ['#', 'Chapter', 'Source location', 'Translation location', 'Page', 'Type', 'Severity', 'Source text', 'Translation text', 'Suggested fix', 'Explanation', 'Checked by'];
  function toCsvRows(issues) {
    return issues.map((x) => [x.id, x.chapter || '', x.srcLoc, x.tgtLoc, x.page || '', x.type, x.severity, x.srcText || x.srcContext, x.tgtText || x.tgtContext, x.fix, x.why,
      x.origin === 'rule' ? 'rule' : (x.verified === 'confirmed' ? 'AI, double-checked' : 'AI')]);
  }

  Object.assign(global.TC, { parseJSONLoose, estimateRun, halve, checkWindows, buildReport, toShareIssues, CSV_HEAD, toCsvRows, finishIssues });

})(typeof window !== 'undefined' ? window : globalThis);
