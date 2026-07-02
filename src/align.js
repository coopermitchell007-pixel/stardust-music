'use strict';

// Forced alignment — the "99%" path for word-by-word lyrics.
//
// Heuristics can only guess where words fall inside a line. This instead takes
// the KNOWN lyrics text (correct words, line- or synth-timed) plus the ACTUAL
// audio's Whisper word timestamps, aligns the two word sequences globally, and
// emits enhanced LRC with real per-word timing. Whisper mishears some words —
// that's fine: only its CLOCK is used; the text stays the database's.

// Normalize a word for matching: lowercase, unicode-fold, letters+digits only.
const norm = (w) => String(w || '')
  .toLowerCase()
  .normalize('NFKC')
  .replace(/['’]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');

// Levenshtein distance <= 1 (cheap early-outs; words are short).
function lev1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }        // substitution
    else if (la > lb) i++;               // deletion from a
    else j++;                            // insertion into a
  }
  return edits + (la - i) + (lb - j) <= 1;
}

// Similarity score for the aligner. Positive = plausible same word.
function sim(a, b) {
  if (!a || !b) return -1;
  if (a === b) return 2;
  // Fuzziness only for longer words — short ones ("up"/"uh", "in"/"it") are
  // one edit apart while being entirely different words.
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 1.1;
  if (a.length >= 4 && b.length >= 4 && lev1(a, b)) return 1.0;
  return -1;
}

// Global alignment (Needleman-Wunsch) of lyric words vs whisper words, with a
// SOFT TIME PRIOR: identical words recur constantly in songs (choruses), and a
// pure text alignment can lock a word onto the wrong occurrence. Each lyric
// word carries an approximate time (from its line stamp); a textual match far
// from that time scores progressively worse. The prior is generous (~25s
// scale) so even rough synth stamps help rather than hurt.
// lyr: [{n, at}] (norm text + approx seconds), wsp: [{n, t}].
// Sizes are small (a song is a few hundred words), so O(n*m) is trivial.
function alignSequences(lyr, wsp) {
  const n = lyr.length, m = wsp.length;
  const GAP = -0.55;
  const pair = (a, b) => {
    const s0 = sim(a.n, b.n);
    if (s0 <= 0) return s0;
    const dt = Math.abs((a.at != null ? a.at : b.t) - b.t);
    return s0 + 0.5 - Math.min(1.4, dt / (a.tight ? 5 : 25));
  };
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1=diag 2=up(skip lyric) 3=left(skip whisper)
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; move[j] = 3; }
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; move[i * W] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = score[(i - 1) * W + (j - 1)] + pair(lyr[i - 1], wsp[j - 1]);
      const u = score[(i - 1) * W + j] + GAP;
      const l = score[i * W + (j - 1)] + GAP;
      let best = d, mv = 1;
      if (u > best) { best = u; mv = 2; }
      if (l > best) { best = l; mv = 3; }
      score[i * W + j] = best; move[i * W + j] = mv;
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (i > 0 && j > 0 && mv === 1) {
      if (sim(lyr[i - 1].n, wsp[j - 1].n) > 0) map[i - 1] = j - 1;
      i--; j--;
    } else if (i > 0 && (mv === 2 || j === 0)) i--;
    else j--;
  }
  return map;
}

const stamp = (sec) => {
  const t = Math.max(0, sec || 0), mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
  return String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0');
};

