/*
 * Planificador de rutas para el modo AUTO del firmware.
 *
 * Flujo del firmware (serviceAuto / requestAutoRoute):
 *   rover -> REQUEST,ROUTE,ID=n,LAT,LON,AGE_MS[,TARGET_LAT,TARGET_LON]
 *   rover -> ROUTE_CONFIG,ID=n,FWD_MS_M=..,REV_MS_M=..,FWD_PWM=..,REV_PWM=..
 *   nube  -> ROUTE BATCH n FINAL|MORE k|PASO1|PASO2...
 * El rover vuelve a pedir ruta cada 5 s con un ID nuevo; un lote con ID viejo se rechaza.
 *
 * El rover NO tiene brújula: el rumbo se estima con dos posiciones GPS consecutivas
 * separadas por un tramo recto (y, si no hay desplazamiento suficiente, por estima:
 * rumbo anterior + giro ordenado). Los giros se cuantizan a los perfiles del
 * firmware (45, 90, 180 grados, tipo PIVOT).
 */
const { distanceM, bearingDeg, normalize180 } = require('../public/js/roverlib');

const FIRMWARE_MAX_DISTANCE_M = 10;   // normalizeBatchStep: amount > 10 -> error
const FIRMWARE_MAX_MOTOR_MS = 30000;  // MAX_MOTOR_TEST_MS
const CONFIG_WAIT_MS = 1500;          // espera de ROUTE_CONFIG tras REQUEST,ROUTE

class RoutePlanner {
  constructor(options, sendCommand, publishStatus) {
    this.opt = options;
    this.send = sendCommand;
    this.publish = publishStatus || (() => {});
    this.msPerMeter = 0;
    this.reset('init');
  }

  reset(reason) {
    this.heading = null;       // grados, 0 = norte
    this.lastPos = null;
    this.lastLegM = 0;
    this.gpsHeadingValid = true;
    this.target = null;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = { state: 'IDLE', message: reason === 'init' ? 'En espera' : `Reiniciado (${reason})` };
    if (reason !== 'init') this.emit();
  }

  emit(extra) {
    if (extra) Object.assign(this.status, extra);
    this.status.heading = this.heading === null ? null : Math.round(this.heading);
    this.status.target = this.target;
    this.status.updatedAt = new Date().toISOString();
    this.publish(this.status);
  }

  onMessage(p) {
    if (!this.opt.enabled) return;
    const tags = (p.data && p.data.tags) || [];
    switch (p.sensor) {
      case 'OK':
        if (tags.includes('AUTO_ON')) this.reset('AUTO ON');
        if (tags.includes('AUTO_OFF')) this.emit({ state: 'IDLE', message: 'AUTO apagado' });
        break;
      case 'REQUEST':
        if (tags.includes('ROUTE')) this.onRequest(p);
        break;
      case 'ROUTE_CONFIG':
        if (typeof p.data.FWD_MS_M === 'number') this.msPerMeter = p.data.FWD_MS_M;
        if (this.pending && p.data.ID === this.pending.id) this.plan();
        break;
      case 'EVENT': {
        const ev = p.data.event;
        if (ev === 'ARRIVED') this.emit({ state: 'ARRIVED', message: 'El rover reportó llegada (lote FINAL completado)' });
        if (ev === 'AUTO_BLOCKED') this.emit({ state: 'BLOCKED', message: `Bloqueado: ${tags.slice(1).join(',')}. Usa AUTO RESET` });
        if (ev === 'BATCH_INTERRUPTED' || ev === 'OBSTACLE_CIRCUMVENTED' || ev === 'OBSTACLE_BLOCKED') {
          // El desvío mueve al rover lateralmente: no usar ese desplazamiento para el rumbo.
          this.gpsHeadingValid = false;
          this.emit({ state: 'AVOIDING', message: `Evento de obstáculo: ${ev}` });
        }
        if (ev === 'BATCH_ABORTED') this.emit({ state: 'ERROR', message: 'El rover rechazó un paso del lote (revisa perfiles TURNSET/DRIVESET)' });
        break;
      }
      case 'ERROR':
        if (tags.some(t => t.startsWith('BATCH') || t.startsWith('ROUTE'))) {
          this.emit({ state: 'ERROR', message: `Rover: ${p.raw}` });
        }
        break;
      default: break;
    }
  }

