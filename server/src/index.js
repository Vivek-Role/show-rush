import 'dotenv/config';
import express from 'express';

// Phase 0 is deliberately a single file. routes/, services/ and db/ are
// Phase 1.1's deliverable — see PLAN.md and docs/phases/phase-0-setup.md (D2).

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get('/', (req, res) => {
  res.json({ service: 'show-rush', status: 'ok' });
});

app.listen(port, () => {
  console.log(`show-rush listening on port ${port}`);
});