// lrcText: the current synced lyrics (line-level or synth timing; existing
// <word> tags are ignored). whisperWords: [{word, start}] from verbose_json.
// realStamps: the line timestamps are HUMAN-MADE (lrclib/KuGou/NetEase) — they
// are ground truth at line level, so Whisper is only trusted to place words
// WITHIN each line's window. Measured on real songs, free-running alignment
// drifted whole chorus lines (~2s, p90); window-clamped it cannot.
// force: a DELIBERATE user request — produce a best-effort result from
// whatever anchors matched instead of refusing (line stamps carry the rest).
// Returns { syncedLyrics, coverage } or null when alignment isn't trustworthy.
function alignLyrics(lrcText, whisperWords, duration, realStamps, force) {
  // Parse the lyric lines: keep text + display words per line.
  const lines = [];
  for (const raw of String(lrcText || '').split('\n')) {
    const m = raw.match(/^((?:\s*\[\d+:\d+(?:\.\d+)?\])+)([^]*)$/);
    if (!m) continue;
    const text = m[2].replace(/<\d+:\d+(?:\.\d+)?>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^\[[^\][]{1,40}\]$/.test(text)) continue; // section headers aren't sung
    const st = m[1].match(/\[(\d+):(\d+(?:\.\d+)?)\]/);
    lines.push({ t: parseInt(st[1], 10) * 60 + parseFloat(st[2]), text, words: text.split(/\s+/) });
  }
  if (lines.length < 2) return null;

  // Flatten lyric words with an approximate time each (line stamp + even
  // in-line spread) — the aligner's occurrence-disambiguation prior.
  const flat = [];
  lines.forEach((ln, li) => {
    const next = lines[li + 1];
    const span = Math.max(1, Math.min((next ? next.t - ln.t : 4), ln.words.length * 0.55));
    ln.words.forEach((w, wi) => flat.push({
      li, wi, w, n: norm(w),
      at: ln.t + span * (wi / Math.max(1, ln.words.length))
    }));
  });
  const lyrNorm = flat.map((f) => f.n);

  const wsp = (whisperWords || [])
    .map((w) => ({ t: +w.start, n: norm(w.word != null ? w.word : w.text) }))
    .filter((w) => w.n && isFinite(w.t));
  if (wsp.length < 10) return null;

  // PASS 1 — free alignment (loose prior) to measure the GLOBAL OFFSET S
  // between the lyric stamps and this audio: a music-video intro, a different
  // edition, or a uniformly early/late human sync all show up as a consistent
  // per-line shift. Median of per-line first-anchor shifts = S.
  const pass1 = alignSequences(flat.map((f) => ({ n: f.n, at: f.at })), wsp);
  let S = 0;
  {
    const seen = new Set(), shifts = [];
    for (let i = 0; i < flat.length; i++) {
      if (pass1[i] < 0 || seen.has(flat[i].li)) continue;
      seen.add(flat[i].li);
      shifts.push(lines[flat[i].li].t - wsp[pass1[i]].t);
    }
    shifts.sort((a, b) => a - b);
    if (shifts.length >= 5) {
      const med = shifts[shifts.length >> 1];
      // Only adopt a CONSISTENT offset (at least half the lines agree ±1.2s).
      const agree = shifts.filter((x) => Math.abs(x - med) <= 1.2).length;
      if (Math.abs(med) > 0.9 && agree >= shifts.length * 0.5) S = med;
    }
  }

  // PASS 2 — align with the offset-corrected priors (tight when the stamps
  // are human-made, since after the S correction they should be dead on).
  const map = alignSequences(flat.map((f) => ({ n: f.n, at: f.at - S, tight: !!realStamps })), wsp);

  // Anchor times must be strictly increasing. Greedy "keep the first" lets a
  // single wrong-occurrence anchor block every legitimate one behind it, so
  // take the LONGEST increasing subsequence instead — the maximal mutually
  // consistent anchor set, discarding the few liars wherever they sit.
  const cand = [];
  for (let i = 0; i < flat.length; i++) {
    if (map[i] < 0) continue;
    const t = wsp[map[i]].t;
    if (realStamps) {
      // Human line stamps (offset-corrected) are ground truth: an anchor
      // outside its line's window is a misalignment — drop it.
      const ln = lines[flat[i].li], next = lines[flat[i].li + 1];
      const lo = ln.t - S - 1.0;
      const hi = (next ? next.t : (duration > 0 ? duration : ln.t + 12)) - S + 1.0;
      if (t < lo || t > hi) continue;
    }
    cand.push({ i, t });
  }
  const tails = [], links = new Array(cand.length).fill(-1), tailIdx = [];
  for (let k = 0; k < cand.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < cand[k].t) lo = mid + 1; else hi = mid; }
    tails[lo] = cand[k].t; tailIdx[lo] = k;
    links[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const times = new Array(flat.length).fill(null);
  let matched = 0;
  if (tails.length) {
    let k = tailIdx[tails.length - 1];
    while (k >= 0) { times[cand[k].i] = cand[k].t; matched++; k = links[k]; }
  }
  const matchable = lyrNorm.filter(Boolean).length || 1;
  const coverage = matched / matchable;
  // Wrong audio OR wrong lyrics text — don't lie; report how bad the match
  // was so the caller can tell "slightly off" from "these aren't the words".
  // A forced (user-initiated) run proceeds with any usable anchor set: the
  // human line stamps keep the skeleton correct, matched words land exactly,
  // everything else paces between them.
  if (coverage < 0.5 && !(force && matched >= 5)) return { failed: true, coverage };

  // Fill unanchored words. Plain linear interpolation smears words into
  // instrumental gaps (a word next to a 9s break lands seconds off), so the
  // fill is LINE-AWARE: words sharing a line with the left anchor pace
  // forward from it at the song's measured syllable rate; words sharing a
  // line with the right anchor pace backward from it; whole unanchored lines
  // in the middle spread across whatever window remains.
  const sylOf = (w) => (norm(w).match(/[aeiouy]+/g) || []).length || 1;

  // Median seconds-per-syllable between same-line anchor pairs = sung pace.
  const rates = [];
  {
    let last = -1;
    for (let i = 0; i < times.length; i++) {
      if (times[i] == null) continue;
      if (last >= 0 && flat[i].li === flat[last].li && i > last) {
        let syl = 0;
        for (let k = last; k < i; k++) syl += sylOf(flat[k].w);
        if (syl > 0 && times[i] > times[last]) rates.push((times[i] - times[last]) / syl);
      }
      last = i;
    }
  }
  rates.sort((a, b) => a - b);
  const pace = Math.max(0.12, Math.min(0.6, rates.length ? rates[rates.length >> 1] : 0.3));

  let prevIdx = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] == null) continue;
    if (prevIdx < 0) {
      for (let k = i - 1; k >= 0; k--) times[k] = Math.max(0, times[k + 1] - pace * sylOf(flat[k].w));
    } else if (i - prevIdx > 1) {
      const ta = times[prevIdx], tb = times[i];
      // Forward pass: same line as the left anchor, natural pace.
      let k = prevIdx + 1;
      while (k < i && flat[k].li === flat[prevIdx].li) {
        times[k] = Math.min(tb - 0.1, times[k - 1] + pace * sylOf(flat[k - 1].w));
        k++;
      }
      // Backward pass: same line as the right anchor, natural pace.
      let k2 = i - 1;
      const backStop = k;
      let tNext = tb;
      while (k2 >= backStop && flat[k2].li === flat[i].li) {
        tNext = Math.max(ta + 0.1, tNext - pace * sylOf(flat[k2].w));
        times[k2] = tNext;
        k2--;
      }
      // Middle: whole unanchored lines. With human stamps, each line paces
      // from its OWN stamp (ground truth); otherwise spread in what's left.
      if (k <= k2) {
        if (realStamps) {
          for (let x = k; x <= k2; x++) {
            const ln = lines[flat[x].li];
            times[x] = flat[x].wi === 0 || times[x - 1] == null || flat[x - 1].li !== flat[x].li
              ? Math.max(ta + 0.05, ln.t)
              : times[x - 1] + pace * sylOf(flat[x - 1].w);
            times[x] = Math.min(times[x], tNext - 0.05);
          }
        } else {
          const lo = times[k - 1] != null ? times[k - 1] : ta;
          const hi = tNext;
          let tot = 0;
          for (let x = k; x <= k2; x++) tot += sylOf(flat[x].w);
          let acc = 0;
          for (let x = k; x <= k2; x++) {
            acc += sylOf(flat[x].w);
            times[x] = lo + Math.max(0, hi - lo) * (acc / (tot + 1));
          }
        }
      }
      // Monotonic safety net over the filled stretch.
      for (let x = prevIdx + 1; x < i; x++) if (times[x] <= times[x - 1]) times[x] = times[x - 1] + 0.05;
    }
    prevIdx = i;
  }
  if (prevIdx < 0) return null;
  for (let k = prevIdx + 1; k < times.length; k++) {
    times[k] = times[k - 1] + pace * sylOf(flat[k - 1].w);
    if (duration > 0) times[k] = Math.min(times[k], duration - 0.2);
  }

  // realStamps: the human line stamps are the absolute truth — Whisper's
  // absolute clock drifts on music (its strength is RELATIVE spacing). Shift
  // each line's word times so the first word sits exactly on the human stamp,
  // keeping Whisper's intra-line rhythm; clamp inside the line's window.
  if (realStamps) {
    for (let li = 0; li < lines.length; li++) {
      const idxs = [];
      for (let i = 0; i < flat.length; i++) if (flat[i].li === li) idxs.push(i);
      if (!idxs.length) continue;
      const t0 = lines[li].t - S;
      const end = (lines[li + 1] ? lines[li + 1].t - S : (duration > 0 ? duration : t0 + 8)) - 0.05;
      const shift = t0 - times[idxs[0]];
      if (Math.abs(shift) <= 3.5) {
        for (const i of idxs) times[i] += shift;
      } else {
        // Alignment lost this line entirely — pace it from the human stamp.
        let t = t0;
        for (const i of idxs) { times[i] = t; t += pace * sylOf(flat[i].w); }
      }
      // Keep every word inside the line window, strictly increasing.
      let prev = t0 - 0.001;
      for (const i of idxs) {
        times[i] = Math.min(Math.max(times[i], prev + 0.02), Math.max(end, t0 + 0.1));
        prev = times[i];
      }
    }
  }

  // Rebuild enhanced LRC: each line stamped at its first word's real time.
  const byLine = new Map();
  flat.forEach((f, i) => {
    if (!byLine.has(f.li)) byLine.set(f.li, []);
    byLine.get(f.li).push({ w: f.w, t: times[i] });
  });
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const ws = byLine.get(li);
    if (!ws || !ws.length) continue;
    let body = '';
    for (const x of ws) body += '<' + stamp(x.t) + '>' + x.w + ' ';
    out.push('[' + stamp(ws[0].t) + ']' + body.trim());
  }
  if (out.length < 2) return null;
  // Version marker: v3 = current pipeline quality (priming, false-anchor
  // filtering, language pinning). Older markers are treated as stale and
  // re-made once; the marker also stops re-syncing on every play.
  // LOW-COVERAGE (forced) results stay unmarked — usable now, but eligible
  // for a future remake instead of sticking forever.
  const marker = coverage >= 0.5 ? '[re:stardust-aligned-v3]\n' : '';
  return { syncedLyrics: marker + out.join('\n'), coverage };
}

module.exports = { alignLyrics, alignSequences, norm };
