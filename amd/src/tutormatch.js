// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Finds the demonstration a student's question is about, without any AI (TUTORIAL-VOICE-CONTRACT.md §6).
 *
 * Each demonstration has a list of words and phrases: the names of the tools and actions the student sees in the
 * studio (lang strings tool_*, action_*, mshape_*...) and the synonyms of the lang string tutor_demo_<name>_words,
 * so a translation brings its own. The question and the phrases are normalised (lower case, accents and
 * punctuation taken away), a few English filler words are dropped, and words are cut to a rough stem ("smoothing"
 * and "smooth" meet). A phrase whose words are all in the question scores by its length; part of a phrase of
 * several words adds a little; a demonstration the studio is set up for now (its method) gets a small bonus, which
 * settles "Add shape" between sculpting and modelling. The best score above the threshold wins; equal scores go to
 * the one listed first.
 *
 * No Moodle imports, so it can be tested in Node.
 *
 * @module     mod_vrmakerspace/tutormatch
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The least score that counts as a match (one whole word of a phrase scores 2, one letter off 1.75). */
export const THRESHOLD = 1.75;

/** Bonus for a demonstration of the method the studio is in now. */
export const PREFER_BONUS = 0.5;

/** Filler words left out of questions and phrases (English; other languages' words simply stay). */
export const STOPWORDS = Object.freeze(new Set(['a', 'an', 'the', 'i', 'im', 'do', 'does', 'did', 'how', 'to', 'can',
    'could', 'you', 'me', 'my', 'it', 'its', 'this', 'that', 'is', 'are', 'what', 'of', 'on', 'in', 'with', 'use',
    'using', 'please', 'show', 'so', 'and', 'or', 'some', 'something', 'into', 'for', 'from', 'be', 'want', 'would',
    'like', 'should', 'there', 'way', 'tool', 'button', 'again', 'just', 'get', 'go', 'about', 'tell', 'thing',
    'one', 'we', 'let', 'lets', 'at', 'by', 'up']));

/** Letters whose doubling at the end of a stem is undone ("cutting" → "cut", but "pulling" stays "pull"). */
const UNDOUBLE = /([bdgmnpt])\1$/;

/** Separators of a word list: commas, also as written in Arabic and East Asian languages, and semicolons. */
const LIST_SEPARATORS = /[,;،、，]+/u;

/**
 * A text in lower case, without accents and punctuation, with single spaces.
 *
 * @param {string} text
 * @returns {string}
 */
