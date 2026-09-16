const fs = require('node:fs/promises');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('./config');
const sessionStore = require('./session-store');

async function readUsers() {
  const contents = await fs.readFile(config.usersFile, 'utf8');
  const users = JSON.parse(contents);
  if (!Array.isArray(users)) throw new Error('users.json must contain an array');
  return users;
}

function credentialsHaveValidShape(body) {
  return body
    && typeof body.login === 'string'
    && body.login.length > 0
    && body.login.length <= 100
    && typeof body.password === 'string'
    && body.password.length > 0
    && body.password.length <= 200;
}

function createAuthRouter({ onSessionActivated = async () => {} } = {}) {
  const router = express.Router();

  router.post('/login', async (request, response, next) => {
    try {
      if (!credentialsHaveValidShape(request.body)) {
        response.status(400).json({ error: 'Login and password are required' });
        return;
      }

      const users = await readUsers();
      const user = users.find(({ login }) => login === request.body.login);
      const passwordMatches = user
        ? await bcrypt.compare(request.body.password, user.passwordHash)
        : false;

      if (!user || !passwordMatches) {
        response.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const session = sessionStore.createSession({
        login: user.login,
        role: user.role,
        lifetimeSeconds: config.jwtExpiresInSeconds,
      });

      let token;
      try {
        token = jwt.sign(
          { role: user.role, jti: session.jti },
          config.jwtSecret,
          {
            algorithm: 'HS256',
            expiresIn: config.jwtExpiresInSeconds,
            subject: user.login,
          },
        );
      } catch (error) {
        sessionStore.revokeSession(session.jti);
        throw error;
      }

      try {
        await onSessionActivated(session);
      } catch {
        console.error('[server-b] Session activation could not be synchronized; login remains available');
      }

      response.json({
        token,
        expiresIn: config.jwtExpiresInSeconds,
        user: { login: user.login, role: user.role },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter, readUsers };
