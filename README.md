## 🥁 QWERTY DRUMS (Bun)

Run browser-based drum kit on https://ikeadrift.com directly from your terminal.

---

#### (0) Setup

```bash
bun install puppeteer-core@21 prompts chalk@4
```

---

#### (1) Run

```
bun run play.ts           # choose from list
```
```
bun run play.ts groove    # play specific file
```
```
bun run play.ts groove rocksteady --once    # play sequence once  
```

#### Flags:  
> `--once`     play one loop only (default: false)</br>
> `--reseed`   randomize per loop (default: false)
