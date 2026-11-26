/* Pruebas sin hardware ni base de datos: npm test */
const assert = require('assert');
const L = require('../public/js/roverlib');
const RoutePlanner = require('../src/planner');
const { checkCommand } = require('../src/policy');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

console.log('Parser de mensajes del firmware');
test('ENV con unidad hPa', () => {
  const p = L.parseRoverMessage('ENV,T=24.1,H=55.0,P=1012.8hPa');
  assert.deepStrictEqual([p.sensor, p.category, p.data.T, p.data.H, p.data.P], ['ENV', 'telemetria', 24.1, 55, 1012.8]);
});
test('ENV con NaN (sensor ausente)', () => {
  assert.strictEqual(L.parseRoverMessage('ENV,T=25.0,H=nan,P=nanhPa').data.H, null);
});
test('GPS con posición', () => {
  const p = L.parseRoverMessage('GPS,LAT=19.243300,LON=-103.725000,AGE_MS=120');
  assert.deepStrictEqual(p.location, { lat: 19.2433, lon: -103.725 });
  assert.strictEqual(p.data.fix, true);
});
test('GPS sin fix', () => assert.strictEqual(L.parseRoverMessage('GPS,NO_FIX').data.fix, false));
test('REQUEST,ROUTE con destino', () => {
  const p = L.parseRoverMessage('REQUEST,ROUTE,ID=7,LAT=19.1,LON=-103.2,AGE_MS=30,TARGET_LAT=19.2,TARGET_LON=-103.3');
  assert.strictEqual(p.data.ID, 7); assert.strictEqual(p.data.TARGET_LON, -103.3); assert.ok(p.location);
});
test('RADAR,SCAN con pares ángulo:distancia', () => {
  const p = L.parseRoverMessage('RADAR,SCAN,SCAN_ID=3,PART=1/3,MAX_CM=200,0:45,10:-1,20:180');
  assert.strictEqual(p.data.points.length, 3); assert.strictEqual(p.data.PART, '1/3');
});
test('RTC con fecha', () => assert.strictEqual(L.parseRoverMessage('RTC,2026-10-29 11:22:33').data.stamp, '2026-10-29 11:22:33'));
test('EVENT', () => assert.strictEqual(L.parseRoverMessage('EVENT,BATCH_INTERRUPTED,ID=4,STEP=1/2,REASON=OBSTACLE').data.event, 'BATCH_INTERRUPTED'));

console.log('Mensajes del gateway (tópico rx)');
test('JSON del gateway con "payload" (formato real GW01)', () => {
  const r = L.splitGatewayPayload('{"device":"CAR01","seq":4460,"rssi":-83,"snr":3.0,"ms":16221843,"payload":"GPS,LAT=19.319316,LON=-103.767907,AGE_MS=47"}');
  assert.deepStrictEqual(r.lines, ['GPS,LAT=19.319316,LON=-103.767907,AGE_MS=47']);
  assert.deepStrictEqual(r.radio, { rssi: -83, snr: 3, seq: 4460 });
  assert.deepStrictEqual(L.parseRoverMessage(r.lines[0]).location, { lat: 19.319316, lon: -103.767907 });
});
test('JSON con "msg" (formato anterior) sigue funcionando', () => {
  assert.deepStrictEqual(L.splitGatewayPayload('{"msg":"ENV,T=24.1","rssi":-87,"snr":7.5}').lines, ['ENV,T=24.1']);
});
test('Texto plano con varias líneas', () => {
  const r = L.splitGatewayPayload('RTC,2026-11-24 10:15:00\r\nIR,LEFT=1,CENTER=0,RIGHT=1\n');
  assert.deepStrictEqual([r.lines.length, r.radio], [2, null]);
});

console.log('Archivo de la microSD');
test('CSV con reinicio y anclaje RTC', () => {
  const csv = [
    'millis,sensor,value',
    '1000,RTC,"2026-10-29 10:00:00"',
    '3000,ENV,"T_C=25.0;H_PCT=50.0;P_HPA=940.2"',
    '4000,GPS,"LAT=19.243300;LON=-103.725000;AGE_MS=100"',
    '5000,RADAR_090,"DIST_CM=34"',
    '500,GPS,"NO_FIX"',
    '800,LINE_FOLLOW,"L=1;C=0;R=1;STATE=STRAIGHT"'
  ].join('\n');
  const r = L.parseMicroSdCsv(csv);
  assert.strictEqual(r.rows.length, 6);
  assert.strictEqual(r.segments, 2);
  assert.strictEqual(r.rows[1].data.P_HPA, 940.2);
  assert.strictEqual(r.rows[2].time - r.rows[0].time, 3000);
  assert.strictEqual(r.rows[3].data.angle, 90);
  assert.strictEqual(r.rows[4].time, null);           // segmento sin RTC
  assert.deepStrictEqual(r.rows[2].location, { lat: 19.2433, lon: -103.725 });
});

