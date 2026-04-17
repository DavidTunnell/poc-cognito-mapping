import { Router } from 'express';
import { login, respondToNewPassword } from '../auth';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' });
    return;
  }
  try {
    const result = await login(email, password);
    res.json(result);
  } catch (e: any) {
    res.status(401).json({ error: e.name ?? 'LoginFailed', message: e.message });
  }
});

authRouter.post('/new-password', async (req, res) => {
  const { email, newPassword, session } = req.body ?? {};
  if (!email || !newPassword || !session) {
    res.status(400).json({ error: 'email, newPassword, session required' });
    return;
  }
  try {
    const result = await respondToNewPassword(email, newPassword, session);
    res.json(result);
  } catch (e: any) {
    res.status(401).json({ error: e.name ?? 'ChallengeFailed', message: e.message });
  }
});

authRouter.post('/logout', (_req, res) => {
  res.json({ ok: true });
});
