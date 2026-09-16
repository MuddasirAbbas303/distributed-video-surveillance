const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcrypt');

const usersFile = path.resolve(__dirname, '..', 'server-b', 'users.json');
const developmentUsers = [
  { login: 'admin', password: 'admin123', role: 'operator' },
  { login: 'operator', password: 'operator123', role: 'operator' },
  { login: 'viewer', password: 'viewer123', role: 'viewer' },
];

function validateDefinitions(users) {
  const logins = new Set();
  for (const user of users) {
    if (!user.login || !user.password || !['operator', 'viewer'].includes(user.role)) {
      throw new Error('Development user definitions are invalid');
    }
    if (logins.has(user.login)) throw new Error(`Duplicate login: ${user.login}`);
    logins.add(user.login);
  }
}

async function main() {
  validateDefinitions(developmentUsers);

  const users = await Promise.all(developmentUsers.map(async ({ login, password, role }) => ({
    login,
    passwordHash: await bcrypt.hash(password, 10),
    role,
  })));

  await fs.writeFile(usersFile, `${JSON.stringify(users, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  console.log(`Created ${users.length} development users: ${users.map(({ login }) => login).join(', ')}`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`Could not create users: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { developmentUsers, validateDefinitions };
