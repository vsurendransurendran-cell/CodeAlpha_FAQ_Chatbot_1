import fs from "fs";
import path from "path";

export const DEFAULT_THRESHOLD = 0.4;
export const DEFAULT_RELATED_THRESHOLD = 0.15;
export const DEFAULT_MAX_RELATED = 3;
export const WORD_WEIGHT = 0.5;
export const CHAR_WEIGHT = 0.5;

export const FALLBACK_MESSAGE =
  "Sorry, I couldn't find a confident answer to that in my FAQ. " +
  "Try rephrasing with different keywords, or pick one of the suggestions below.";

export const STOP_WORDS = new Set(
  `
  a an the is are was were be been am do does did of to in on for with and or
  what whats how why who when where which can could should would will shall
  i me my you your we our it its this that these those there about please
  tell explain define mean means between
`
    .trim()
    .split(/\s+/)
);

export class FAQDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FAQDataError";
  }
}

export class InvalidQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuestionError";
  }
}

export class UnknownCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownCategoryError";
  }
}

export interface FAQEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  alternatives: string[];
}

export interface ChatResult {
  answer: string;
  matched: boolean;
  confidence: number;
  faq_id?: string | null;
  category?: string | null;
  matched_question?: string | null;
  related: Array<{ id: string; question: string }>;
}

export function preprocess(text: string): string {
  let cleaned = text.toLowerCase();
  cleaned = cleaned.replace(/['’`]/g, "");
  cleaned = cleaned.replace(/_/g, " ");
  cleaned = cleaned.replace(/[^\w\s+#]/g, " ");
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  const content = tokens.filter((t) => !STOP_WORDS.has(t));
  const finalTokens = content.length > 0 ? content : tokens;
  return finalTokens.join(" ");
}

function getMatchingBlocks(a: string, b: string): number {
  function findLongest(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    let bestI = alo,
      bestJ = blo,
      bestSize = 0;
    for (let i = alo; i < ahi; i++) {
      for (let j = blo; j < bhi; j++) {
        let k = 0;
        while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) {
          k++;
        }
        if (k > bestSize) {
          bestI = i;
          bestJ = j;
          bestSize = k;
        }
      }
    }
    return [bestI, bestJ, bestSize];
  }

  function matchRec(alo: number, ahi: number, blo: number, bhi: number): number {
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k === 0) return 0;
    let total = k;
    if (alo < i && blo < j) {
      total += matchRec(alo, i, blo, j);
    }
    if (i + k < ahi && j + k < bhi) {
      total += matchRec(i + k, ahi, j + k, bhi);
    }
    return total;
  }

  return matchRec(0, a.length, 0, b.length);
}

function sequenceMatcherRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1.0;
  if (!a.length || !b.length) return 0.0;
  const matches = getMatchingBlocks(a, b);
  return (2.0 * matches) / (a.length + b.length);
}

function getCloseMatches(word: string, possibilities: string[], n = 1, cutoff = 0.8): string[] {
  const matches: Array<{ word: string; ratio: number }> = [];
  for (const pos of possibilities) {
    const ratio = sequenceMatcherRatio(word, pos);
    if (ratio >= cutoff) {
      matches.push({ word: pos, ratio });
    }
  }
  matches.sort((a, b) => b.ratio - a.ratio);
  return matches.slice(0, n).map((m) => m.word);
}

interface SparseVector {
  indices: number[];
  values: number[];
}

class TfidfModel {
  vocabulary: Map<string, number> = new Map();
  idf: number[] = [];
  docVectors: SparseVector[] = [];

  constructor(
    phrases: string[],
    private tokenizer: (text: string) => string[],
    private sublinearTf = true
  ) {
    this.fit(phrases);
  }

  private fit(phrases: string[]) {
    const docTermFreqs: Map<string, number>[] = [];
    const docFreq = new Map<string, number>();

    for (const phrase of phrases) {
      const tokens = this.tokenizer(phrase);
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      docTermFreqs.push(tf);
      for (const term of tf.keys()) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }

    // Build vocabulary sorted alphabetically (consistent with scikit-learn)
    const sortedTerms = Array.from(docFreq.keys()).sort();
    sortedTerms.forEach((term, idx) => {
      this.vocabulary.set(term, idx);
    });

    const N = phrases.length;
    this.idf = new Array(sortedTerms.length);
    for (let i = 0; i < sortedTerms.length; i++) {
      const df = docFreq.get(sortedTerms[i]) || 0;
      // scikit-learn smooth_idf: ln((1 + N) / (1 + df)) + 1
      this.idf[i] = Math.log((1 + N) / (1 + df)) + 1;
    }

    // Precompute L2-normalized document vectors
    for (const tf of docTermFreqs) {
      this.docVectors.push(this.vectorizeMap(tf));
    }
  }

  private vectorizeMap(tf: Map<string, number>): SparseVector {
    const indices: number[] = [];
    const values: number[] = [];
    let sumSq = 0;

    for (const [term, count] of tf.entries()) {
      const termIdx = this.vocabulary.get(term);
      if (termIdx !== undefined) {
        const tfVal = this.sublinearTf ? 1 + Math.log(count) : count;
        const weight = tfVal * this.idf[termIdx];
        indices.push(termIdx);
        values.push(weight);
        sumSq += weight * weight;
      }
    }

    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < values.length; i++) {
        values[i] /= norm;
      }
    }

    return { indices, values };
  }

  transform(text: string): SparseVector {
    const tokens = this.tokenizer(text);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    return this.vectorizeMap(tf);
  }

  cosineSimilarity(queryVec: SparseVector, docIndex: number): number {
    const docVec = this.docVectors[docIndex];
    if (queryVec.indices.length === 0 || docVec.indices.length === 0) return 0;

    let dot = 0;
    let i = 0;
    let j = 0;
    while (i < queryVec.indices.length && j < docVec.indices.length) {
      const qIdx = queryVec.indices[i];
      const dIdx = docVec.indices[j];
      if (qIdx === dIdx) {
        dot += queryVec.values[i] * docVec.values[j];
        i++;
        j++;
      } else if (qIdx < dIdx) {
        i++;
      } else {
        j++;
      }
    }
    return dot;
  }
}