export const normalise = (text) => String(text || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * A rough stem of a word: common English endings cut, a final e dropped, a doubled last letter undone.
 *
 * @param {string} word Normalised word.
 * @returns {string}
 */
export const stem = (word) => {
    let w = String(word || '');
    const cut = /(ing|ed|es|er|s)$/.exec(w);
    if (cut && w.length - cut[0].length >= 3 && !/ss$/.test(w)) {
        w = w.slice(0, -cut[0].length);
        if (w.length > 3 && UNDOUBLE.test(w)) {
            w = w.slice(0, -1);
        }
    }
    if (w.length > 3 && w.endsWith('e')) {
        w = w.slice(0, -1);
    }
    return w;
};

/**
 * The stems of the meaningful words of a text.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const words = (text) => normalise(text).split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);

/**
 * The items of a comma separated list, trimmed, without empty ones.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const splitList = (text) => String(text || '').split(LIST_SEPARATORS).map((s) => s.trim()).filter((s) => s !== '');

/**
 * Whether two words differ by at most one letter (added, taken away or changed).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export const nearlySame = (a, b) => {
    if (a === b) {
        return true;
    }
    if (Math.abs(a.length - b.length) > 1) {
        return false;
    }
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) {
        i++;
    }
    if (a.length === b.length) {
        return a.slice(i + 1) === b.slice(i + 1);
    }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};

/**
 * How well a word of a phrase is in the question: 1 (there), 0.75 (one letter off, long words only) or 0.
 *
 * @param {string} word A phrase's stem.
 * @param {string[]} question The question's stems.
 * @returns {{weight: number, at: number}}
 */
const find = (word, question) => {
    const at = question.indexOf(word);
    if (at >= 0) {
        return {weight: 1, at: at};
    }
    if (word.length >= 5) {
        const near = question.findIndex((q) => q.length >= 5 && nearlySame(q, word));
        if (near >= 0) {
            return {weight: 0.75, at: near};
        }
    }
    return {weight: 0, at: -1};
};

/**
 * The score of one phrase in a question: all its words there gives their weights + 1 (+ 0.5 when they are in order
 * next to each other); some words of a longer phrase give 0.5 each.
 *
 * @param {string[]} phrase The phrase's stems.
 * @param {string[]} question The question's stems.
 * @returns {{score: number, full: boolean, hits: number[]}} hits: the places of the question's words it used
 */
export const phraseScore = (phrase, question) => {
    const hits = [];
    let weight = 0;
    let inorder = true;
    phrase.forEach((word) => {
        const hit = find(word, question);
        if (hit.weight > 0) {
            weight += hit.weight;
            inorder = inorder && (!hits.length || hit.at === hits[hits.length - 1] + 1);
            hits.push(hit.at);
        } else {
            inorder = false;
        }
    });
    if (phrase.length && hits.length === phrase.length) {
        return {score: weight + 1 + (phrase.length > 1 && inorder ? 0.5 : 0), full: true, hits: hits};
    }
    return {score: phrase.length > 1 ? hits.length * 0.5 : 0, full: false, hits: phrase.length > 1 ? hits : []};
};

/**
 * The score of a demonstration: its best phrase, and 0.5 for each other word of the question its other phrases
 * use (2 points at most), so "add a cube" goes to adding a shape rather than adding clay.
 *
 * @param {string[][]} phrases The demonstration's phrases, as stems.
 * @param {string[]} asked The question's stems.
 * @returns {number}
 */
export const demoScore = (phrases, asked) => {
    let best = {score: 0, hits: []};
    const used = new Set();
    phrases.forEach((phrase) => {
        const result = phraseScore(phrase, asked);
        result.hits.forEach((at) => used.add(at));
        if (result.score > best.score) {
            best = result;
        }
    });
    if (!best.score) {
        return 0;
    }
    const extra = Array.from(used).filter((at) => best.hits.indexOf(at) < 0).length;
    return best.score + 0.5 * Math.min(4, extra);
};

/**
 * The demonstrations and their phrases, as lists of stems.
 *
 * @param {Object[]|Object} list [{demo, step, phrases: string[]}], or {demo: string[] | {step, phrases}}
 * @returns {Object[]} [{demo, step, phrases: string[][]}]
 */
export const prepare = (list) => {
    const entries = Array.isArray(list) ? list : Object.keys(list || {}).map((demo) => {
        const value = list[demo];
        return Array.isArray(value) ? {demo: demo, phrases: value} : Object.assign({demo: demo}, value || {});
    });
    return entries.filter((entry) => entry && entry.demo).map((entry) => {
        const seen = new Set();
        const phrases = [];
        (Array.isArray(entry.phrases) ? entry.phrases : splitList(entry.phrases)).forEach((phrase) => {
            const stems = words(phrase);
            const key = stems.join(' ');
            if (stems.length && !seen.has(key)) {
                seen.add(key);
                phrases.push(stems);
            }
        });
        return {demo: String(entry.demo), step: String(entry.step || entry.demo), phrases: phrases};
    });
};

/**
 * Every demonstration with its score for a question, best first (equal scores keep the list's order).
 *
 * @param {string} question
 * @param {Object[]|Object} list As prepare() takes it.
 * @param {Object} [options] {prefer: demo names that get PREFER_BONUS}
 * @returns {Object[]} [{demo, step, score}]
 */
export const rank = (question, list, options = {}) => {
    const asked = words(question);
    const prefer = new Set(Array.isArray(options.prefer) ? options.prefer : []);
    if (!asked.length) {
        return [];
    }
    return prepare(list).map((entry, order) => {
        let score = demoScore(entry.phrases, asked);
        if (score > 0 && prefer.has(entry.demo)) {
            score += PREFER_BONUS;
        }
        return {demo: entry.demo, step: entry.step, score: score, order: order};
    }).sort((a, b) => (b.score - a.score) || (a.order - b.order)).map((r) => ({demo: r.demo, step: r.step, score: r.score}));
};

/**
 * The demonstration a question is about.
 *
 * @param {string} question
 * @param {Object[]|Object} list As prepare() takes it.
 * @param {Object} [options] {prefer: demo names of the method the studio is in, threshold}
 * @returns {{demo: string, step: string}|null}
 */
export const match = (question, list, options = {}) => {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : THRESHOLD;
    const best = rank(question, list, options)[0];
    if (!best || best.score < threshold) {
        return null;
    }
    return {demo: best.demo, step: best.step};
};
