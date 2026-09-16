const { COMMANDS } = require('./protocol');

const ROLE_PERMISSIONS = Object.freeze({
  operator: Object.freeze([
    COMMANDS.GET_STATUS,
    COMMANDS.START_VIDEO,
    COMMANDS.STOP_VIDEO,
  ]),
  viewer: Object.freeze([
    COMMANDS.GET_STATUS,
  ]),
});

function canExecuteCommand(role, command) {
  if (command === COMMANDS.LOGOUT) return true;
  return ROLE_PERMISSIONS[role]?.includes(command) === true;
}

module.exports = { canExecuteCommand };