function wordTokenizer(text: string): string[] {
  const matches = text.match(/[\w+#]+/g);
  if (!matches) return [];
  const tokens: string[] = [];
  // Unigrams
  for (let i = 0; i < matches.length; i++) {
    tokens.push(matches[i]);
  }
  // Bigrams
  for (let i = 0; i < matches.length - 1; i++) {
    tokens.push(`${matches[i]} ${matches[i + 1]}`);
  }
  return tokens;
}

function charWbTokenizer(text: string): string[] {
  const words = text.match(/[\w+#]+/g);
  if (!words) return [];
  const ngrams: string[] = [];
  for (const w of words) {
    const padded = ` ${w} `;
    for (let len = 3; len <= 4; len++) {
      for (let i = 0; i <= padded.length - len; i++) {
        ngrams.push(padded.substring(i, i + len));
      }
    }
  }
  return ngrams;
}

function validateEntry(raw: any, seenIds: Set<string>): FAQEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("entry is not a JSON object");
  }

  function requiredText(key: string): string {
    const val = raw[key];
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(`missing or empty '${key}'`);
    }
    return val.trim();
  }

  const id = requiredText("id");
  const category = requiredText("category");
  const question = requiredText("question");
  const answer = requiredText("answer");

  if (seenIds.has(id)) {
    throw new Error(`duplicate id '${id}'`);
  }
  if (!preprocess(question)) {
    throw new Error("question contains no usable words");
  }

  let alternativesRaw = raw.alternative_questions;
  if (alternativesRaw === undefined || alternativesRaw === null) {
    alternativesRaw = [];
  }
  if (!Array.isArray(alternativesRaw) || !alternativesRaw.every((a) => typeof a === "string" && a.trim())) {
    throw new Error("'alternative_questions' must be a list of non-empty strings");
  }

  const alternatives = alternativesRaw.map((a: string) => a.trim()).filter((a: string) => preprocess(a));

  return { id, category, question, answer, alternatives };
}

export function loadFaqs(filePath: string): { faqs: FAQEntry[]; skipped: string[] } {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new FAQDataError(`FAQ file not found: ${filePath}`);
    }
    throw new FAQDataError(`FAQ file could not be read: ${err.message}`);
  }

  let data: any;
  try {
    data = JSON.parse(content);
  } catch (err: any) {
    throw new FAQDataError(`FAQ file is not valid JSON (${err.message})`);
  }

  const rawEntries = Array.isArray(data) ? data : data && Array.isArray(data.faqs) ? data.faqs : null;
  if (!rawEntries) {
    throw new FAQDataError("FAQ file must contain a list of entries under the key 'faqs'");
  }

  const faqs: FAQEntry[] = [];
  const skipped: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawEntries.length; i++) {
    try {
      const entry = validateEntry(rawEntries[i], seenIds);
      seenIds.add(entry.id);
      faqs.push(entry);
    } catch (err: any) {
      const msg = `entry #${i + 1} skipped: ${err.message}`;
      skipped.push(msg);
    }
  }

  if (faqs.length === 0) {
    throw new FAQDataError("FAQ file contains no valid entries");
  }

  return { faqs, skipped };
}

export class FAQChatbot {
  faqs: FAQEntry[];
  skipped: string[];
  threshold: number;
  relatedThreshold: number;
  maxRelated: number;

