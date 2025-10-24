# 🥁 QWERTY DRUMS (Bun)

Run browser-based drum kit on https://ikeadrift.com directly from your terminal.

---

## ⚙️ Setup

```bash
bun install puppeteer-core@21 prompts chalk@4
```

---

## ▶️ Run

`bun run play.ts`                # choose from list  
`bun run play.ts groove`       # play specific file  
`bun run play.ts groove rocksteady --once`  # play sequence once  

#### Flags:  
--once     play one loop only (default: false)
--reseed   randomize per loop (default: false)
