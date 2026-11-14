# UI standards (proposed)

**Status: Proposed (2026-11-15).** Written when the first screen (the chat, E6.5) was built; before that the repository had none beyond the rules in [apps/web/README.md](../../apps/web/README.md). The product owner has not confirmed them. Change them freely; update this file and the code together.

## 1. Stack and dependencies

- Next.js App Router, React 19, TypeScript strict ([ADR-0008](../adr/ADR-0008-technology-selection.md)).
- **No UI library and no CSS framework for now** (CLAUDE.md: avoid unnecessary dependencies). Plain CSS in one stylesheet, built on CSS variables (design tokens) for colour, spacing and type. A component library can be proposed by ADR when there are enough screens to justify it.
- System font stack. No external fonts, scripts or CDNs (privacy and CSP).

## 2. What the UI may and may not do

- **No business logic and no authorization decisions in the frontend.** It renders what the api returns and hides nothing on its own authority.
- **It never computes or formats a number.** Figures arrive rendered (Indian grouping, lakh and crore) from the evidence ledger (D-22). The UI shows them as text.
- It talks only to its own server routes, which call the public api. It never calls ai-engine.
- **Model text is plain text.** Never `dangerouslySetInnerHTML`, never Markdown or HTML rendering of model or user text.

## 3. Showing answers

- Sections are visually distinct and always labelled in the same order: Summary, Verified facts, Calculations, Possible explanations, Recommendations, Unknowns, Sources and freshness ([AI_ENGINEERING.md](../../AI_ENGINEERING.md)). An empty section is not shown.
- **Possible explanations are marked "Hypothesis, not verified".** They never share styling with verified facts.
- Status is explicit and never colour-only: a facts-only answer says "Explanation unavailable, showing results only"; not-authorized says "Not available for your access"; failures give a short fixed message. No raw backend or model error text is shown.
- Each result table is shown from the result set, with its figures as given. Every number can lead to its provenance (evidence id, source, run time) once the evidence view exists; until then the evidence list is available on request.
- Freshness (as of, stale) is always visible when the api provides it.

### Visual language (v2, 2026-11-15)

- **Shell:** a left sidebar (brand, new conversation, this session's questions, workspace, sign out), the conversation in a centred column of at most 860 px, and a composer pinned at the bottom. Under 900 px the sidebar becomes a drawer.
- **Answer card:** a status badge (answered from your data, results only, or a note), the headline, then the visual, then labelled sections, then actions (copy, download CSV). A plain answer with no grouping shows KPI tiles with the change against the other period; a grouped one shows a chart with a Chart / Table switch.
- **Charts:** ranked horizontal bars in one blue (at most 20 px thick, rounded data end, value at the tip) and a 2 px line for dates. Values and labels are the server's display text; raw numbers are used only for bar length and line position. The change arrow shows direction only, never red or green, because whether "up" is good depends on the measure. No chart is drawn for one row, for negative values, or for several dimensions: the table is shown. Colours follow the validated data-viz palette (`#2a78d6` light, `#3987e5` dark).
- **Provenance:** every figure (table cell, bar, KPI, line point) opens a side panel that says in plain language where it comes from (read from your data, with the measure, the row, the period, when the query ran and a short fingerprint; or calculated by the system, with the formula and its inputs).
- **Exports:** CSV of the displayed cells; cells that a spreadsheet could run as formulas are neutralised.

## 4. Accessibility (target: WCAG 2.2 AA)

- Semantic HTML (landmarks, headings in order, real buttons and labels). Everything works by keyboard, with a visible focus ring.
- Colour contrast of at least 4.5:1 for text. Meaning is never carried by colour alone.
- New answers are announced through a polite live region. Respect `prefers-reduced-motion`.
- Works from 360 px wide. Light and dark themes follow `prefers-color-scheme`.

## 5. Security in the browser

- Tokens never reach browser JavaScript, `localStorage` or `sessionStorage` ([ADR-0020](../adr/ADR-0020-web-sign-in-and-session.md)).
- State-changing requests are same-origin only: the server route checks the `Origin` header in addition to `SameSite` cookies.
- Security headers on every response: a strict CSP (no inline script), `X-Content-Type-Options`, `Referrer-Policy`, frame denial.
- Nothing about a question or answer is logged by the web server.

## 6. Copy and language

- English (en-IN). All user-facing strings live in `apps/web/src/lib/strings.ts`, so translation is possible later. Plain business language, no jargon (no "evidence ledger", "plan hash", "RLS").
- Every screen has loading, empty and error states.

## 7. Tests

- Logic that decides what is shown (section order, status labels, which sections appear) is pure code with unit tests. Component tests and end-to-end browser tests need new dependencies and are proposed separately.