  private byId: Map<string, FAQEntry> = new Map();
  private owners: number[] = [];
  private vocabulary: string[] = [];
  private wordModel!: TfidfModel;
  private charModel!: TfidfModel;

  constructor(
    faqPath: string,
    threshold = DEFAULT_THRESHOLD,
    relatedThreshold = DEFAULT_RELATED_THRESHOLD,
    maxRelated = DEFAULT_MAX_RELATED
  ) {
    if (threshold < 0.0 || threshold > 1.0) {
      throw new Error("threshold must be between 0 and 1");
    }
    this.threshold = threshold;
    this.relatedThreshold = relatedThreshold;
    this.maxRelated = maxRelated;

    const loaded = loadFaqs(faqPath);
    this.faqs = loaded.faqs;
    this.skipped = loaded.skipped;

    for (const faq of this.faqs) {
      this.byId.set(faq.id, faq);
    }

    this.buildIndex();
  }

  private buildIndex() {
    const phrases: string[] = [];
    const owners: number[] = [];
    const vocabSet = new Set<string>();

    for (let faqIdx = 0; faqIdx < this.faqs.length; faqIdx++) {
      const faq = this.faqs[faqIdx];
      const texts = [faq.question, ...faq.alternatives];
      for (const text of texts) {
        const prep = preprocess(text);
        phrases.push(prep);
        owners.push(faqIdx);
        for (const tok of prep.split(/\s+/).filter(Boolean)) {
          vocabSet.add(tok);
        }
      }
    }

    this.owners = owners;
    this.vocabulary = Array.from(vocabSet).sort();
    this.wordModel = new TfidfModel(phrases, wordTokenizer, true);
    this.charModel = new TfidfModel(phrases, charWbTokenizer, true);
  }

  private correctSpelling(processedQuestion: string): string {
    const known = new Set(this.vocabulary);
    const fixed: string[] = [];
    for (const token of processedQuestion.split(/\s+/).filter(Boolean)) {
      if (!known.has(token) && token.length >= 4 && /^[a-zA-Z]+$/.test(token)) {
        const close = getCloseMatches(token, this.vocabulary, 1, 0.8);
        fixed.push(close.length > 0 ? close[0] : token);
      } else {
        fixed.push(token);
      }
    }
    return fixed.join(" ");
  }

  private scoreFaqs(processedQuestion: string): number[] {
    const queryWordVec = this.wordModel.transform(processedQuestion);
    const queryCharVec = this.charModel.transform(processedQuestion);

    const faqScores = new Array(this.faqs.length).fill(0);
    const numPhrases = this.owners.length;

    for (let p = 0; p < numPhrases; p++) {
      const wordScore = this.wordModel.cosineSimilarity(queryWordVec, p);
      const charScore = this.charModel.cosineSimilarity(queryCharVec, p);
      const phraseScore = WORD_WEIGHT * wordScore + CHAR_WEIGHT * charScore;

      const faqIdx = this.owners[p];
      if (phraseScore > faqScores[faqIdx]) {
        faqScores[faqIdx] = phraseScore;
      }
    }

    return faqScores;
  }

  get categories(): string[] {
    const set = new Set<string>();
    const list: string[] = [];
    for (const faq of this.faqs) {
      if (!set.has(faq.category)) {
        set.add(faq.category);
        list.push(faq.category);
      }
    }
    return list;
  }

