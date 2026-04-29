# First-external-pack outreach playbook

Operational asset for reaching out to candidates who could publish the first non-Mauricio agent-skills pack. **Not public-facing** — for the maintainer (you) to use when scanning networks for fits.

The single biggest move toward "this is a real ecosystem" is a second pack from someone else. Ranked above any technical feature. The cost is relational, not engineering.

---

## Who's a good candidate

Look for someone who:

1. **Owns a small CLI or shell-wrapper tool** they use regularly (or that their team uses).
2. **Has Node ≥22 already installed** (anyone doing modern web dev does).
3. **Cares about discoverability** — wants their tool to be found, not buried.
4. **Has 30 minutes** for a guided publish.

### Tool patterns that map cleanly

| pattern | example | why it fits |
|---|---|---|
| **DevOps wrapper** | `deploy-staging`, custom `kubectl` aliases, log query CLIs | non-interactive, single-command, agent-friendly |
| **Internal API client** | Custom HTTP wrapper for company API with auth handled via env vars | demonstrates the privacy invariant cleanly |
| **Data exploration helper** | SQL query runner with named queries, BigQuery/Athena CLI wrappers | natural to query in NL ("run the daily revenue query") |
| **Notion / Linear / Jira shortcut** | `gh pr-summary` style, but for their tooling | high re-use potential, agents will retrieve often |
| **Codebase analysis** | Custom complexity reporter, dependency graph dumper | one shot per question, perfect agent fit |
| **Documentation generator** | OpenAPI → markdown, changelog builder, ADR scaffolder | matches the "I have a one-shot script" pattern |
| **Local dev scaffolder** | Project bootstrappers, env validators, hook installers | well-scoped, agents can suggest "set up your dev env" |

### Anti-patterns (don't pitch these)

| pattern | why it doesn't fit |
|---|---|
| GUI-only tools | skills are CLI |
| Interactive prompts (`select an option:`) | skills are non-interactive single-shot |
| Tools that pipe secrets through the LLM prompt | violates SPEC §2.6 privacy invariant — make sure they understand env-var pattern instead |
| Binary-output tools | agents need text |
| "AI agents" themselves | too meta — skills are tools agents use, not other agents |
| Tools requiring TTY | won't work via `agent-skills exec` |

---

## What you offer the candidate

### Concretely
- **30 min of pairing** to scaffold + publish their pack live.
- **A walk-through of [`PUBLISHING.md`](./PUBLISHING.md)** end-to-end on their tool.
- **A reviewable PR** to whatever repo they want their pack in (or you create the repo).
- **Their pack on the public discovery list** (which itself will be one outcome of this outreach — currently the agent-skills-pack repo is the only public reference).

### Time to "shipped"
- **Live publish in one session** is the realistic target.
- Their tool is already a CLI; pack-ifying is mostly metadata + a SKILL.md per command.
- For a single skill: ~20 min including review.

### What you DON'T offer
- A maintained skill on their behalf — *they* own the pack, *they* update when their tool changes.
- Custom feature work in `agent-skills-cli` to fit their tool unless it's a real spec gap.

---

## Why this matters to *them*

This is the part outreach often skips. Concrete reasons it's worth their 30 min:

1. **Discoverability via natural language.** Their tool is currently found by reading docs. After publishing, any agent can find it from "summarize a PR" / "deploy to staging" / etc. The retrieval is the point.

2. **Recognition.** They're the second public publisher in a new ecosystem. If agent-skills grows, "early publishers" matters socially in a way "11th publisher" doesn't.

3. **Pressure to polish.** Pack-ifying their tool forces them to write a clean description, declare args, document examples. They were going to do that anyway; this gives them the deadline.

4. **Their team gets it for free.** Once published, every teammate with an agent in their workflow can invoke the tool. No "did you read the runbook?" handoff.

5. **Public provenance.** If they sign tags (GPG / SSH / Sigstore), the bank's verification surfaces that — their pack carries trust signals into anyone's bank.

---

## Templated first message

Subject: `[short, specific to them]`, e.g.:
- `tu deploy-staging cli + agent-skills`
- `tu wrapper de [company API] como agent skill?`
- `pack de agent-skills para [tool]?`

Body (adapt freely):

```
Hola [nombre],

Te escribo por [tool específico que sabés que ellos mantienen]. Estoy 
empujando un proyecto que se llama agent-skills — una alternativa 
descentralizada a MCP donde el agente busca herramientas por embedding 
y ejecuta el comando como subprocess (no JSON-RPC server, no daemon, 
solo un CLI con metadata).

[Tool] me parece un encaje natural: [una razón específica, p.ej. "es 
single-command, no necesita estado, y los devs de tu equipo seguro 
quieren invocarlo desde Claude Code/Cursor sin acordarse de los flags"].

Te ofrezco 30 minutos de pairing para envolverlo como un agent-skills 
pack y publicarlo en un repo tuyo. Vos te quedás como dueño y mantenedor;
yo te ayudo a meter la metadata y a probar el round-trip de descubrimiento.

Beneficio para vos: tu tool se vuelve buscable por NL desde cualquier 
agente que use el spec. Y serías el segundo publisher externo, que en 
un ecosistema nuevo es una posición que se nota.

Si te interesa: [agendá X] / [te escribo en Y] / [tirame una hora].

Material de referencia, sin compromiso:
- spec: github.com/MauricioPerera/agent-skills
- CLI: npm install -g @rckflr/agent-skills-cli
- tutorial concreto: PUBLISHING.md en el repo del CLI

Saludos,
[firma]
```

### Tono notes
- **No vendas el ecosistema.** Vendé el encaje específico para su tool.
- **30 minutos es el commitment.** No "te ayudo cuando puedas" — agendá.
- **No prometas mantenimiento.** Vos te ofrecés a publicar; ellos mantienen.
- **Escapá del modo demo.** Si te dicen "interesante, mostrame", mandales el CLI + PUBLISHING.md y que prueben primero. Si pasan eso, agendá.

---

## Tracking

Lleva una lista corta. ~5 candidatos a la vez, no más:

| candidato | tool | estado | última acción | próximo paso |
|---|---|---|---|---|
| _ejemplo_ | deploy-staging | declined | 2026-04-15 | revisitar Q3 |
| _ejemplo_ | bq-query | scheduled | 2026-04-22 | pairing 04-29 16:00 |

3-4 declines son señal de que el pitch necesita ajuste, no de que la idea esté mal. Iterá el "porqué" del mensaje, no la idea.

---

## Anti-objetivos para esta etapa

No pongas en la lista:
- Empresas grandes (procesos lentos, no es donde empezás un ecosistema)
- Mantenedores con backlog conocido > 6 meses (no van a tener 30 min)
- Tools que requieren cambio del spec para funcionar (eso es feature work, no outreach)
- Conocidos que claramente no usan agentes (no van a sentir el valor)

Buscá: **dev individual o equipo chico, herramienta que ya usan, que ya pensaron "debería estar más disponible".**

---

## Success criteria

Para considerar D1 cerrado:

- **1 pack externo público y funcional** (no un fork, no un mirror, sino un pack creado por alguien fuera de tu cuenta de GitHub)
- **Su autor lo mencionó en algún lado público** (post, README, mensaje en grupo)
- **Es subscribable**: `agent-skills sync github.com/<them>/<their-pack>@<tag>` funciona end-to-end

Cuando esos tres se cumplen, el carácter del proyecto cambió. Es lo único que mide bien D1.
