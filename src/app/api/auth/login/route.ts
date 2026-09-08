import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { checkPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, serverError, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';

async function login(request: Request) {
  const schema = z.object({
    username: z.string(),
    password: z.string(),
  });

  const { body, error } = await parseRequest(request, schema, { skipAuth: true });

  if (error) {
    return error();
  }

  const { username, password } = body;

  const user = await getUserByUsername(username, { includePassword: true });

  if (!user || !checkPassword(password, user.password)) {
    return unauthorized({ code: 'incorrect-username-password' });
  }

  const { id, role, createdAt } = user;
  const cloudMode = !!process.env.CLOUD_MODE;

  // Check if 2FA is enabled for this user
  const twoFactor = !cloudMode
    ? await prisma.client.twoFactorAuth.findUnique({ where: { userId: id } })
    : null;

  if (twoFactor?.isEnabled) {
    if (!isTwoFactorConfigured()) {
      return serviceUnavailable(getTwoFactorConfigurationError());
    }

    const partialToken = createSecureToken({ userId: id, type: 'partial-auth' }, secret(), {
      expiresIn: '5m',
    });
    return json({ requiresTwoFactor: true, partialToken });
  }
  // Bind token to password hash so a password change invalidates old tokens.
  const pwd = hash(user.password);

  let token: string;

  if (redis.enabled) {
    token = await saveAuth({ userId: id, role, pwd });
  } else {
    token = createSecureToken({ userId: user.id, role, pwd }, secret());
  }

  const teams = await getAllUserTeams(id);

  return json({
    token,
    user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
  });
}

export async function POST(request: Request) {
  try {
    return await login(request);
  } catch (e: any) {
    // A database outage must not surface as an empty 500 body: the client calls
    // res.json() on it and reports "Unexpected end of JSON input" instead of the cause.
    if (isDatabaseUnavailable(e)) {
      return serviceUnavailable({ code: 'database-unavailable' });
    }

    return serverError(e);
  }
}

const DB_UNAVAILABLE_CODES = [
  'P1000', // authentication failed
  'P1001', // cannot reach database server
  'P1002', // database server timed out
  'P1003', // database does not exist
  'P1008', // operation timed out
  'P1017', // server has closed the connection
  'P2021', // table does not exist (migrations not applied)
  'P2022', // column does not exist (migrations not applied)
];

function isDatabaseUnavailable(e: any) {
  return DB_UNAVAILABLE_CODES.includes(e?.code) || e?.name === 'PrismaClientInitializationError';
}
