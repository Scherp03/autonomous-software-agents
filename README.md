# autonomous-software-agents

**Install dependencies** 
```bash
npm install 
```

**Run the main agent**
```bash
npm start
```

**Run baseline agents** — spawns one instance per `TOKEN_N` defined in `.env`
```bash
npm run baseline
```

Requires a `.env` file (see `.env.example`) with `HOST`, `TOKEN`, and `TOKEN_1`, `TOKEN_2`, … for baselines.
