/*
 * Permisos de comandos por tipo de cuenta.
 *  - usuario: control manual, control automático, seguidor de línea y lecturas.
 *  - admin:   todo lo anterior + calibración (TURNSET, DRIVESET, LINESET...), sondeos,
 *             RTC SET, GPS CONF/BAUD, microSD, radar, motores individuales y terminal libre.
 * El límite de 150 caracteres deja margen para la trama autenticada de 240 bytes
 * (V1|GW01|CAR01|seq|COMANDO|HMAC de 64 hex).
 */
const MAX_COMMAND_LENGTH = 150;

const USER_ALLOWED = [
  /^(FWD|FORWARD|BACK|BACKWARD|STOP|BEEP|HELP)$/,
  /^DRIVE -?\d{1,3} -?\d{1,3} -?\d{1,3} -?\d{1,3}$/,
  /^(FWD|BACK)_SEC \d+(\.\d+)?$/,
  /^TURN (PIVOT|NORMAL) (LEFT|RIGHT) (45|90|180)$/,
  /^(ENV|GPS|IR|RTC|GPS STATUS|AUTO STATUS|LINE FOLLOW STATUS|POLL SHOW|MANUAL SHOW|DRIVE SHOW|TURN SHOW|LINESET SHOW|LORA LINK STATUS|LORA AUTH STATUS|MICROSD STATUS)$/,
  /^AUTO (ON|OFF|RESET)$/,
  /^AUTO TARGET -?\d{1,2}(\.\d+)? -?\d{1,3}(\.\d+)?$/,
  /^LINE FOLLOW (ON|OFF)$/
];

function normalize(command) {
  return String(command || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Devuelve { ok, command, error }
function checkCommand(rawCommand, role) {
  const command = normalize(rawCommand);
  if (!command) return { ok: false, error: 'Comando vacío' };
  // '|' está reservado para la trama; ROUTE BATCH solo lo genera el planificador.
  if (/\|/.test(String(rawCommand)) && role !== 'planner') return { ok: false, error: 'Carácter | no permitido' };
  if (command.length > MAX_COMMAND_LENGTH && role !== 'planner') {
    return { ok: false, error: `Máximo ${MAX_COMMAND_LENGTH} caracteres` };
  }
  if (role === 'admin' || role === 'planner') return { ok: true, command: role === 'planner' ? String(rawCommand).trim() : command };
  if (USER_ALLOWED.some(rx => rx.test(command))) return { ok: true, command };
  return { ok: false, error: 'Comando reservado para Administrador' };
}

module.exports = { checkCommand, MAX_COMMAND_LENGTH };
