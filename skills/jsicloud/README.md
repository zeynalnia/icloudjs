# jsicloud Agent Skill

A self-contained Anthropic Agent Skill that teaches an AI coding agent how to
build with [`jsicloud`](https://www.npmjs.com/package/jsicloud) — the unofficial
NestJS/TypeScript client for Apple iCloud web services (a port of Python
`pyicloud`) — **without reading the library source, examples, or README**.

## Contents

```
jsicloud/
├── SKILL.md                       # entry point: install, usage modes, auth/2FA flow, recipes, gotchas, cheat-sheet
├── README.md                      # this file
└── references/
    ├── api-reference.md           # exhaustive, verified API: every class/method/field/type
    └── recipes.md                 # copy-pasteable per-service recipes (all compile)
```

`SKILL.md` is loaded first; it links to the two `references/` files so the agent
can pull in the exhaustive API table or detailed recipes on demand
(progressive disclosure).

## Installing the skill into a consuming project

Copy the whole `jsicloud/` directory into the target project's
`.claude/skills/` folder:

```bash
# from the consuming project root
mkdir -p .claude/skills
cp -R /path/to/jsicloud/skills/jsicloud .claude/skills/jsicloud
```

Resulting layout:

```
<your-project>/.claude/skills/jsicloud/
├── SKILL.md
├── README.md
└── references/
    ├── api-reference.md
    └── recipes.md
```

The agent will auto-discover the skill and invoke it when you ask to build with
jsicloud / the iCloud NestJS client / the pyicloud port.

## Using the library it documents

In the same consuming project:

```bash
npm i jsicloud
```

Note: `jsicloud` depends on the native `keytar` module (OS keychain). The
keychain holds the account `password` (when omitted) and the at-rest
session-encryption key (encryption is on by default). On headless Linux install
`libsecret` build deps, or — for cron/headless — pass `password` explicitly and
set `encryptionKeyFile` (a base64 key file) so the keychain is never read. See
`SKILL.md` → Install for details.
