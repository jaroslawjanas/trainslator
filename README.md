# Trainslator

Trainslator translates EPUB books with AI. It learns from books that already have a human
translation, then uses what it learned when it translates a new book, and writes an EPUB in
the target language with the original formatting.

It runs on your own computer: a local server with a browser UI. It talks to Anthropic's API,
to Ollama (on your computer or on Ollama Cloud) through Ollama's own API, and to any
OpenAI-compatible API (OpenAI, OpenRouter, DeepSeek, Gemini, vLLM and others). Your books,
knowledge bases and logs stay in a folder on your disk.

## How it works

1. **Reference pairs (phase 1).** You add an English book and its published translation. The
   app proposes which chapters match; you check and confirm. The AI then reads each chapter
   pair and builds a knowledge base of the translator's decisions: names, invented terms,
   wordplay, forms of address and style. Ordinary words are left out.
2. **The new book (phase 2).** The AI reads the new English book chapter by chapter, before
   anything is translated. It writes a synopsis of each chapter and builds the book's own
   knowledge base, consistent with the reference pairs. Things it can't decide yet (say, a
   character's gender) become open questions that later chapters, or you, answer.
3. **Translation (phase 3).** The book is translated in chunks, with both knowledge bases in
   every request. Inline formatting (italics, links, footnote markers) travels as placeholders
   and is put back exactly; everything outside the translated text stays byte for byte as it
   was. You review the result side by side, fix or re-translate units, and build the EPUB.

You can stop after each phase to review and edit the knowledge bases. Your edits are kept when
a phase runs again.

The source language is English (the instructions to the AI are written in English). The
target can be any language, including right-to-left ones.

## Requirements

- **Node.js 24.21 or newer.** With nvm: `nvm install` and `nvm use` read the version from
  `.nvmrc`.
- **pnpm 12.** With Corepack: `corepack enable`. pnpm then picks the version pinned in
  `package.json`.
- **An API key** for Anthropic, Ollama Cloud or an OpenAI-compatible provider, or a local
  server such as Ollama or vLLM.

## Getting started

```sh
pnpm install
cp .env.example .env      # then add your API key(s), see below
pnpm dev
```

Open http://localhost:5173. Then:

1. **Settings → Connections and models:** add a connection (choose the provider kind, which
   fills in sensible defaults), add one or more models, and press **Test**. The test sends a
   few small requests and suggests settings that work with that provider.
2. **Settings → Models for each step:** choose a model for each step. A fast model is fine for
   phase 1, a medium one for phase 2, and the strongest you can afford for phase 3.
3. **Projects:** create a project with the target language. Generate the language notes and
   adjust them if you like; they go into every request.
4. Add reference pairs, then the book. The sidebar lists each book's stages (setup, reading,
   knowledge base, translation, build) and marks the ones that are done.

`pnpm dev` runs the API server (port 5174) and the UI dev server (port 5173) together. For
everyday use, build the UI once and run a single server:

```sh
pnpm build
pnpm start                # http://127.0.0.1:5174
```

## API keys

Keys are read by the server and never sent to the browser. Two ways to give a key:

- **Environment variable (recommended):** put it in `.env`, for example
  `OPENROUTER_API_KEY=sk-…`, and in the connection choose "Environment variable" with that
  name. `.env` is not committed. Restart the server after changing `.env`.
- **Paste key:** it is stored in `data/settings.json` on your disk, and shown masked in the UI.

## Data folder

Everything is stored as JSON files in `./data` (not committed), or in the folder set by
`TRAINSLATOR_DATA_DIR`:

```
data/
  settings.json                  connections, models, step defaults
  jobs/                          running and finished jobs
  projects/<id>/
    project.json, language-notes.md
    pairs/<id>/                  the two EPUBs, alignment, phase 1 work, kb.json
    books/<id>/                  the EPUB, phase 2 and 3 work, kb.json, output/
    logs/calls.jsonl             one line per AI request: tokens, cache hits, cost
    cache/llm/                   answers that passed the checks, reused when a request repeats
```

Back up the folder to keep your work. Deleting a project deletes its folder.

## Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | Port of the API server (default 5174). |
| `TRAINSLATOR_DATA_DIR` | Where the data folder is (default `./data`). |
| `TRAINSLATOR_LOG_BODIES` | `1` saves the full request and response of every AI call in `logs/calls/`. Useful when a step misbehaves; the files contain book text and get large. |
| Your key variables | Any names you use in connections, for example `OPENAI_API_KEY`. |

## Security

The server listens on 127.0.0.1 only. It rejects requests from other websites (by checking the
`Host` and `Origin` headers), accepts only JSON or file uploads, and never shows stored keys.
Don't expose the port to a network: there are no user accounts.

## Costs

Each phase shows an estimate of tokens (and cost, when you enter the model's prices) before it
runs, and each project's **Usage** page shows what was actually used per step. Requests are
arranged so that the long, unchanging parts (instructions and knowledge bases) come first,
which lets providers with prompt caching charge less for them.

For a sense of scale: a 37,000-word book with one reference pair (a 19,000-word book and its
translation) took about 55 requests over all three phases with a fast model: about 1 million
input tokens, most of them cached, and 170,000 output tokens, in about 6 minutes.

## Other commands

| Command | What it does |
|---|---|
| `pnpm check` | Type check, lint and tests. |
| `pnpm test:live --base-url … --model … --kind … --key-env …` | Runs every step against a real API on a tiny invented book (about 15 small requests) and reports whether prompt caching works. |
| `pnpm test:corpus` | Round-trips every EPUB in `data/corpus` through the reader and writer without AI, and reports anything that wouldn't survive translation unchanged. Good for checking unusual books. |
| `pnpm translate:dev book.epub --target pl --base-url … --model …` | Phase 3 and build from the command line, without knowledge bases. For debugging. |

## Limitations

- Source books must be in English.
- Fixed-layout EPUBs and DRM-protected books are rejected.
- Text inside images, SVG and MathML is left as is.
- For right-to-left targets, the text direction is set, but the book's CSS is not mirrored.
- One user, one computer.
