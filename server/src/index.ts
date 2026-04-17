import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { authRouter } from './routes/auth';
import { bucketsRouter } from './routes/buckets';
import { adminRouter } from './routes/admin';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/api', bucketsRouter);
app.use('/api/admin', adminRouter);

// Serve the built web app
const webDist = path.resolve(config.webDistDir);
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|auth|healthz).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  console.warn(`Web dist not found at ${webDist} — running API-only`);
}

app.listen(config.port, () => {
  console.log(`poc-csd server listening on :${config.port}`);
});
