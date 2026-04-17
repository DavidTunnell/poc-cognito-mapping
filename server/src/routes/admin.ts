import { Router } from 'express';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListGroupsCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { requireAuth, requireAdmin } from '../middleware';
import { getScheme, setScheme, getCustomPermissions, setCustomPermissions, Scheme, CustomPermissions } from '../scheme-store';
import { config, allBuckets } from '../config';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

const idp = new CognitoIdentityProviderClient({ region: config.region });

adminRouter.get('/scheme', async (_req, res) => {
  res.json({ scheme: await getScheme() });
});

adminRouter.put('/scheme', async (req, res) => {
  const { scheme } = req.body ?? {};
  if (scheme !== 'iam' && scheme !== 'custom') {
    return res.status(400).json({ error: 'scheme must be iam or custom' }) as any;
  }
  await setScheme(scheme as Scheme);
  res.json({ scheme });
});

adminRouter.get('/custom-permissions', async (_req, res) => {
  res.json(await getCustomPermissions());
});

adminRouter.put('/custom-permissions', async (req, res) => {
  const body = req.body as CustomPermissions;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'body must be an object keyed by username' }) as any;
  }
  await setCustomPermissions(body);
  res.json(body);
});

adminRouter.get('/users', async (_req, res) => {
  const users = await idp.send(new ListUsersCommand({ UserPoolId: config.userPoolId, Limit: 60 }));
  const out = await Promise.all((users.Users ?? []).map(async u => {
    const username = u.Username ?? '';
    const email = u.Attributes?.find(a => a.Name === 'email')?.Value ?? '';
    const g = await idp.send(new AdminListGroupsForUserCommand({ UserPoolId: config.userPoolId, Username: username }));
    return {
      username,
      email,
      enabled: u.Enabled ?? false,
      status: u.UserStatus ?? '',
      groups: (g.Groups ?? []).map(gr => gr.GroupName ?? '').filter(Boolean),
    };
  }));
  res.json(out);
});

adminRouter.get('/groups', async (_req, res) => {
  const g = await idp.send(new ListGroupsCommand({ UserPoolId: config.userPoolId, Limit: 20 }));
  res.json((g.Groups ?? []).map(gr => ({
    name: gr.GroupName ?? '',
    description: gr.Description ?? '',
    roleArn: gr.RoleArn ?? null,
    precedence: gr.Precedence ?? null,
  })));
});

adminRouter.get('/buckets', (_req, res) => {
  res.json({ buckets: allBuckets() });
});