  onRequest(p) {
    const d = p.data;
    if (typeof d.ID !== 'number' || !p.location) return;
    const target = (typeof d.TARGET_LAT === 'number' && typeof d.TARGET_LON === 'number')
      ? { lat: d.TARGET_LAT, lon: d.TARGET_LON } : null;
    this.pending = { id: d.ID, lat: p.location.lat, lon: p.location.lon, target };
    if (this.timer) clearTimeout(this.timer);
    // Si ROUTE_CONFIG se pierde por radio, planear con la última calibración conocida.
    this.timer = setTimeout(() => this.plan(), CONFIG_WAIT_MS);
  }

  plan() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const req = this.pending;
    this.pending = null;
    if (!req) return;

    if (!req.target) {
      this.emit({ state: 'NO_TARGET', message: 'Sin destino. Selecciona un punto en el mapa (AUTO TARGET).' });
      return;
    }
    if (!this.msPerMeter) {
      this.emit({ state: 'ERROR', message: 'El perfil AUTO de avance no está calibrado (DRIVESET FWD ...). Se envió AUTO OFF.' });
      this.send('AUTO OFF');
      return;
    }
    if (!this.target || this.target.lat !== req.target.lat || this.target.lon !== req.target.lon) {
      this.target = req.target;     // destino nuevo: el rumbo estimado se conserva
      this.lastPos = null;
    }

    // 1) Actualizar el rumbo con el desplazamiento GPS del último tramo recto.
    if (this.lastPos && this.lastLegM > 0 && this.gpsHeadingValid) {
      const moved = distanceM(this.lastPos.lat, this.lastPos.lon, req.lat, req.lon);
      if (moved >= this.opt.headingMinM) this.heading = bearingDeg(this.lastPos.lat, this.lastPos.lon, req.lat, req.lon);
    }
    this.gpsHeadingValid = true;

    const dist = distanceM(req.lat, req.lon, this.target.lat, this.target.lon);
    const toTarget = bearingDeg(req.lat, req.lon, this.target.lat, this.target.lon);

    // 2) ¿Llegó? (dentro del radio configurado, por el error propio del GPS)
    if (dist <= this.opt.arriveRadiusM) {
      this.send('AUTO OFF');
      this.emit({ state: 'ARRIVED', distanceM: round(dist), message: `Destino alcanzado (≤ ${this.opt.arriveRadiusM} m). Se envió AUTO OFF.` });
      this.lastPos = null;
      return;
    }

    const maxLeg = Math.max(0.3, Math.min(this.opt.maxLegM, FIRMWARE_MAX_DISTANCE_M,
      0.95 * FIRMWARE_MAX_MOTOR_MS / this.msPerMeter));
    const steps = [];
    let turnSigned = 0;
    let leg;
    let final;
    const measuring = this.heading === null;

    if (measuring) {
      // 3a) Rumbo desconocido: tramo recto corto para medirlo con el GPS.
      leg = Math.min(maxLeg, Math.max(this.opt.headingMinM * 2, 2));
      final = false;
      steps.push(`FWD:${leg.toFixed(2)}`);
    } else {
      // 3b) Girar hacia el destino (cuantizado) y avanzar.
      const delta = normalize180(toTarget - this.heading);
      const abs = Math.abs(delta);
      const turn = abs < 22.5 ? 0 : abs < 67.5 ? 45 : abs < 135 ? 90 : 180;
      if (turn) {
        const side = turn === 180 ? 'RIGHT' : (delta > 0 ? 'RIGHT' : 'LEFT');
        steps.push(`TURN:PIVOT:${side}:${turn}`);
        turnSigned = side === 'RIGHT' ? turn : -turn;
      }
      leg = Math.max(0.2, Math.min(dist, maxLeg));
      final = dist <= maxLeg;
      steps.push(`FWD:${leg.toFixed(2)}`);
    }

    const command = `ROUTE BATCH ${req.id} ${final ? 'FINAL' : 'MORE'} ${steps.length}|${steps.join('|')}`;
    this.send(command);

    // 4) Estima del nuevo rumbo; se corregirá con el GPS en la siguiente petición.
    if (this.heading !== null) this.heading = (this.heading + turnSigned + 360) % 360;
    this.lastPos = { lat: req.lat, lon: req.lon };
    this.lastLegM = leg;
    this.emit({
      state: final ? 'FINAL_LEG' : 'DRIVING', requestId: req.id, distanceM: round(dist),
      bearingToTarget: Math.round(toTarget), lastBatch: command,
      position: { lat: req.lat, lon: req.lon },
      message: measuring ? 'Rumbo desconocido: tramo recto para estimarlo con GPS'
                         : `Lote enviado (${steps.join(' → ')})`
    });
  }
}

const round = x => Math.round(x * 10) / 10;

module.exports = RoutePlanner;
