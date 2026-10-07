# AI Browser Agent

<p>
  <a href="https://github.com/maketostep/ai-browser-agent/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/maketostep/ai-browser-agent?color=0a7cff"></a>
  <a href="LICENSE"><img alt="License: ISC" src="https://img.shields.io/badge/license-ISC-green.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6.svg?logo=typescript&logoColor=white">
  <img alt="Playwright" src="https://img.shields.io/badge/Playwright-1.63-2EAD33.svg?logo=playwright&logoColor=white">
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-8A2BE2.svg">
  <img alt="Tests: 113 passing" src="https://img.shields.io/badge/tests-113%20passing-brightgreen.svg">
  <a href="https://drive.google.com/drive/folders/1_eNxxeEn8oQtB7TbR2LPn6ehaEy67_yI?usp=sharing"><img alt="Demo video" src="https://img.shields.io/badge/demo-video-red.svg?logo=googledrive&logoColor=white"></a>
</p>

**English** | [Русский](README.ru.md)

**Demo video:** [Google Drive](https://drive.google.com/drive/folders/1_eNxxeEn8oQtB7TbR2LPn6ehaEy67_yI?usp=sharing)
(three runs of 6–7 minutes each, terminal and browser in one frame).

You type a task in the terminal, and the agent carries it out in a real, visible Chrome. It
explores the page on its own, picks what to click, recovers from failures and asks you before
any irreversible action.

The agent knows no website in advance. The code has no selectors, paths, button names or
scripted scenarios. The section "How to verify there are no scripted hints" shows how to check.

## Quick start

The fastest way in is the Claude Code plugin. You need [Claude Code](https://code.claude.com),
Node.js 20+ and Chrome. No API key and no clone: Claude Code thinks under your subscription,
and the plugin gives it the browser.

```bash
claude plugin marketplace add maketostep/ai-browser-agent
claude plugin install ai-browser-agent@maketostep
```

Start a new Claude Code session in any project and give it a task:

```
> Open news.ycombinator.com and list the five top stories with their points.
```

Chrome opens at the first browser tool call. Before any irreversible action (payment,
sending, deleting) Claude Code asks you in a dialog.

## Ways to connect

| Way | Fits | API key | Where it works |
|---|---|---|---|
| [Plugin](#claude-code-plugin) | everyday use | not needed | every project in Claude Code |
| [MCP from a clone](#mcp-from-a-clone) | working on the agent's code | not needed | Claude Code inside this repository |
| [Standalone agent](#standalone-agent) | the full architecture: own loop, sub-agents, risk classifier | required | terminal, `npm run dev` |

The first two ways run the same MCP server. They differ in where the code and the browser
profile live. The third way runs the agent's own loop with no Claude Code involved.

### Claude Code plugin

Install it with the two commands from "Quick start". Inside a session the same commands start
with `/plugin`. Claude Code installs `node_modules` from `package-lock.json` when it caches the
plugin. The server shows up in `/mcp` as `plugin:ai-browser-agent:browser`.

The browser profile lives in `~/.claude/plugins/data/ai-browser-agent-maketostep/profile`, so
logins survive project switches and plugin updates. Need an account for a task? Log in by hand
in the window the agent opened.

| Action | Command |
|---|---|
| Update | `claude plugin update ai-browser-agent@maketostep` |
| Uninstall, profile included | `claude plugin uninstall ai-browser-agent@maketostep` |
| Uninstall, keep the profile | add `--keep-data` |
| Try a local clone as a plugin | `claude --plugin-dir /path/to/ai-browser-agent` after `npm install` in it |

### MCP from a clone

```bash
git clone https://github.com/maketostep/ai-browser-agent.git
cd ai-browser-agent
npm install
claude            # .mcp.json registers the browser server
```

On first launch Claude Code asks whether to trust the `browser` server from `.mcp.json`. Then
you type tasks directly in Claude Code. Chrome opens on `.profile/` at the first tool call, so
a session that never touches the browser never starts it. Only one Chrome can hold the profile
at a time, so `npm run dev` and a Claude Code session that already used the browser cannot run
together.

The project `.mcp.json` and the plugin both define a server named `browser`. `plugin.json`
declares its own `browser` inline, and in the plugin copy that entry replaces the one from
`.mcp.json`.

### What MCP mode carries over and what it lacks

Both MCP ways keep page distillation, `data-agent-ref` refs, error handling (`stale_ref`,
intercepted clicks, new tabs, native dialogs) and the security gate. The gate's question
reaches Claude Code as an MCP elicitation dialog. If the client does not support elicitation,
the gate treats that as a refusal. The server passes a condensed version of the system
prompt's page rules to the client in the `instructions` field.

| Standalone agent (`npm run dev`) | MCP mode |
|---|---|
| Own agent loop, step limit, loop detector | Claude Code runs the loop |
| Observation pruning and server-side context editing | Claude Code auto-compaction |
| `query_page` sub-agent | None: it needs an API key |
| Risk classifier and deterministic floor | Deterministic floor and post-refusal mode only |

The standalone agent shows the architecture. MCP mode lets you use the same browser layer
under a subscription.

### Standalone agent

```bash
npm install
cp .env.example .env        # add a key, see "Model provider"
npm run dev
```

You need Chrome installed. The agent launches it with `channel: "chrome"` instead of the
bundled Chromium: real Chrome gives anti-bot systems fewer reasons to fire.

The first run opens an empty browser. If a task needs an account, log in by hand in that
window. The profile lives in `.profile/` and survives process restarts.

```
You: Order me a BBQ burger and fries on lavka.yandex.ru. Go as far as checkout, but don't pay.
```

Changed your mind mid-task? Press Ctrl+C. The agent aborts the model request, withdraws the
pending gate question (the action does not run), finishes a click already in progress and
waits for a new task. Ctrl+C while idle, or `exit`, quits the program.

Closed the Chrome window? The agent reopens the browser on the same profile at its next
action, and your login stays.

## Model provider

The agent speaks the Anthropic Messages API protocol. Anthropic and compatible gateways
understand it, so the provider is a configuration choice.

| Provider | What goes in `.env` | Default model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` ([console](https://console.anthropic.com)) | `claude-sonnet-5`, sub-agents on `claude-haiku-4-5` |
| OpenRouter | `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` ([keys](https://openrouter.ai/keys)); optionally `OPENROUTER_SUB_MODEL`, `OPENROUTER_FALLBACK_MODEL`, `OPENROUTER_BASE_URL` | none, the model is required |
| z.ai (GLM) | `ZAI_API_KEY` ([apikey-list](https://z.ai/manage-apikey/apikey-list)) | `glm-4.6` |

The agent picks the provider from whichever key is set; `AGENT_PROVIDER` sets it
explicitly. The original spec requires Claude or OpenAI models: on OpenRouter that means
`anthropic/*` and `openai/*`. GLM is for debugging only.

Check the setup before running the agent:

```bash
npx tsx scripts/check-provider.ts   # which provider is selected, no requests
npx tsx scripts/check-api.ts        # live request: auth, tool calling, streaming
```

**Anthropic extensions.** Adaptive thinking, `effort`, server-side context editing and prompt
caching work only with Anthropic. Other gateways answer 400 to an unknown field, so
`src/agent/provider.ts` declares each capability as a flag and never sends it where it is
missing. On startup the agent prints what the current provider lacks. On OpenRouter and z.ai
you keep client-side pruning, the loop, the tools and the gate, but pay for every step in
full.

**OpenRouter.** The gateway accepts the Anthropic protocol at `https://openrouter.ai/api`.
The key goes only into `Authorization: Bearer`, and the SDK will not pick up
`ANTHROPIC_API_KEY` from the environment. The agent strips a trailing `/v1` from
`OPENROUTER_BASE_URL` itself, because the SDK appends `/v1/messages`.

**Provider failures.** `src/agent/retry.ts` retries with pauses of 3, 8, 20 and 45 s on 429,
5xx, a response without `content`, and `overloaded_error` inside a stream. Retries of a step
go to the fallback model (`OPENROUTER_FALLBACK_MODEL`, the sub-model by default); the next
step starts on the main model again. The agent recognizes an exhausted quota by
`x-ratelimit-remaining: 0` and reports when it resets, instead of a minute of useless
retries.

Free OpenRouter models share a daily limit per account: 50 requests without a top-up. A
20-step task with the risk classifier uses up almost all of it.

## How it works

```
  terminal (REPL)                    Node process                        Chrome (visible)
  ---------------                    ------------                        ----------------
  You: task in text   ──▶  ┌────────────────────────┐
                           │ agent loop (model      │
        🔧 tool call   ◀── │ from .env)             │
                           │  observation → decision│
                           │         │              │
                           │         ▼ action       │──▶ Playwright ──▶ page
                           │  ┌──────────────┐      │                    │
                           │  │ security gate│      │◀── distillation ◀─┘
                           │  └──────┬───────┘      │
                           │         │ high risk    │
  Proceed? [y/N]  ◀────────┼─────────┘              │
                           │  sub-agents (sub-      │
                           │  model): query_page,   │
                           │  risk classifier       │
                           └────────────────────────┘
```

One agent step costs one model call: an action returns a fresh observation in the same
result, with no separate "now look" round trip.

| File | Responsible for |
|---|---|
| `src/index.ts` | REPL, task cancellation on Ctrl+C |
| `src/mcp.ts`, `src/mcp-server.ts` | MCP entry point: tools, elicitation, instructions |
| `src/browser/distill.ts` | compressing a page into a list of elements with refs, collapsing overlays |
| `src/browser/actions.ts` | actions by ref, waiting for page readiness, error classification |
| `src/browser/session.ts` | persistent profile, tabs, native dialogs, browser restart |
| `src/agent/loop.ts` | loop, streaming, fallback model, loop detector, step limit |
| `src/agent/context.ts` | observation format and history pruning |
| `src/agent/tools.ts` | tool descriptions and dispatcher |
| `src/agent/security.ts` | confirmation gate before irreversible actions |
| `src/agent/subagents.ts` | DOM sub-agent and risk classifier |
| `src/agent/provider.ts`, `client.ts` | provider selection, capability flags, auth |
| `src/agent/retry.ts` | retries, fast failure on an exhausted quota |
| `src/agent/prompt.ts` | system prompt |

## Context management

The model never receives a whole page. Measurements on `lavka.yandex.ru`:

| Representation | Size | vs raw HTML |
|---|---|---|
| Raw HTML | 433,953 chars | 1x |
| Playwright `ariaSnapshot()` | 7,153 chars | 60x |
| Our element list | 2,321 chars (63 elements) | 186x |
| Full observation (elements, text, metadata) | 4,648 chars (61 elements) | 93x |

186x counts only the list of interactive elements, which compares directly with
`ariaSnapshot`. 93x counts the whole object sent to the model, visible text included.

An observation fits an 8,000-character budget: the page text gets whatever the element list
leaves. The agent never trims the list itself, because it acts on it. On the hh.ru home page
(204 elements) the observation exceeds the budget, and that is a deliberate trade-off.

Text is cut around what is on screen right now, not from the top of the page. A chat or feed
scrolled to the bottom shows the agent the latest content, and the window edges carry
`[…выше ещё N симв.]` and `[…ниже ещё N симв.]` markers ("N more chars above/below"), so the
agent knows which way to scroll.

Two more levels work on top of that:

- **Client-side pruning** (`src/agent/context.ts`): the history keeps the last 3
  observations in full and collapses the rest into a stub. Refs in old snapshots are invalid
  anyway.
- **Server-side context editing** (`clear_tool_uses_20250919`): Anthropic only; it turns
  itself off if the beta is unavailable to the account.

The system prompt and tool definitions do not change during a run, and Anthropic caches
them. The terminal prints `in/out/cache_read` for every step.

## Addressing elements without selectors

The agent sees lines like `[e3] searchbox "Поиск"` and answers with a ref. Distillation
assigns refs while walking the DOM (`data-agent-ref`), and each ref lives for one snapshot:
after any action the agent gets new ones. A stale ref returns a `stale_ref` error with a fresh
observation, so a click can never land on a random element. There is no tool for clicking by
CSS selector.

## Security layer

The gate lives in the harness, not in the model, and has three independent levels. Each one
appeared after a live run broke through the previous one.

**1. Classifier.** For mutating tools, a sub-agent rates the risk from the element's
description, the agent's stated intent, the task and the list of already refused actions. The
prompt tells it to judge what the element does, not how the agent described it.

**2. Deterministic floor.** Code itself recognizes spending money, sending to a recipient,
deleting, publishing, and statements made on the person's behalf (age, identity, consent).
The classifier can raise the rating above the floor but never lower it.

**3. Post-refusal mode.** After the person refuses, every state-changing action needs its own
confirmation until the person approves something again.

Non-mutating tools pass without a rating. Native `confirm()` dialogs go to the person. A
classifier failure counts as `high`. Cancelling a task during a gate question counts as a
refusal.

### Why the floor exists after all

At first a list of dangerous actions looked like exactly the kind of scripted hint the spec
forbids. Two live runs proved otherwise.

The agent worked around a refusal: the gate stopped "Clear cart", and the agent emptied the
cart with the "Decrease quantity" button, which the classifier considered reversible. Later
the agent confirmed legal age on the user's behalf, wrote "close the modal" as its `intent`,
and passed as `medium`.

Prompt fixes ran into instability: the same age confirmation on an identical prompt got `high`
on one run and `low` on another. Protection against irreversible actions cannot rest on the
judgment of a probabilistic model.

The spec forbids hints on how to **solve tasks**: scenario steps, selectors, elements. Safety
rules help achieve nothing; they restrict the agent and know no website.

### How it is tested

```bash
npx tsx scripts/eval-risk.ts 3     # 11 cases, 3 runs
```

The eval measures the gate's final decision, not the classifier's opinion. The cases come
from live runs and spec scenarios: payment, applying for a job, deleting an email, age
confirmation, working around a refusal. A control group of ordinary actions has to pass
silently. Result: 11/11 across three runs.

**Injection defense.** Page text is marked `untrusted="true"`, and the system prompt forbids
following instructions from the page. Code that never read the page makes the gate decision,
so nothing inside the model can switch the gate off. A failed classifier closes the gate
(`tests/security.test.ts`).

## How to verify there are no scripted hints

Everything the model reads lives in the system prompt, the tool descriptions, the MCP
server's instructions and the sub-agent prompts. They contain no site names, selectors or
buttons:

```bash
grep -nEi "lavka|лавк|yandex|яндекс|hh\.ru|data-qa|корзин" \
  src/agent/prompt.ts src/agent/tools.ts src/mcp-server.ts src/agent/subagents.ts
# the only match: a // comment in subagents.ts that the model never sees
```

Comments in `src/browser/` name the sites where bugs turned up: they are a log of reasons and
never reach the model. The only addresses in the code belong to model providers. The agent
takes site URLs from the task text or from `href` attributes on the page.

## Tests

```bash
npm test         # 113 tests
npm run typecheck
```

Browser tests run on real headless Chrome. Distillation relies on real layout
(`getBoundingClientRect`, `getComputedStyle`), which jsdom does not compute: every size there
is zero, and the visibility check degenerates.

A smoke run of the production observation code on a live site, with no model calls:

```bash
npx tsx scripts/smoke-observe.ts https://lavka.yandex.ru
```

## Measuring the agent

The security eval checks the gate. `npm run eval` checks the agent: eleven local pages in
`evals/tasks.ts`. Seven test actions (a blocking banner, a hidden radio button, pagination,
search, two gate refusals, a prompt injection), and their checks read the final page state,
not the model's words. Four test extracted data, and their checks read the `finish` report:
a struck-out old price next to the new one, one cell in a 30-row table with look-alike
names, a count across three pages where "нет в наличии" contains "в наличии", and a field
missing from the page, where the right answer is "not listed" and an invented value fails.
Checks use regexes, not an LLM judge, so a run costs nothing extra and gives the same verdict
every time. The table prints the agent's report for every failed run.

```bash
npm run eval                  # every task once, headless Chrome
npm run eval -- --repeat 3    # three runs each: the model is not deterministic
npm run eval -- pagination    # one task by id
```

The table shows success, steps, tokens and seconds per run. A reference solution for each
page runs in `npm test`, so a failure on a page means the agent failed, not the fixture.
The eval spends tokens and needs a working risk classifier: a provider model that skips the
`report_risk` tool call makes the gate refuse every action. Set `OPENROUTER_SUB_MODEL` to a
model that supports forced tool calls if the table fills with refusals.

## One-off runs and limits

`npm run task -- "open example.com and tell me what is there"` runs one task without a
person. The gate refuses every high-risk action. The exit code is 0 only when the agent
reached `finish`.

| Variable | Effect |
|---|---|
| `AGENT_MAX_STEPS` | step limit per task, default 40 |
| `AGENT_TOKEN_BUDGET` | stop after this many input plus output tokens, default none |
| `AGENT_AUTO_APPROVE` | `1` drops the gate question: the gate still classifies and logs, then allows; payments and deletions run unconfirmed |

Every task ends with a line of totals: steps and tokens.

## Memory

The agent saves lasting facts with the `remember` tool into `.profile/notes.json`: at most
30 notes of 300 characters, the oldest drop out first. The next task receives them in its
first message, marked as data that does not replace confirmations. The file is plain JSON,
edit it by hand. MCP mode has no `remember`: Claude Code keeps its own memory.

## Decision log

Measurements are in `RESEARCH.md`, the original specification in `SPEC.md` (both in
Russian).

**Playwright rather than Puppeteer or Selenium.** The agent needs a persistent profile
(`launchPersistentContext`), frame handling and auto-waiting. On top of that, the built-in
`ariaSnapshot` gave a baseline to compare our distillation against.

**Own distillation instead of `_snapshotForAI`.** Playwright MCP gets ready-made refs from the
internal `page._snapshotForAI()`. Playwright 1.63 has no such method on `Page`: there are
`ariaSnapshot` and `ariaSnapshotJSON`, and neither has refs. Our distillation came out three
times more compact than the a11y snapshot and does not depend on a private API.

**Modals break the a11y approach.** The first `ariaSnapshot()` measurement returned 290
characters: an open `[role=dialog][aria-modal]` trims the accessibility tree down to itself.
An agent working from the a11y snapshot sees only the popup at that moment. Hence the prompt
rule: on a new page, recognize and close the modal first.

**`__name is not defined`.** `tsx` compiles through esbuild with `keepNames` and wraps inner
functions in a `__name` helper. Playwright moves a function into the page via `toString()`,
the helper is missing there, and distillation failed on every call. A proof of concept in
plain `.mjs` never showed this. A shim now goes into the page as a string, bypassing
compilation (`Actions.shimEsbuildHelpers`).

**Silent `catch` blocks.** The same bug exposed a second problem: the code swallowed the main
frame's error, and the agent got "no interactive elements found" instead of "failed to read
the page". Now a main-frame failure lands in the observation as a warning.

**The gate invalidated refs.** The first live run failed twice with `stale_ref`. Before a
mutating action the gate called `observe()` for the URL and title, and `observe()` reassigns
every `data-agent-ref`. In the worst case a ref would point at a different element, and the
click would land elsewhere with an already approved intent. The gate now takes only
`pageInfo()`, and `browser.test.ts` catches the regression.

**Hand-written loop instead of the SDK tool runner.** The loop controls the history
(pruning), the moment between decision and action (the gate) and what gets printed to the
terminal. `disable_parallel_tool_use` keeps the browser sequential.

**When a page is "ready".** An MCP run on Lavka showed three observation defects that the
fixtures missed. The first observation after navigation was empty while a modal faded in.
After a search, products came marked "covered by div.fade": the layer was fading, while the
element count had already stopped changing. After Enter there were no products at all,
because they arrived in a fetch response that had not come back yet. Now `settle()` waits for
a stable element count, for finite CSS animations to end and for fresh fetch/xhr responses.
It ignores requests older than 2 s, since analytics beacons never finish. Distillation also
strips U+00AD soft hyphens: on Lavka they sat inside product names and broke text matching
for the model.

**Dialogs without `aria-modal`.** Proper markup hides the page under a dialog with
`aria-hidden`. Lavka's address dialog does not, and produced 121 elements, almost all
"covered", with the dialog's buttons at the end of the list. If at least 60% of the elements
in the viewport are covered, distillation keeps the uncovered elements and the contents of the
`position: fixed` layer and collapses the page under the dialog into one line. On Lavka that
left 7 elements. A banner over the page, or a permanent `div.fade` over the first row of
products, stays below the threshold.

**The browser got closed.** A person logged in and closed the Chrome window, and every tool
failed with `browser has been closed`. The session restored closed tabs but not a closed
browser. Now it relaunches Chrome on the same profile and tells the agent. Along the way a bug
turned up: `stale_ref` called `observe()` twice, the first call consumed the notes, and the
agent never learned why the page was empty.

**Viewport.** A fixed 1280×900 viewport drew the page in a corner of the maximized window and
left the rest white. In visible mode the viewport is now `null`, and the page fills the
window. Headless tests keep 1280×900 for stable geometry.

**Custom radio buttons and checkboxes.** A run on hh.ru uncovered two ways to hide a radio
button. On the skill levels page the `input` sat under a decorative `span` from its own
`label`: all 60 radios came out "covered", the overlay collapse fired, and a single button
was left of the page. In a job application form the `input` was hidden entirely, with the
circle drawn in CSS, and the agent dropped it as invisible. Now an element from the control's
own `label` does not count as covering it, and a hidden control with a visible label gets its
ref on the `label`. Playwright rejects a click on such an `input` as intercepted, so the click
is repeated at the same point with `force`, but only when the interceptor sits inside that
control's own `label`.

**Text around the screen.** In a long chat with an employer, new questions at the bottom never
made it into the observation: the text was cut from the top of the page twice. Now
distillation finds the first text visible on screen and builds the window around it. Pinned
headers are skipped, since they cannot tell the position. The scrolling element may be a
container inside the page rather than the window.

**Chrome without warning banners.** Chrome showed yellow bars about unsupported flags:
`--no-sandbox` (Playwright adds it) and `--disable-blink-features`. The sandbox is now on,
`--enable-automation` is removed, and an init script hides `navigator.webdriver`.

**Sonnet 5 as the main model.** An agent step is short: read the observation, pick an
element, call a tool. Sonnet 5 handles this on par with Opus, costs $2/$10 per million tokens
against $5/$25 and answers faster. Opus 5.5 does not fit: it binds thinking blocks to an
unchanged history, while pruning replaces old observations with stubs, and accounts created
after August 31, 2026 get a 400. Opus 5 is available via `AGENT_MODEL`.

**MCP: rejected at first, then added as a second entry point.** The agent's own loop does not
need MCP, since everything lives in one process. The second entry point appeared because a
subscription OAuth token cannot be used in your own application, and not everyone has an API
key. Through MCP the same browser layer and gate run under Claude Code, where the subscription
is allowed.

**Provider as configuration.** At first the model was a constant. For GLM via z.ai, swapping
`baseURL` alone was not enough: Anthropic extensions break the request on a foreign gateway.
Capabilities became flags, and moving to OpenRouter took one branch in `provider.ts`. A live
check of OpenRouter on free models revealed three failures that cut tasks short: a 200
response without `content`, `overloaded_error` inside a stream with no HTTP status, and an
exhausted daily quota on which the loop waited for a minute in vain. The agent now retries
the first two and recognizes the third immediately.

## Limitations

- The agent does not solve captchas. Per the spec, the user handles login, and on a captcha
  the agent calls for a human.
- One REPL, one task at a time, no queue.
- Chrome only.
- Memory is a short list of facts, not a store of past runs.
- A limit of 40 steps per task guards against loops; `AGENT_MAX_STEPS` changes it.
- Ctrl+C does not cut a click short: the agent finishes the action in progress and only then
  stops.
