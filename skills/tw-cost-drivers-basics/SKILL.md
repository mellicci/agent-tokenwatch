---
name: tw-cost-drivers-basics
description: Explain the fundamentals of coding-agent token economics from first principles - what a prompt, turn, and token are; why input, output, and cache reads/writes are priced differently; what a cache TTL actually does - so someone can recognize wasteful token practices on their own. Use when someone is new to this, asks what a token or a cache write is, why output costs more than input, or wants the concepts before their own numbers make sense.
---

# Cost drivers: the fundamentals

This is the **concept primer**, not a report. It explains the vocabulary and
economics behind every other skill in this bundle, so a number on the status
line or in an audit means something the first time someone sees it, not just the
fifth.

It does not read the user's telemetry and does not need to know which agent is
running. Once the concepts land, send them onward:

- **"What does *my* line say right now?"** → `tw-explain-statusline`
- **"Walk me through why a real session of mine was expensive"** → `tw-token-cost-coach`
- **"What actually happened this session / this week?"** → `tw-retrospective-this-session` / `tw-retrospective-overall`
- **"What should I change, and how do I test it?"** → `tw-cost-audit-define-experiment`

When you point the user to another Tokenwatch skill, write it the way their
agent invokes it: `/tw-<name>` in Claude Code and Copilot CLI, `$tw-<name>` in
Codex, where `/skills` also lists them.

## On invocation

Answer what was actually asked. If someone asks specifically "what's a cache
write", give the one paragraph, not the whole document. Offer the rest rather
than dumping it — this is reference material for someone building a mental
model, and a wall of text defeats that. If they ask for the fundamentals in
general, or say they're new to this, go through the sections in order below.

## The vocabulary

- **Token** — the unit a model is billed in. Not a word: roughly a few
  characters, or a word fragment. A short sentence is a dozen or two tokens; a
  thousand words is on the order of 1,300–1,500 tokens. Code and unusual
  formatting typically tokenize a little less efficiently than plain prose.
- **Prompt** — what the user sends in on a given turn.
- **Reply** (also called a **turn**) — the prompt plus the model's entire answer
  to it, however many tool calls happen along the way. Three tool round-trips
  inside one answer are still one reply, not three. This is the unit cost is
  actually attributed to.
- **Context** / **context window** — everything the model can see on a given
  call: the whole conversation so far, not just the latest message. This is why
  a long conversation costs more per reply even when the user's own message is
  short — the model re-reads everything before it, every single time.

## Why input, output, and cache are not the same price

These are priced differently because they cost the provider differently to
produce, and the ordering is consistent across providers even though the exact
multiples are not:

- **Output is the most expensive per token, usually by several times.**
  Generating text is sequential — the model produces one token, then the next
  conditioned on it, and so on. Reading existing text in parallel is cheap by
  comparison; writing new text one token at a time is not.
- **Ordinary (fresh) input sits in the middle.** The model has to read it, but
  reading is far cheaper than generating.
- **A cache read is the cheapest tokens in the whole system**, commonly on the
  order of a tenth of ordinary input price. If the provider already has this
  exact text in fast storage from a recent call, replaying it is nearly free
  computationally, and the saving is passed on.
- **A cache write costs *more* than ordinary input, not less.** Writing to the
  cache means asking the provider to hold this text in fast storage for a
  while — that storage has a cost, charged up front, in exchange for every later
  call that reuses it paying the cheap read price instead of full price. A write
  is a bet that the same prefix will be reused before it expires.

None of these exact rates are invented or looked up by this tool — they come
from the provider, change over time, and differ by model. The ordering above
(cache read cheapest, output priciest) is the part that stays true; treat any
specific multiple as a rule of thumb, not a quote.

## What a cache actually is

The cache holds the **prefix** of a conversation — the part that has not
changed since it was last sent. Caching works by exact match from the start of
the input: if the first 50,000 tokens of this call are byte-for-byte identical
to the first 50,000 tokens of a recent call, that portion is served as a read.
The moment anything early in the conversation changes — a different system
prompt, a toggled tool, an edited instruction, even a timestamp embedded near
the top — every token after that point stops matching, and the whole remainder
is billed as fresh input (or written fresh) again. This is why "keep stable
material first, volatile material last" is the single most load-bearing piece
of cache advice: the cache does not know two prefixes are "almost the same",
only whether they are identical.

## What the TTL is for

A cache entry does not live forever. The provider keeps it for a limited
window — the **TTL**, time-to-live — typically minutes to an hour depending on
the provider and plan. Every call that reuses the cache before it expires also
resets or extends that window; every call after it has expired pays to rebuild
the cache from nothing, at full fresh-input price for the whole prefix. Coming
back to a conversation after a coffee break is usually fine; coming back after a
much longer gap can mean paying to re-read the entire conversation once, in the
single most expensive event a normal session produces.

## Recognizing wasteful patterns

None of this requires reading telemetry — these are the shapes to watch for in
how a session is actually used:

| Pattern | Why it is expensive |
|---|---|
| A long conversation kept open across unrelated tasks | Every reply re-reads the whole accumulated context, most of it irrelevant to the current task |
| Toggling a tool, MCP server, or system instruction mid-session | Invalidates the cached prefix from that point on; the next call rebuilds it at full price |
| Returning to a session after the cache TTL has lapsed | Pays to rebuild the entire prefix as fresh input, the most expensive single event in normal use |
| Large, unfiltered tool or log output landing in the main conversation | That output becomes part of every future reply's re-read context, not just the one that produced it |
| Using the most capable (and priciest) model for mechanical, low-risk work | Output is the priciest token in the system; paying a premium rate for it on routine work compounds |
| A vague, broad prompt that triggers wide exploration | Wide exploration means more tool output and more context accumulated before the actual task starts |
| Waiting until a session is nearly out of context to compact | A late compaction produces a larger, more compressed (lossier) summary, and the turns right after often cost more while the model re-orients from a thinner summary |

Naming the pattern is the point of this skill; confirming it actually happened
in *this* user's data, and proposing a tested fix, is what the other skills in
this bundle are for.
