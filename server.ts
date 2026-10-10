import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  FAQChatbot,
  UsageStats,
  DEFAULT_THRESHOLD,
  InvalidQuestionError,
  UnknownCategoryError,
  FAQDataError,
} from "./src/chatbot.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_QUESTION_LENGTH = 500;
const MAX_BODY_SIZE = 16 * 1024; // 16 KB

const PORT = parseInt(process.env.PORT || "3000", 10);

// Resolve FAQ path: check env FAQ_FILE, ./faqs.json, ./data/faqs.json
let defaultFaqPath = path.resolve(__dirname, "faqs.json");
if (!fs.existsSync(defaultFaqPath) && fs.existsSync(path.resolve(__dirname, "data", "faqs.json"))) {
  defaultFaqPath = path.resolve(__dirname, "data", "faqs.json");
}

const faqPath = process.env.FAQ_FILE ? path.resolve(process.env.FAQ_FILE) : defaultFaqPath;
const threshold = process.env.FAQ_THRESHOLD
  ? parseFloat(process.env.FAQ_THRESHOLD)
  : DEFAULT_THRESHOLD;

let bot: FAQChatbot | null = null;
let loadError: string | null = null;

try {
  bot = new FAQChatbot(faqPath, threshold);
  console.log(`[FAQ Bot] Loaded ${bot.faqs.length} FAQs from ${faqPath}`);
  if (bot.skipped.length > 0) {
    console.warn(`[FAQ Bot] ${bot.skipped.length} malformed FAQ entries skipped`);
  }
} catch (err: any) {
  loadError = err.message || "Failed to load FAQ knowledge base";
  console.error(`[FAQ Bot] Chatbot could not start:`, loadError);
}

const stats = new UsageStats();

const app = express();

// Security / limits
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Serve static assets at root and /static
app.use("/static", express.static(__dirname));
app.use(express.static(__dirname));

function unavailable(res: Response) {
  return res.status(503).json({
    error: "The chatbot is temporarily unavailable. Please try again later.",
  });
}

// Routes
app.get("/api/health", (_req: Request, res: Response) => {
  if (!bot) {
    return res.status(503).json({ status: "unavailable", faq_count: 0 });
  }
  return res.json({
    status: "ok",
    faq_count: bot.faqs.length,
    categories: bot.categories.length,
    skipped_entries: bot.skipped.length,
  });
});

app.get("/api/config", (req: Request, res: Response) => {
  if (!bot) {
    return unavailable(res);
  }
  const category = (req.query.category as string) || null;
  return res.json({
    categories: bot.categories,
    category_counts: bot.categoryCounts,
    total_faqs: bot.faqs.length,
    suggestions: bot.suggestedQuestions(6, category),
    max_length: MAX_QUESTION_LENGTH,
  });
});

app.get("/api/faqs", (req: Request, res: Response) => {
  if (!bot) {
    return unavailable(res);
  }
  const category = (req.query.category as string) || null;
  const q = (req.query.q as string) || undefined;
  const offset = parseInt((req.query.offset as string) || "0", 10) || 0;
  const limit = Math.min(parseInt((req.query.limit as string) || "150", 10) || 150, 200);

  const searchResult = bot.searchFaqs({ category, query: q, offset, limit });
  return res.json({
    total: searchResult.total,
    categories: bot.categories,
    category_counts: bot.categoryCounts,
    faqs: searchResult.faqs,
  });
});

app.post("/api/ask", (req: Request, res: Response) => {
  if (!bot) {
    return unavailable(res);
  }

  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: 'Request must be JSON like {"question": "..."}.' });
  }

  const rawQuestion = data.question;
  if (typeof rawQuestion !== "string") {
    return res.status(400).json({ error: "'question' must be text." });
  }

  const question = rawQuestion.trim();
  if (!question) {
    return res.status(400).json({ error: "Please type a question." });
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return res
      .status(400)
      .json({ error: `Please keep your question under ${MAX_QUESTION_LENGTH} characters.` });
  }

  const category = data.category || null;
  if (category !== null && typeof category !== "string") {
    return res.status(400).json({ error: "'category' must be text." });
  }

  try {
    const result = bot.ask(question, category);
    stats.recordQuestion(result.matched, result.faq_id);
    return res.json(result);
  } catch (err: any) {
    if (err instanceof InvalidQuestionError || err instanceof UnknownCategoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Unexpected error while answering a question:", err);
    return res
      .status(500)
      .json({ error: "Something went wrong while answering. Please try again." });
  }
});

app.post("/api/feedback", (req: Request, res: Response) => {
  if (!bot) {
    return unavailable(res);
  }

  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: "Request must be JSON." });
  }

  const { faq_id, helpful } = data;
  if (typeof faq_id !== "string" || !bot.getFaq(faq_id)) {
    return res.status(400).json({ error: "Unknown FAQ id." });
  }

  if (typeof helpful !== "boolean") {
    return res.status(400).json({ error: "'helpful' must be true or false." });
  }

  stats.recordFeedback(faq_id, helpful);
  return res.json({ status: "recorded" });
});

app.get("/api/stats", (_req: Request, res: Response) => {
  if (!bot) {
    return unavailable(res);
  }
  return res.json(stats.snapshot(bot));
});

// HTML index
app.get("/", (_req: Request, res: Response) => {
  return res.sendFile(path.resolve(__dirname, "index.html"));
});

// 404 Handler
app.use((req: Request, res: Response) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found." });
  }
  return res.status(404).send("Page not found.");
});

// Error handler
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request is too large." });
  }
  if (err.status === 400 || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Request must be JSON like {"question": "..."}.' });
  }
  console.error("Server error:", err);
  return res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[FAQ Bot] Server running on http://0.0.0.0:${PORT}`);
});