  get categoryCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const faq of this.faqs) {
      counts[faq.category] = (counts[faq.category] || 0) + 1;
    }
    return counts;
  }

  getFaq(faqId: string): FAQEntry | undefined {
    return this.byId.get(faqId);
  }

  searchFaqs(options: { category?: string | null; query?: string; offset?: number; limit?: number } = {}) {
    const { category, query, offset = 0, limit = 100 } = options;
    let results = this.faqs;

    if (category) {
      results = results.filter((f) => f.category === category);
    }

    if (query && query.trim()) {
      const q = query.toLowerCase().trim();
      results = results.filter(
        (f) =>
          f.question.toLowerCase().includes(q) ||
          f.answer.toLowerCase().includes(q) ||
          f.alternatives.some((a) => a.toLowerCase().includes(q))
      );
    }

    const total = results.length;
    const paginated = results.slice(offset, offset + limit);
    return { total, faqs: paginated };
  }

  suggestedQuestions(count = 6, category?: string | null): Array<{ id: string; question: string; category: string }> {
    if (category) {
      const catFaqs = this.faqs.filter((f) => f.category === category);
      if (catFaqs.length > 0) {
        return catFaqs.slice(0, count).map((f) => ({
          id: f.id,
          question: f.question,
          category: f.category,
        }));
      }
    }

    const byCategory = new Map<string, FAQEntry[]>();
    for (const faq of this.faqs) {
      if (!byCategory.has(faq.category)) {
        byCategory.set(faq.category, []);
      }
      byCategory.get(faq.category)!.push(faq);
    }

    const picked: FAQEntry[] = [];
    let roundNumber = 0;
    while (
      picked.length < count &&
      Array.from(byCategory.values()).some((v) => v.length > roundNumber)
    ) {
      for (const entries of byCategory.values()) {
        if (entries.length > roundNumber && picked.length < count) {
          picked.push(entries[roundNumber]);
        }
      }
      roundNumber++;
    }

    return picked.map((f) => ({ id: f.id, question: f.question, category: f.category }));
  }

  ask(question: string, category?: string | null): ChatResult {
    if (typeof question !== "string" || !question.trim()) {
      throw new InvalidQuestionError("Please type a question.");
    }
    const processed = preprocess(question);
    if (!processed) {
      throw new InvalidQuestionError("Please include some words in your question.");
    }

    let candidates: number[];
    if (category) {
      if (!this.categories.includes(category)) {
        throw new UnknownCategoryError(`Unknown category: ${category}`);
      }
      candidates = [];
      for (let i = 0; i < this.faqs.length; i++) {
        if (this.faqs[i].category === category) {
          candidates.push(i);
        }
      }
    } else {
      candidates = Array.from({ length: this.faqs.length }, (_, i) => i);
    }

    const corrected = this.correctSpelling(processed);
    const scores = this.scoreFaqs(corrected);

    candidates.sort((a, b) => scores[b] - scores[a]);
    const bestIndex = candidates[0];
    const confidence = scores[bestIndex] || 0;
    const matched = confidence >= this.threshold;

    if (matched) {
      const best = this.faqs[bestIndex];
      const related = this.getRelated(candidates, scores, bestIndex, best.category);
      return {
        answer: best.answer,
        matched: true,
        confidence: Math.round(confidence * 1000) / 1000,
        faq_id: best.id,
        category: best.category,
        matched_question: best.question,
        related,
      };
    }

    let related = this.getRelated(candidates, scores, null, null);
    if (related.length === 0) {
      related = this.suggestedQuestions(this.maxRelated).map((s) => ({
        id: s.id,
        question: s.question,
      }));
    }

    return {
      answer: FALLBACK_MESSAGE,
      matched: false,
      confidence: Math.round(confidence * 1000) / 1000,
      related,
    };
  }

  private getRelated(
    ranked: number[],
    scores: number[],
    exclude: number | null,
    fallbackCategory: string | null
  ): Array<{ id: string; question: string }> {
    const close: number[] = [];
    for (const i of ranked) {
      if (i !== exclude && scores[i] >= this.relatedThreshold) {
        close.push(i);
        if (close.length >= this.maxRelated) break;
      }
    }

    if (close.length === 0 && fallbackCategory) {
      for (let i = 0; i < this.faqs.length; i++) {
        if (this.faqs[i].category === fallbackCategory && i !== exclude) {
          close.push(i);
          if (close.length >= this.maxRelated) break;
        }
      }
    }

    return close.map((i) => ({ id: this.faqs[i].id, question: this.faqs[i].question }));
  }
}

export class UsageStats {
  private answered = 0;
  private unanswered = 0;
  private matches = new Map<string, number>();
  private helpful = new Map<string, number>();
  private notHelpful = new Map<string, number>();

  recordQuestion(matched: boolean, faqId?: string | null): void {
    if (matched && faqId) {
      this.answered++;
      this.matches.set(faqId, (this.matches.get(faqId) || 0) + 1);
    } else {
      this.unanswered++;
    }
  }

  recordFeedback(faqId: string, isHelpful: boolean): void {
    const targetMap = isHelpful ? this.helpful : this.notHelpful;
    targetMap.set(faqId, (targetMap.get(faqId) || 0) + 1);
  }

  snapshot(bot: FAQChatbot, topN = 5): any {
    const total = this.answered + this.unanswered;
    const sortedMatches = Array.from(this.matches.entries()).sort((a, b) => b[1] - a[1]);
    const topQuestions = sortedMatches.slice(0, topN).map(([faqId, count]) => {
      const faq = bot.getFaq(faqId);
      return {
        id: faqId,
        question: faq ? faq.question : "",
        count,
      };
    });

    let sumHelpful = 0;
    for (const v of this.helpful.values()) sumHelpful += v;

    let sumNotHelpful = 0;
    for (const v of this.notHelpful.values()) sumNotHelpful += v;

    return {
      total_questions: total,
      answered: this.answered,
      unanswered: this.unanswered,
      answer_rate: total > 0 ? Math.round((this.answered / total) * 1000) / 1000 : null,
      top_questions: topQuestions,
      feedback_helpful: sumHelpful,
      feedback_not_helpful: sumNotHelpful,
    };
  }
}
