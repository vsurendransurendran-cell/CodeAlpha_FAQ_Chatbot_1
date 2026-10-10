# CodeAlpha_FAQ_Chatbot

**AI-Powered Frequently Asked Questions Chatbot** — a web chatbot that answers questions by finding the closest match in a JSON knowledge base using TF-IDF and cosine similarity.

> Built as part of the CodeAlpha AI Internship. Author: `<YOUR NAME>` · GitHub: `<YOUR GITHUB USERNAME>`

## Overview
Users type a question in a chat interface. The server compares it with the stored FAQ questions, and returns the best answer if the match is confident enough. Otherwise it says it doesn't know and suggests related questions instead of guessing.

**This is a retrieval system, not a generative AI/LLM.** Every answer is taken word-for-word from `data/faqs.json`.

## Problem statement
People repeatedly ask the same questions. A chatbot that understands rephrased and slightly misspelled questions saves time compared with scrolling through a static FAQ page.

## Objectives
- Match questions by meaning-like similarity, not exact text.
- Avoid confidently answering unrelated questions.
- Keep FAQ content in data, so anyone can extend it without touching Python.
- Provide a clean, responsive, accessible chat UI.

## Features
- Chat UI: user/bot bubbles, timestamps, welcome message, suggested questions, typing indicator, Enter-to-send, clear conversation, empty-input validation, friendly error messages
- TF-IDF + cosine similarity matching with a configurable confidence threshold
- Light spelling correction (e.g. "pyhton" → "python")
- Fallback response plus related-question suggestions
- 46 sample FAQs in 6 categories (General Information, Technology, Education, Programming, AI Fundamentals, Student Questions)
- Optional extras: dark/light theme, category filter, export conversation as `.txt`, 👍/👎 feedback, usage statistics (counts only, no message text stored)
- JSON API with proper status codes, input-length limits, health check, and no internal error details exposed

## Technology stack
Python · Flask · scikit-learn · NumPy · HTML5 · CSS3 · vanilla JavaScript · JSON · unittest

## Project structure
```
CodeAlpha_FAQ_Chatbot/
├── app.py               Flask app and API routes (HTTP only)
├── chatbot.py           FAQ loading, text processing, matching, threshold, stats
├── requirements.txt
├── data/faqs.json       Knowledge base
├── templates/index.html Chat page
├── static/style.css     Styling (responsive, light/dark)
├── static/script.js     Chat behaviour and API calls
└── tests/test_chatbot.py
```

## Setup on Windows (PowerShell, VS Code)
```powershell
py --version                                   # needs Python 3.12+ (NumPy 2.5 requires it)
cd CodeAlpha_FAQ_Chatbot
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```
Open http://127.0.0.1:5000. No script activation is needed because commands call the venv's Python directly.

Optional settings (environment variables): `FAQ_THRESHOLD` (default `0.40`), `FAQ_FILE` (path to another FAQ file), `FLASK_DEBUG=1` (auto-reload).

## Usage
Type a question or click a suggestion. Use the dropdown to limit answers to one category, 📊 for statistics, ⬇ to export the chat, 🌓 to switch theme. The conversation lives in the browser session only.

Example questions: "What is Python?", "Can you explain machine learning?", "how do I learn programing", "What is a CPU?"

## Adding FAQs
Edit `data/faqs.json` and add an entry (no Python changes needed), then restart the server:
```json
{
  "id": "prog-git",
  "category": "Programming",
  "question": "What is Git?",
  "alternative_questions": ["Why use Git?", "What is version control?"],
  "answer": "Git is a version control system that tracks changes to your code."
}
```
`id` must be unique. Invalid entries are skipped with a warning, and the server still starts if at least one entry is valid.

## How question matching works
1. **Normalise**: lowercase, remove punctuation and filler words ("what", "is", "the"…).
2. **Spelling repair**: unknown words of 4+ letters are replaced by the closest word in the FAQ vocabulary (only if very similar).
3. **TF-IDF**: each FAQ phrase becomes a vector of weighted terms. Words that are rare across the FAQs get more weight than common ones. Two vectorisers are used — one over words and word pairs, one over character 3–4-grams — and their scores are averaged 50/50.
4. **Cosine similarity** measures the angle between the question vector and each FAQ vector: 1 = same direction (very similar wording), 0 = nothing in common.
5. **Threshold**: the best score is the confidence. At or above `0.40` the answer is returned; below it the bot returns a fallback.

Things to know:
- Similar-looking questions can score differently because TF-IDF weights rare words more than common ones.
- **Similarity is not correctness.** A high score means the wording is close, not that the answer is true for the user's situation.
- A lower threshold answers more questions but risks wrong answers; a higher one is safer but falls back more often.
- Unrelated questions need a fallback, otherwise the bot would always return its "least bad" answer.

## Testing
```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
The 30 tests cover exact, rephrased, misspelled, empty, unrelated and repeated questions; missing, invalid and malformed knowledge-base files; API validation and status codes; feedback, stats and the health check. Last run in the development environment: 30 passed (Python 3.13, Linux). Run them on your own machine and record your result.

## Limitations
- Only knows what is in `data/faqs.json`; it cannot reason, combine facts or hold context across turns.
- Matching is lexical (word/character overlap). Synonyms that share no letters (e.g. "car" vs "automobile") are not understood.
- Spelling correction only fixes words close to the FAQ vocabulary; heavily misspelled input can still fall back.
- Statistics are in memory and reset on restart. Chat history is kept per browser session only.
- Built for local development (Flask's development server); not hardened for production.

## Future improvements
Sentence-embedding matching for synonyms, persistent analytics, an admin page for editing FAQs, multi-language support, deployment with a production server (e.g. Waitress/Gunicorn).

## Internship
Developed for the CodeAlpha AI Internship.