console.log('Permisos de comandos');
test('Usuario puede mover', () => assert.ok(checkCommand('drive -60 60 -60 60', 'usuario').ok));
test('Usuario puede fijar destino', () => assert.ok(checkCommand('AUTO TARGET 19.243300 -103.725000', 'usuario').ok));
test('Usuario no puede calibrar', () => assert.ok(!checkCommand('TURNSET P_R90 60 400 -60 400 60 400 -60 400', 'usuario').ok));
test('Nadie inyecta | (trama)', () => assert.ok(!checkCommand('STOP|X', 'admin').ok));
test('Límite de 150 caracteres', () => assert.ok(!checkCommand('A'.repeat(151), 'admin').ok));

console.log('Planificador de rutas (rover simulado, rumbo inicial desconocido)');
const R = 6371008.8;
function simulate(seedHeading, targetDistM, targetBearing) {
  const rover = { lat: 19.2433, lon: -103.725, heading: seedHeading };
  const move = m => {
    const h = rover.heading * Math.PI / 180;
    rover.lat += (m * Math.cos(h)) / R * 180 / Math.PI;
    rover.lon += (m * Math.sin(h)) / (R * Math.cos(rover.lat * Math.PI / 180)) * 180 / Math.PI;
  };
  const tb = targetBearing * Math.PI / 180;
  const target = {
    lat: rover.lat + targetDistM * Math.cos(tb) / R * 180 / Math.PI,
    lon: rover.lon + targetDistM * Math.sin(tb) / (R * Math.cos(rover.lat * Math.PI / 180)) * 180 / Math.PI
  };
  const sent = [];
  let arrived = false, finalDone = false;
  const planner = new RoutePlanner({ enabled: true, maxLegM: 5, arriveRadiusM: 3, headingMinM: 1.5 }, c => sent.push(c));
  for (let id = 1; id <= 40 && !arrived && !finalDone; id++) {
    planner.onMessage(L.parseRoverMessage(`REQUEST,ROUTE,ID=${id},LAT=${rover.lat.toFixed(6)},LON=${rover.lon.toFixed(6)},AGE_MS=100,TARGET_LAT=${target.lat.toFixed(6)},TARGET_LON=${target.lon.toFixed(6)}`));
    planner.onMessage(L.parseRoverMessage(`ROUTE_CONFIG,ID=${id},FWD_MS_M=3000,REV_MS_M=3000,FWD_PWM=60/60/60/60,REV_PWM=-60/-60/-60/-60`));
    const cmd = sent.at(-1);
    if (cmd === 'AUTO OFF') { arrived = true; break; }
    assert.ok(cmd.length <= 150, 'el lote debe caber en una trama LoRa');
    const [head, ...steps] = cmd.split('|');
    const h = head.match(/^ROUTE BATCH (\d+) (FINAL|MORE) (\d+)$/);
    assert.ok(h && +h[1] === id && +h[3] === steps.length, `cabecera válida: ${head}`);
    for (const s of steps) {
      assert.ok(/^(TURN:PIVOT:(LEFT|RIGHT):(45|90|180)|FWD:\d+\.\d{2})$/.test(s), `paso válido: ${s}`);
      const f = s.split(':');
      if (f[0] === 'TURN') rover.heading = (rover.heading + (f[2] === 'RIGHT' ? 1 : -1) * Number(f[3]) + 360) % 360;
      else { assert.ok(+f[1] <= 10 && +f[1] * 3000 <= 30000); move(Number(f[1])); }
    }
    if (h[2] === 'FINAL') finalDone = true;
  }
  return L.distanceM(rover.lat, rover.lon, target.lat, target.lon);
}
for (const [hd, dist, brg] of [[0, 25, 135], [200, 18, 10], [90, 40, 270], [315, 12, 300]]) {
  test(`rumbo inicial ${hd}°, destino a ${dist} m / ${brg}° → error final < 6 m`, () => {
    const err = simulate(hd, dist, brg);
    assert.ok(err < 6, `error final ${err.toFixed(2)} m`);
  });
}

console.log(`\n${passed} pruebas correctas`);
